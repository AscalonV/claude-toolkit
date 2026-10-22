// Context budget: Claude sets how large the main conversation may grow for the task at hand
// (the ContextBudget tool). At 90 % of the budget, checked before every request of the main chat,
// Claude must decide: raise the budget, or fill in the handoff and ask for a compaction (with or
// without carrying on by itself). The plugin compacts at the end of that turn, and queues a
// "continue" prompt when Claude asked for it. It never compacts on its own: past the budget Claude
// is reminded again (at 100 % and every further 10 %), so nothing is summarized before Claude has
// saved what matters. Claude Code's own compaction stays at the model's window as the safety net.
//
// The user's messages come first: one that starts a turn before the compaction ran (a queued
// message) moves the compaction to that turn's end, and Claude is told so; one typed while it runs
// replaces the "continue" prompt, with a note to Claude to resume unless the message changes the
// task. The budget and the request are kept in $.state, so a hot reload keeps them; a /clear or a
// resume starts them over.
import type { EngineInterface, PromptSubmitInput, Timer } from 'claude-code'

import type { ToolkitContext } from '../types'
import { afterCompact, setTaskHandoff, taskHandoffPath } from './guard'

export const TOOL = 'ContextBudget'
const MIN = 100_000
const NEAR = 0.9 // share of the budget at which Claude must decide
const STATE = { plugin: 'toolkit', key: 'context' } as const
// Where a prompt comes from the user: the terminal, Remote Control, or a headless run.
const USER = ['composer', 'bridge', 'sdk']

let configured = 0 // the settings' budget, until Claude sets one; 0: the feature is off
let budget = 0
let isSet = false // Claude set the budget (else it is the settings' default)
let cap = 0
let step = 0 // the share of the budget the last decision note went out at (0.9, 1.0, 1.1, ...); 0 none
let pending: { carryOn: boolean } | undefined // Claude asked for a compaction; cleared once it ran
// The compaction set for just after a turn's end; a turn that starts first takes it over.
let due: Timer | undefined
// The compaction running; `userWrote` once a message of the user's arrived meanwhile.
let running: { carryOn: boolean; userWrote: boolean } | undefined
let turnRunning = false // a main-loop turn is running
// Under the REPL $.session.compact works; headless (-p, SDK hosts) only the /compact command does.
let interactive = true

export const setBudget = (tokens: number, max: number) => ((configured = budget = tokens), (cap = max))
export const setInteractive = (is: boolean) => (interactive = is)
export const compacting = () => Boolean(running)
export const currentBudget = () => budget
export const k = (n: number) => `${Math.round(n / 1000)}k`

async function context($: EngineInterface) {
  return (await $.session.usage()).context
}

async function save($: EngineInterface) {
  const sessionId = await $.session.id().catch(() => undefined)
  const value: ToolkitContext = { ...(sessionId ? { sessionId } : {}), budget, isSet, step, ...(pending ? { pending } : {}) }
  await $.state.set(STATE, value).catch(() => {})
}

// After a hot reload: the budget and the request as they stood, if they are this session's. A budget
// Claude never set follows the settings, which may have changed with the reload.
export async function restoreBudget($: EngineInterface) {
  if (!configured) return
  const { value } = await $.state.get(STATE).catch(() => ({ value: undefined }))
  if (!value || (value.sessionId && value.sessionId !== (await $.session.id()))) return
  isSet = value.isSet ?? true
  budget = isSet ? value.budget : configured
  step = value.step ?? (value.noted ? NEAR : 0)
  pending = value.pending
}

// A /clear or a resume: the conversation is another one, with no budget or request of its own yet.
export function resetBudget() {
  due?.cancel()
  due = undefined
  budget = configured
  isSet = false
  step = 0
  pending = undefined
}

async function note($: EngineInterface, text: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {}
}

export const toolSpec = {
  name: TOOL,
  description:
    'Sets the context budget of this conversation, or asks for a compaction at the end of this turn. Use it at the start of every task (also a new task in the same chat) and when told the budget is nearly used, following the rules under "Context budget".',
  inputSchema: {
    type: 'object',
    properties: {
      tokens: { type: 'number', description: 'The new budget in tokens, e.g. 200000, 300000, 500000' },
      reason: { type: 'string', description: 'A few words on why' },
      userAsked: { type: 'boolean', description: 'True only when the user asked for a budget above the cap' },
      compact: { type: 'boolean', description: 'True: the handoff is filled in; compact at the end of this turn (then end the turn)' },
      carryOn: { type: 'boolean', description: 'With compact: true when the task is not finished and needs no input from the user, so work resumes by itself after the compaction' },
      handoff: { type: 'string', description: "The task's handoff file (absolute path), as soon as it has one: the usage guard and the compaction point to it" },
    },
    required: ['reason'],
  },
  isDeferred: false,
}

