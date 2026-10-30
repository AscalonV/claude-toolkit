// Usage guard: two stages per limit window (wrap-up, stop), each sent once per window, session
// and loop (main or one agent) as a user-role note the model reads on its next request. The main
// chat gets its notes (and its draft handoff) once it has started a turn, so a session opened and
// closed unused leaves no file. What was sent and the task's handoff are kept in $.state; a /clear
// or a resume forgets the task's handoff and the draft, which belong to the conversation before.
//
// Each reading is also a sample of how fast a window rises. With two or more agents running, the
// main chat is told early (at wrap-up, or when the stop is due within `narrowMinutes` at that rate)
// to let only one agent go on toward the limit: several agents winding down at the stop stage
// together still use up what is left.
import type { AgentInfo, EngineInterface } from 'claude-code'

import type { ToolkitGuard } from '../types'
import { DEFAULTS } from './config'
import type { Config, Stage } from './config'
import { createHandoff, fleetProject, handoffDir, handoffName, newestHandoff } from './handoff'
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
// Claude said the current task has no handoff file (ContextBudget handoff "none"): the session's earlier
// draft belonged to the task before, so the next warning starts a new one.
let fresh = false
// The session's project keeps its work in the Claude Fleet project database: no draft file, the note says how.
let inFleetDb = false
let mainTurn = false // the main chat started a turn (since the last load)
let mainBusy = false // a main turn is running now; an idle main chat is woken by its notes
const STATE = { plugin: 'toolkit', key: 'guard' } as const

export const setConfig = (c: Config) => (config = c)
// Samples of each window's percentage over the last RATE_SPAN, for the rate it rises at.
type Sample = { t: number; percent: number }
const samples = new Map<string, Sample[]>()
const RATE_SPAN = 10 * 60 * 1000
const MIN_SPAN = 2 * 60 * 1000
const resetMinute = (w: Window) => (w.resetsAt ? Math.round(Date.parse(w.resetsAt) / 60000) : 0)

export function setUsage(w: Window[], name: string | undefined, now?: number) {
  windows = w
  account = name
  if (now === undefined) return
  for (const x of w) {
    const key = `${x.kind}@${resetMinute(x)}` // a new window starts a new series
    const kept = (samples.get(key) ?? []).filter(s => now - s.t <= RATE_SPAN)
    samples.set(key, [...kept, { t: now, percent: x.percentUsed }])
    for (const k of samples.keys()) if (k.startsWith(`${x.kind}@`) && k !== key) samples.delete(k)
  }
}

// Percentage points a minute over the last few minutes; undefined until two minutes are seen.
export function rate(kind: string): number | undefined {
  const s = [...samples.entries()].find(([k]) => k.startsWith(`${kind}@`))?.[1]
  if (!s || s.length < 2) return undefined
  const first = s[0]
  const last = s[s.length - 1]
  if (last.t - first.t < MIN_SPAN) return undefined
  return Math.max(0, (last.percent - first.percent) / ((last.t - first.t) / 60000))
}

export const isMainBusy = () => mainBusy
export const taskHandoffPath = () => taskHandoff
export const mainTurnStarted = () => (mainTurn = mainBusy = true)
export const mainTurnEnded = () => (mainBusy = false)

async function save($: EngineInterface) {
  const sessionId = await $.session.id().catch(() => undefined)
  const value: ToolkitGuard = { ...(sessionId ? { sessionId } : {}), warned: [...warned], ...(taskHandoff ? { taskHandoff } : {}), ...(fresh ? { fresh } : {}) }
  await $.state.set(STATE, value).catch(() => {})
}

export async function setTaskHandoff($: EngineInterface, path: string) {
  taskHandoff = path
  fresh = false
  await save($)
}

// A new task without a handoff file: the task before's file and draft are no longer pointed to.
export async function clearTaskHandoff($: EngineInterface) {
  taskHandoff = undefined
  handoff = undefined
  fresh = true
  await save($)
}

// After a hot reload: the notes already sent and, if it is this session's, the task's handoff.
export async function restoreGuard($: EngineInterface) {
  const { value } = await $.state.get(STATE).catch(() => ({ value: undefined }))
  if (!value) return
  for (const key of value.warned) warned.add(key) // keyed by session: another session's never match
  if (!value.sessionId || value.sessionId === (await $.session.id())) {
    taskHandoff ??= value.taskHandoff
    fresh ||= value.fresh === true
  }
}

// A /clear or a resume: another conversation, whose notes start with its first turn.
export function resetGuard() {
  taskHandoff = undefined
  handoff = undefined
  fresh = false
  mainTurn = mainBusy = false
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
    if ((inFleetDb = await fleetProject($, project))) return undefined
    const sessionId = await $.session.id()
    const own = fresh ? undefined : await newestHandoff($, dir, sessionId)
    if (own) return own
    const path = await createHandoff($, dir, { account, sessionId, project, usage: usageLines() })
    // The new task's draft is now the session's newest: a reload goes on with it.
    if (path && fresh) {
      fresh = false
      await save($)
    }
    return path
  } catch {
    return undefined
  }
}

