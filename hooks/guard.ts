// Usage guard: three stages per limit window, each sent once per window, session and loop (main or
// one agent) as a user-role note the model reads on its next request:
// - one agent: work goes on as usual, but a new agent is refused while another still runs;
// - careful: work goes on, bigger tasks too, in shorter turns, the handoff kept current;
// - stop: no new work, agents stop, the handoff is filled in. It also comes early, from careful mode
//   on, when at the rate the window rises the stop is due within `stopLead` minutes.
// The main chat gets its notes (and its draft handoff, from careful mode on) once it has started a
// turn, so a session opened and closed unused leaves no file. What was sent and the task's handoff
// are kept in $.state; a /clear or a resume forgets the task's handoff and the draft, which belong
// to the conversation before.
//
// Each reading is also a sample of how fast a window rises. With two or more agents running, the
// main chat is told early (at the one-agent stage, or when the stop is due within `narrowMinutes` at
// that rate) to let only one agent go on toward the limit: several agents winding down at the stop
// stage together still use up what is left.
import type { AgentInfo, EngineInterface } from 'claude-code'

import type { ToolkitGuard } from '../types'
import { DEFAULTS, STAGES } from './config'
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

type Limits = Config['thresholds']['five_hour']
const limitsOf = (w: Window): Limits | undefined => config.thresholds[w.kind as keyof Config['thresholds']]

// Minutes until the stop at the rate the window rises now; Infinity while that isn't known.
function minutesToStop(w: Window, t: Limits) {
  const r = rate(w.kind)
  return r ? (t.stop - w.percentUsed) / r : Infinity
}

// The stage a window is at, if any. From careful mode on the stop comes early when, at the rate the
// window rises, it is due within stopLead minutes: notes are read only at the next request, and
// several loops (or other sessions on the account) can each still make some before they stop.
export function stageOf(w: Window): Stage | undefined {
  const t = limitsOf(w)
  if (!t) return undefined
  if (w.percentUsed >= t.stop) return 'stop'
  if (w.percentUsed >= t.careful) return config.stopLead && minutesToStop(w, t) <= config.stopLead ? 'stop' : 'careful'
  return w.percentUsed >= t.oneAgent ? 'oneAgent' : undefined
}

// The highest stage any window is at, with that window; undefined below every one (or the guard off).
export function guardMode(): { stage: Stage; w: Window } | undefined {
  if (!config.guard) return undefined
  let best: { stage: Stage; w: Window } | undefined
  for (const w of windows) {
    const stage = stageOf(w)
    if (stage && (!best || STAGES.indexOf(stage) > STAGES.indexOf(best.stage))) best = { stage, w }
  }
  return best
}

const MODE_LABELS: Record<Stage, string> = { oneAgent: 'one agent', careful: 'careful', stop: 'stop' }
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
// For the status line and the usage line: `guard: careful (5h)`, or '' below every stage.
export function modeText() {
  const m = guardMode()
  return m ? `guard: ${MODE_LABELS[m.stage]} (${SHORT[m.w.kind] ?? m.w.kind})` : ''
}

const agentList = (agents: AgentInfo[]) => agents.map(a => `${a.description || a.type} (${a.id})`).join('; ')