// The tool call: a compaction request, or a new budget clamped to [100k, cap] (or the model's
// window when the user asked).
export async function setFromTool($: EngineInterface, input: Record<string, unknown>) {
  const { tokens: ctx = 0, window = cap } = await context($)
  const path = typeof input.handoff === 'string' ? input.handoff.trim() : ''
  if (path) await setTaskHandoff($, path)
  const named = path ? ` Handoff file: ${path}.` : ''
  if (input.compact === true) {
    pending = { carryOn: input.carryOn === true }
    await save($)
    const none = taskHandoffPath() ? '' : ' No handoff file is named yet: if you filled one in, call again with handoff.'
    return {
      result: `Compaction set for the end of this turn (context ${k(ctx)}), ${pending.carryOn ? 'then the task resumes by itself from the handoff' : 'then the user is waited for'}.${named}${none} End your turn now.`,
    }
  }
  if (input.tokens === undefined && path) return { result: `Handoff file set to ${path}.` }
  const asked = Number(input.tokens)
  if (!Number.isFinite(asked)) return { deny: 'Give tokens (a new budget), compact: true or handoff.' }
  const top = input.userAsked === true ? Math.max(cap, window) : cap
  budget = Math.round(Math.min(Math.max(asked, MIN), top, window))
  isSet = true
  pending = undefined
  step = 0 // a new budget gets its own 90 % note, also when the context is already past it
  await save($)
  const capped = asked > top ? ` (capped: above ${k(cap)} only when the user asks)` : ''
  return { result: `Context budget set to ${k(budget)}${capped}; the context is at ${k(ctx)}.${named}` }
}

// Fixed text (no live numbers), so the system prompt stays cached: the default from the settings,
// not the budget Claude set.
export const rules = () =>
  [
    '# Context budget',
    `- The conversation has a context budget (default ${k(configured)}; the status line shows context/budget). At the start of every task, also a new task in this chat, set it with the ${TOOL} tool in the same message as your first other tool call:`,
    '  - ~200k: bookkeeping, small fixes, tasks that split well across handoffs.',
    '  - 300k: normal feature work.',
    `  - 500k-${k(cap)}: complex work where a compaction would cost quality (debugging or rendering across many files, large refactors, long log analysis).`,
    `- When the task has a handoff file (a new one, or the one a new chat continues from), name it with the ${TOOL} tool's handoff field (also in the same call as the budget), so the usage guard and the compaction point to it.`,
    '- A bigger context makes every request cost more (the whole conversation is sent each time); a compaction drops details. Pick the smallest budget the task works well with.',
    `- At 90 % you are told to decide (again at 100 % and every further 10 %; the plugin never compacts by itself): raise the budget (${TOOL} with tokens) if the task needs the context, or finish the current step, fill in the handoff, call ${TOOL} with compact: true (carryOn: true when the task isn't finished and needs nothing from the user) and end your turn. The plugin compacts after it and, with carryOn, starts the next turn from the handoff.`,
    `- Name the budget in the effort line, e.g. \`Effort: high (new feature) · Context: 300k\`. Above ${k(cap)} only when the user asks (userAsked).`,
  ].join('\n')

// The decision step a context size has reached: 0.9 from 90 %, then 1.0, 1.1, ... past the budget.
const stepOf = (share: number) => (share < NEAR ? 0 : share < 1 ? NEAR : Math.floor(share * 10 + 1e-9) / 10)

// Before each request of the main chat (and when the context was measured): the decision note at
// 90 % of the budget, again at 100 % and every further 10 %.
export async function beforeRequest($: EngineInterface) {
  if (!budget || pending) return
  const { tokens: ctx = 0 } = await context($)
  const reached = stepOf(ctx / budget)
  if (reached <= step) return
  step = reached
  await save($)
  const past = reached >= 1 ? ', past the budget (the plugin does not compact by itself)' : ''
  await note(
    $,
    `Context budget: ${k(ctx)} of ${k(budget)}${past}. Decide now: if the task needs this context, raise the budget with ${TOOL}. Otherwise finish the current step, fill in the handoff, call ${TOOL} with compact: true (carryOn: true if the task isn't finished and needs nothing from the user) and end your turn.`,
  )
}