function note(stage: Stage, w: Window, isAgent: boolean, path: string | undefined) {
  const limit = config.thresholds[w.kind as keyof Config['thresholds']][stage]
  const r = resets(w.resetsAt)
  const head = `Usage guard: ${LABELS[w.kind]} limit at ${Math.round(w.percentUsed)}% (${stage === 'stop' ? 'stop' : 'wrap-up'} at ${limit}%${r ? `, ${r}` : ''}).`
  const file = path
    ? handoffName(path)
    : inFleetDb
      ? "the task's handoff in the project database (`fleet handoff show <slug>`, then `fleet handoff write <slug> --rev <n>`; a task without one: `fleet handoff new`, stdin: title, ::goal, ::body)"
      : 'a handoff note'
  // A plugin draft: Claude either fills it in (and marks it open) or uses the task's own file.
  const draft =
    path && path !== taskHandoff
      ? ` If the task already has its own handoff file, update that one instead, name it to ContextBudget (handoff) and delete ${path}; otherwise fill it in and set its Status to open.`
      : !path && inFleetDb
        ? ' Name its ref (fleet:<project>:<slug>, printed by fleet handoff new and show) to ContextBudget (handoff).'
        : ''
  const body = isAgent
    ? stage === 'wrapUp'
      ? 'Finish your current step and update your notes file (write your report into it now, so nothing is lost if the limit is hit), then carry on carefully: only what the current step needs to be built, tested once and committed, in as few requests as you can; no optional work (extra or repeated test runs, screenshots, new features), short messages.'
      : 'Stop: start no new work. Leave the repo buildable, write your final notes, then end with a short summary.'
    : stage === 'wrapUp'
      ? `Finish the current step, then fill in ${file} now.${draft} Tell running agents to update their notes files and to do only what their current step needs. Then carry on, but start no large new work.`
      : `Start no new work. Tell running agents to stop, leave the repo buildable and write final notes. Fold their notes into ${file}.${draft} Then tell the user in one line that the handoff is ready.`
  return [head, body, config.extraNote].filter(Boolean).join(' ')
}

// With `wake`, the main chat between turns (waiting for an agent, say) gets the note as a turn of its
// own, so it acts at once instead of at the next message; otherwise it is read on the next request.
async function send($: EngineInterface, text: string, agentId?: string, wake = false) {
  try {
    if (wake && !agentId && !mainBusy) await $.prompt.submit({ text })
    else await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId })
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
    await send($, note(stage, w, Boolean(agentId), path), agentId, true)
  }
}

export const isRunning = (a: AgentInfo) => ['pending', 'running', 'waiting'].includes(a.status)

// Main and every agent still running; with two or more agents, maybe the note to keep only one.
export async function checkAll($: EngineInterface) {
  await check($)
  let agents: AgentInfo[] = []
  try {
    agents = (await $.agent.list()).filter(isRunning)
  } catch {}
  if (config.agentNotes) for (const a of agents) await check($, a.id)
  await narrow($, agents)
}

const fmtRate = (r: number) => (r >= 1 ? r.toFixed(1) : r.toFixed(2)).replace(/\.?0+$/, '')

function narrowNote(w: Window, r: number | undefined, minutes: number, agents: AgentInfo[]) {
  const t = config.thresholds[w.kind as keyof Config['thresholds']]
  const rising = r ? `, rising ${fmtRate(r)}%/min` : ''
  const due = Number.isFinite(minutes) ? ` (the stop at ${t.stop}% in about ${Math.max(1, Math.round(minutes))} min)` : ` (stop at ${t.stop}%)`
  const list = agents.map(a => `${a.description || a.type} (${a.id})`).join('; ')
  return [
    `Usage guard: ${LABELS[w.kind]} limit at ${Math.round(w.percentUsed)}%${rising}, with ${agents.length} agents running${due}.`,
    'Let only one agent go on toward the limit: keep the one closest to a result worth keeping (or the one holding a test turn), ' +
      'and tell the others now to stop after their current edit, leave the repo buildable and write final notes. ' +
      'Start no new agents; note in the handoff which agents stopped and where.',
    `Running: ${list}.`,
    config.extraNote,
  ]
    .filter(Boolean)
    .join(' ')
}

// For the main chat: once per 5 points of a window while two or more agents still run, from the
// wrap-up stage on, or earlier when the stop is due within narrowMinutes at the current rate.
export async function narrow($: EngineInterface, agents: AgentInfo[]) {
  if (!config.guard || !config.narrowAgents || !mainTurn || agents.length < 2) return
  const session = await $.session.id()
  for (const w of windows) {
    const t = config.thresholds[w.kind as keyof Config['thresholds']]
    if (!t || w.percentUsed >= t.stop) continue // the stop note stops them all
    const r = rate(w.kind)
    const minutes = r ? (t.stop - w.percentUsed) / r : Infinity
    if (w.percentUsed < t.wrapUp && !(minutes <= config.narrowMinutes)) continue
    const key = `${session}|main|${w.kind}|${w.resetsAt?.slice(0, 16)}|narrow${Math.floor(w.percentUsed / 5)}`
    if (warned.has(key)) continue
    warned.add(key)
    await save($)
    await send($, narrowNote(w, r, minutes, agents), undefined, true)
  }
}

// The handoff this session knows: the task's own file, else its draft (also one from before a reload).
// Never another session's file: that belongs to another task.
export async function knownHandoff($: EngineInterface) {
  if (taskHandoff) return taskHandoff
  const own = handoff ? await handoff : undefined
  if (own || fresh || !config.handoffFile) return own
  const { dir } = await handoffDir($, config.handoffFolder, config.outsideProjectFolder)
  return newestHandoff($, dir, await $.session.id())
}

// After the main conversation is compacted: point Claude at this session's handoff, if it has one.
// The context budget relies on it too, so it also comes with the guard off.
export async function afterCompact($: EngineInterface) {
  if (!config.guard && !config.contextBudget) return
  const path = await knownHandoff($).catch(() => undefined)
  const who = config.guard ? 'Usage guard' : 'Context budget'
  if (path) await send($, `${who}: the conversation was just compacted. Read ${handoffName(path)} and carry on from there.`)
}

// True once a limit reached its stop stage: nothing should then start work by itself.
export const atStop = () =>
  config.guard &&
  windows.some(w => {
    const t = config.thresholds[w.kind as keyof Config['thresholds']]
    return Boolean(t) && w.percentUsed >= t.stop
  })
