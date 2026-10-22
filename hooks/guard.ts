// Usage guard: two stages per limit window (wrap-up, stop), each sent once per window, session
// and loop (main or one agent) as a user-role note the model reads on its next request. The main
// chat gets its notes (and its draft handoff) once it has started a turn, so a session opened and
// closed unused leaves no file. What was sent and the task's handoff are kept in $.state; a /clear
// or a resume forgets the task's handoff and the draft, which belong to the conversation before.
import type { EngineInterface } from 'claude-code'

import type { ToolkitGuard } from '../types'
import { DEFAULTS } from './config'
import type { Config, Stage } from './config'
import { createHandoff, handoffDir, newestHandoff } from './handoff'
import type { Usage } from './handoff'

export type Window = { kind: string; percentUsed: number; resetsAt?: string }

const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }
const pad = (n: number) => String(n).padStart(2, '0')

let config: Config = DEFAULTS
let windows: Window[] = []
let account: string | undefined
const warned = new Set<string>()
let handoff: Promise<string | undefined> | undefined
// The task's own handoff file, named by Claude (ContextBudget `handoff`): it wins over the draft.
let taskHandoff: string | undefined
let mainTurn = false // the main chat started a turn (since the last load)
const STATE = { plugin: 'toolkit', key: 'guard' } as const

export const setConfig = (c: Config) => (config = c)
export const setUsage = (w: Window[], name: string | undefined) => ((windows = w), (account = name))
export const taskHandoffPath = () => taskHandoff
export const mainTurnStarted = () => (mainTurn = true)

async function save($: EngineInterface) {
  const sessionId = await $.session.id().catch(() => undefined)
  const value: ToolkitGuard = { ...(sessionId ? { sessionId } : {}), warned: [...warned], ...(taskHandoff ? { taskHandoff } : {}) }
  await $.state.set(STATE, value).catch(() => {})
}

export async function setTaskHandoff($: EngineInterface, path: string) {
  taskHandoff = path
  await save($)
}

// After a hot reload: the notes already sent and, if it is this session's, the task's handoff.
export async function restoreGuard($: EngineInterface) {
  const { value } = await $.state.get(STATE).catch(() => ({ value: undefined }))
  if (!value) return
  for (const key of value.warned) warned.add(key) // keyed by session: another session's never match
  if (!value.sessionId || value.sessionId === (await $.session.id())) taskHandoff ??= value.taskHandoff
}

// A /clear or a resume: another conversation, whose notes start with its first turn.
export function resetGuard() {
  taskHandoff = undefined
  handoff = undefined
  mainTurn = false
}

function resets(iso: string | undefined) {
  if (!iso) return ''
  const t = new Date(iso)
  return isNaN(t.getTime()) ? '' : `resets ${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

const usageLines = (): Usage[] =>
  windows
    .filter(w => LABELS[w.kind])
    .map(w => {
      const r = resets(w.resetsAt)
      return { label: LABELS[w.kind], percent: Math.round(w.percentUsed), resets: r ? ` (${r})` : '' }
    })

// This session's handoff: the task's own file when Claude named one, else the draft it already has
// (from before a reload or restart), else a new draft created on first use.
function ensureHandoff($: EngineInterface) {
  return taskHandoff ? Promise.resolve(taskHandoff) : (handoff ??= makeHandoff($))
}

async function makeHandoff($: EngineInterface) {
  if (!config.handoffFile) return undefined
  try {
    const { dir, project } = await handoffDir($, config.handoffFolder, config.outsideProjectFolder)
    const sessionId = await $.session.id()
    return (await newestHandoff($, dir, sessionId)) ?? (await createHandoff($, dir, { account, sessionId, project, usage: usageLines() }))
  } catch {
    return undefined
  }
}

function note(stage: Stage, w: Window, isAgent: boolean, path: string | undefined) {
  const limit = config.thresholds[w.kind as keyof Config['thresholds']][stage]
  const r = resets(w.resetsAt)
  const head = `Usage guard: ${LABELS[w.kind]} limit at ${Math.round(w.percentUsed)}% (${stage === 'stop' ? 'stop' : 'wrap-up'} at ${limit}%${r ? `, ${r}` : ''}).`
  const file = path ? `the handoff file ${path}` : 'a handoff note'
  // A plugin draft: Claude either fills it in (and marks it open) or uses the task's own file.
  const draft =
    path && path !== taskHandoff
      ? ` If the task already has its own handoff file, update that one instead, name it to ContextBudget (handoff) and delete ${path}; otherwise fill it in and set its Status to open.`
      : ''
  const body = isAgent
    ? stage === 'wrapUp'
      ? 'Finish your current step and update your notes file, then carry on, but start no large new work.'
      : 'Stop: start no new work. Leave the repo buildable, write your final notes, then end with a short summary.'
    : stage === 'wrapUp'
      ? `Finish the current step, then fill in ${file} now.${draft} Tell running agents to update their notes files. Then carry on, but start no large new work.`
      : `Start no new work. Tell running agents to stop, leave the repo buildable and write final notes. Fold their notes into ${file}.${draft} Then tell the user in one line that the handoff is ready.`
  return [head, body, config.extraNote].filter(Boolean).join(' ')
}

async function send($: EngineInterface, text: string, agentId?: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId })
  } catch {} // an agent that just ended takes no row
}

// Sends what this loop is due: per window, the highest stage reached and not yet sent.
export async function check($: EngineInterface, agentId?: string) {
  if (!config.guard || (agentId ? !config.agentNotes : !mainTurn)) return
  const session = await $.session.id()
  for (const w of windows) {
    const t = config.thresholds[w.kind as keyof Config['thresholds']]
    if (!t) continue
    const stage: Stage | undefined = w.percentUsed >= t.stop ? 'stop' : w.percentUsed >= t.wrapUp ? 'wrapUp' : undefined
    if (!stage) continue
    const key = (s: Stage) => `${session}|${agentId ?? 'main'}|${w.kind}|${w.resetsAt?.slice(0, 16)}|${s}`
    if (warned.has(key(stage))) continue
    warned.add(key('wrapUp')) // a stop note covers wrap-up too
    warned.add(key(stage))
    await save($)
    const path = agentId ? undefined : await ensureHandoff($)
    await send($, note(stage, w, Boolean(agentId), path), agentId)
  }
}

// Main and every agent still running.
export async function checkAll($: EngineInterface) {
  await check($)
  if (!config.agentNotes) return
  try {
    for (const a of await $.agent.list()) {
      if (['pending', 'running', 'waiting'].includes(a.status)) await check($, a.id)
    }
  } catch {}
}

// The handoff this session knows: the task's own file, else its draft (also one from before a reload).
// Never another session's file: that belongs to another task.
export async function knownHandoff($: EngineInterface) {
  if (taskHandoff) return taskHandoff
  const own = handoff ? await handoff : undefined
  if (own || !config.handoffFile) return own
  const { dir } = await handoffDir($, config.handoffFolder, config.outsideProjectFolder)
  return newestHandoff($, dir, await $.session.id())
}

// After the main conversation is compacted: point Claude at this session's handoff, if it has one.
export async function afterCompact($: EngineInterface) {
  if (!config.guard) return
  const path = await knownHandoff($).catch(() => undefined)
  if (path) await send($, `Usage guard: the conversation was just compacted. Read the handoff file ${path} and carry on from there.`)
}

// True once a limit reached its stop stage: nothing should then start work by itself.
export const atStop = () =>
  config.guard &&
  windows.some(w => {
    const t = config.thresholds[w.kind as keyof Config['thresholds']]
    return Boolean(t) && w.percentUsed >= t.stop
  })
