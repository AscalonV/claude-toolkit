// Usage guard: two stages per limit window (wrap-up, stop), each sent once per window, session
// and loop (main or one agent) as a user-role note the model reads on its next request.
import type { EngineInterface } from 'claude-code'

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

export const setConfig = (c: Config) => (config = c)
export const setUsage = (w: Window[], name: string | undefined) => ((windows = w), (account = name))

function resets(iso: string | undefined) {
  if (!iso) return ''
  const t = new Date(iso)
  return isNaN(t.getTime()) ? '' : ` (resets ${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())})`
}

const usageLines = (): Usage[] =>
  windows
    .filter(w => LABELS[w.kind])
    .map(w => ({ label: LABELS[w.kind], percent: Math.round(w.percentUsed), resets: resets(w.resetsAt) }))

// This session's handoff, created on first use.
function ensureHandoff($: EngineInterface) {
  return (handoff ??= makeHandoff($))
}

async function makeHandoff($: EngineInterface) {
  if (!config.handoffFile) return undefined
  try {
    const { dir, project } = await handoffDir($, config.handoffFolder, config.outsideProjectFolder)
    return await createHandoff($, dir, { account, sessionId: await $.session.id(), project, usage: usageLines() })
  } catch {
    return undefined
  }
}

function note(stage: Stage, w: Window, isAgent: boolean, path: string | undefined) {
  const limit = config.thresholds[w.kind as keyof Config['thresholds']][stage]
  const head = `Usage guard: ${LABELS[w.kind]} limit at ${Math.round(w.percentUsed)}% (${stage === 'stop' ? 'stop' : 'wrap-up'} at ${limit}%${resets(w.resetsAt)}).`
  const file = path ? `the handoff file ${path}` : 'a handoff note'
  const body = isAgent
    ? stage === 'wrapUp'
      ? 'Finish your current step and update your notes file, then carry on, but start no large new work.'
      : 'Stop: start no new work. Leave the repo buildable, write your final notes, then end with a short summary.'
    : stage === 'wrapUp'
      ? `Finish the current step, then fill in ${file} now. Tell running agents to update their notes files. Then carry on, but start no large new work.`
      : `Start no new work. Tell running agents to stop, leave the repo buildable and write final notes. Fold their notes into ${file}, then tell the user in one line that the handoff is ready.`
  return [head, body, config.extraNote].filter(Boolean).join(' ')
}

async function send($: EngineInterface, text: string, agentId?: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId })
  } catch {} // an agent that just ended takes no row
}

// Sends what this loop is due: per window, the highest stage reached and not yet sent.
export async function check($: EngineInterface, agentId?: string) {
  if (!config.guard || (agentId && !config.agentNotes)) return
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

// After the main conversation is compacted: point Claude at this session's handoff, or the newest.
export async function afterCompact($: EngineInterface) {
  if (!config.guard) return
  const own = handoff ? await handoff : undefined
  const { dir } = await handoffDir($, config.handoffFolder, config.outsideProjectFolder)
  const path = own ?? (await newestHandoff($, dir))
  if (path) await send($, `Usage guard: the conversation was just compacted. Read the handoff file ${path} and carry on from there.`)
}

// True once a limit reached its stop stage: nothing should then start work by itself.
export const atStop = () =>
  config.guard &&
  windows.some(w => {
    const t = config.thresholds[w.kind as keyof Config['thresholds']]
    return Boolean(t) && w.percentUsed >= t.stop
  })