// Why a new agent is refused, or undefined when it may start: from the one-agent stage on while
// another agent still runs, and at the stop stage always.
export function spawnRefusal(running: AgentInfo[]): string | undefined {
  const m = guardMode()
  if (!m) return undefined
  const t = limitsOf(m.w)!
  const at = `Usage guard: the ${LABELS[m.w.kind]} limit is at ${Math.round(m.w.percentUsed)}%`
  if (m.stage === 'stop') return `${at} (stop stage): start no new agents. Leave the work in the handoff for the next session.`
  if (!running.length) return undefined
  const [still, done] = running.length > 1 ? ['still run', 'they are'] : ['still runs', 'that one is']
  return `${at} (one agent at a time from ${t.oneAgent}%), and ${agentList(running)} ${still}. Do this work yourself, or start the agent once ${done} done.`
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

const fmtRate = (r: number) => (r >= 1 ? r.toFixed(1) : r.toFixed(2)).replace(/\.?0+$/, '')

function note(stage: Stage, w: Window, isAgent: boolean, path: string | undefined) {
  const t = limitsOf(w)!
  const r = resets(w.resetsAt)
  const rising = rate(w.kind)
  const early = stage === 'stop' && w.percentUsed < t.stop && rising ? `, due in about ${Math.max(1, Math.round(minutesToStop(w, t)))} min at +${fmtRate(rising)}%/min` : ''
  const at = {
    oneAgent: `one agent at a time from ${t.oneAgent}%, careful mode at ${t.careful}%`,
    careful: `careful mode at ${t.careful}%, stop at ${t.stop}%`,
    stop: `stop at ${t.stop}%${early}`,
  }[stage]
  const head = `Usage guard: ${LABELS[w.kind]} limit at ${Math.round(w.percentUsed)}% (${at}${r ? `, ${r}` : ''}).`
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
    ? stage === 'stop'
      ? 'Stop: start no new work. Leave the repo buildable, write your final notes, then end with a short summary.'
      : 'Careful mode: carry on with your task, in fewer, focused requests and short messages; tests and screenshots are fine. Keep your notes file current (write your report into it as you go), so nothing is lost when the stop comes.'
    : {
        oneAgent:
          'Work on as usual, but with at most one agent at a time: a new agent is refused while another still runs. Do work that would need a second agent yourself, or once the running one is done.',
        careful: `Careful mode: carry on and finish the work, bigger tasks too; nothing needs to be cancelled. Keep turns short (fewer, focused requests, short messages) and to one agent at a time (a second is refused); tests and screenshots are fine. Keep ${file} current at the end of each step, so the stop finds it ready.${draft}`,
        stop: `Start no new work. Tell running agents to stop, leave the repo buildable and write final notes. Fold their notes into ${file}.${draft} Then tell the user in one line that the handoff is ready.`,
      }[stage]
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

// Sends what this loop is due: per window, the highest stage reached and not yet sent. Agents get
// no one-agent note: starting agents is the main chat's.
export async function check($: EngineInterface, agentId?: string) {
  if (!config.guard || (agentId ? !config.agentNotes : !mainTurn)) return
  const session = await $.session.id()
  for (const w of windows) {
    const stage = stageOf(w)
    if (!stage || (agentId && stage === 'oneAgent')) continue
    const key = (s: Stage) => `${session}|${agentId ?? 'main'}|${w.kind}|${w.resetsAt?.slice(0, 16)}|${s}`
    if (warned.has(key(stage))) continue
    for (const s of STAGES.slice(0, STAGES.indexOf(stage) + 1)) warned.add(key(s)) // a note covers the stages below
    await save($)
    const path = agentId || stage === 'oneAgent' ? undefined : await ensureHandoff($)
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

function narrowNote(w: Window, r: number | undefined, minutes: number, agents: AgentInfo[]) {
  const t = limitsOf(w)!
  const rising = r ? `, rising ${fmtRate(r)}%/min` : ''
  const due = Number.isFinite(minutes) ? ` (the stop at ${t.stop}% in about ${Math.max(1, Math.round(minutes))} min)` : ` (stop at ${t.stop}%)`
  return [
    `Usage guard: ${LABELS[w.kind]} limit at ${Math.round(w.percentUsed)}%${rising}, with ${agents.length} agents running${due}.`,
    'Let only one agent go on toward the limit: keep the one closest to a result worth keeping (or the one holding a test turn), ' +
      'and tell the others now to stop after their current edit, leave the repo buildable and write final notes. ' +
      'New agents are refused while one runs; note in the handoff which agents stopped and where.',
    `Running: ${agentList(agents)}.`,
    config.extraNote,
  ]
    .filter(Boolean)
    .join(' ')
}

// For the main chat: once per 5 points of a window while two or more agents still run, from the
// one-agent stage on, or earlier when the stop is due within narrowMinutes at the current rate.
export async function narrow($: EngineInterface, agents: AgentInfo[]) {
  if (!config.guard || !config.narrowAgents || !mainTurn || agents.length < 2) return
  const session = await $.session.id()
  for (const w of windows) {
    const t = limitsOf(w)
    if (!t || stageOf(w) === 'stop') continue // the stop note stops them all
    const r = rate(w.kind)
    const minutes = minutesToStop(w, t)
    if (w.percentUsed < t.oneAgent && !(minutes <= config.narrowMinutes)) continue
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
export const atStop = () => guardMode()?.stage === 'stop'