const CONTINUE =
  'Continue the task: the conversation was compacted at its context budget. Read the handoff file the usage guard note above names (if none is named, go on from the summary), set the context budget for the rest of the task, and carry on where you stopped.'

const MOVED = `Context budget: the compaction you asked for did not run, because a new turn (the user's message) started first. Answer the user. The plugin compacts at the end of this turn and then waits for the user. If the task should still resume by itself afterwards (the user's message doesn't change it), call ${TOOL} again with compact: true and carryOn: true; if the task needs the context, raise the budget instead.`

const RESUME =
  'Context budget: the conversation was just compacted and the task was set to resume by itself, but the user wrote first. Answer them, then carry on with the task from the handoff file the usage guard note names (or the summary) unless their message changes it.'

// A main-loop turn ended (also an interrupted one).
export const turnEnded = () => (turnRunning = false)

// At the end of a main-loop turn: the compaction Claude asked for. `mayCarryOn` is false at the usage
// guard's stop stage.
export async function afterTurn($: EngineInterface, mayCarryOn: boolean) {
  if (!budget || !pending) return
  const carryOn = pending.carryOn && mayCarryOn
  // compact runs between turns only, so it goes just after this one has ended.
  due?.cancel()
  const timer = $.clock.after(500, () => {
    if (due !== timer) return
    due = undefined
    void compactNow($, carryOn)
  })
  due = timer
}

async function compactNow($: EngineInterface, carryOn: boolean) {
  const run = (running = { carryOn, userWrote: false })
  const instructions = `Context budget of ${k(budget)} reached. Keep: the task, its handoff file, the user's open questions and answers, the effort and context budget rules and the current budget (${k(budget)}).`
  try {
    if (interactive) {
      const r = await $.session.compact({ instructions })
      if (r.skip) {
        // Vetoed (a hook, a PreCompact rule): not asked again at every turn's end.
        running = undefined
        pending = undefined
        await save($)
        return
      }
    } else {
      // Headless (-p, an SDK host such as an IDE extension): $.session.compact is not available
      // there yet, the /compact command is. It waits until the session is idle.
      await $.command.run({ command: 'compact', args: instructions })
    }
    running = undefined
    // The plugin's own compaction steps past its own session.compact hook: do its part here.
    await afterCompaction($)
    await afterCompact($)
    if (carryOn && !run.userWrote) await $.prompt.submit({ text: CONTINUE })
  } catch (err) {
    running = undefined
    if (turnRunning) await moved($) // a turn started in between
    else await failed($, err)
  }
}

// A turn started before the compaction ran: it waits for this turn's end, and Claude hears why.
async function moved($: EngineInterface) {
  pending = { carryOn: false }
  await save($)
  await note($, MOVED)
}

// Refused for another reason: Claude hears it once, and it is not tried again at every turn's end.
async function failed($: EngineInterface, err: unknown) {
  pending = undefined
  await save($)
  const reason = String((err as Error)?.message ?? err).slice(0, 300)
  await note(
    $,
    `Context budget: the compaction you asked for could not run (${reason}). If it is still needed, call ${TOOL} with compact: true again at the end of a later turn, or ask the user to run /compact.`,
  )
}

// A main-loop turn starts (the user's queued message, say) while a compaction waits for its slot.
export async function turnStarted($: EngineInterface) {
  turnRunning = true
  if (!due) return
  due.cancel()
  due = undefined
  await moved($)
}

// A prompt of the user's while a compaction runs: it goes before the "continue" prompt, which is
// then not sent; Claude reads beside it that the task was meant to resume.
export function duringCompaction(e: PromptSubmitInput): PromptSubmitInput {
  if (!running?.carryOn || e.command || !USER.includes(e.origin?.kind)) return e
  running.userWrote = true
  return { ...e, context: [...(e.context ?? []), RESUME] }
}

// Any compaction of the main conversation (also /compact or Claude Code's own): the request is
// done and the decision notes may come again.
export async function afterCompaction($: EngineInterface) {
  step = 0
  pending = undefined
  await save($)
}
