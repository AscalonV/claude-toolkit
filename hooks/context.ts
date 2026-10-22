// Context budget: Claude sets how large the main conversation may grow for the task at hand
// (the ContextBudget tool). At 90 % of the budget, checked at every request, Claude must decide:
// raise the budget, or fill in the handoff and ask for a compaction (with or without carrying on
// by itself). The plugin compacts at the end of that turn, and queues a "continue" prompt when
// Claude asked for it. Past the whole budget with no decision, it compacts at the turn's end and
// waits for the user. Claude Code's own compaction stays at the model's window as the safety net.
//
// The user's messages come first: one that starts a turn before the compaction ran (a queued
// message) moves the compaction to that turn's end, and Claude is told so; one typed while it runs
// replaces the "continue" prompt, with a note to Claude to resume unless the message changes the
// task. The budget and the request are kept in $.state, so a hot reload keeps them.
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
let cap = 0
let noted = false // the decision note went out since the last compaction or raise
let pending: { carryOn: boolean } | undefined // Claude asked for a compaction; cleared once it ran
// The compaction set for just after a turn's end; a turn that starts first takes it over.
let due: { timer: Timer; asked: boolean } | undefined
// The compaction running; `userWrote` once a message of the user's arrived meanwhile.
let running: { carryOn: boolean; userWrote: boolean } | undefined

export const setBudget = (tokens: number, max: number) => ((configured = budget = tokens), (cap = max))
export const compacting = () => Boolean(running)
export const currentBudget = () => budget
export const k = (n: number) => `${Math.round(n / 1000)}k`

async function context($: EngineInterface) {
  return (await $.session.usage()).context
}

async function save($: EngineInterface) {
  const value: ToolkitContext = { budget, noted, ...(pending ? { pending } : {}) }
  await $.state.set(STATE, value).catch(() => {})
}

// After a hot reload: the budget and the request as they stood.
export async function restoreBudget($: EngineInterface) {
  if (!configured) return
  const { value } = await $.state.get(STATE).catch(() => ({ value: undefined }))
  if (!value) return
  budget = value.budget
  noted = value.noted
  pending = value.pending
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
  pending = undefined
  noted = false // a new budget gets its own 90 % note, also when the context is already past it
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
    `- At 90 % you are told to decide: raise the budget (${TOOL} with tokens) if the task needs the context, or finish the current step, fill in the handoff, call ${TOOL} with compact: true (carryOn: true when the task isn't finished and needs nothing from the user) and end your turn. The plugin compacts after it and, with carryOn, starts the next turn from the handoff.`,
    `- Name the budget in the effort line, e.g. \`Effort: high (new feature) · Context: 300k\`. Above ${k(cap)} only when the user asks (userAsked).`,
  ].join('\n')

// When the context changes (each request): the decision note once it passes 90 % of the budget.
export async function beforeRequest($: EngineInterface) {
  if (!budget || noted || pending) return
  const { tokens: ctx = 0 } = await context($)
  if (ctx < budget * NEAR) return
  noted = true
  await save($)
  await note(
    $,
    `Context budget: ${k(ctx)} of ${k(budget)}. Decide now: if the task needs this context, raise the budget with ${TOOL}. Otherwise finish the current step, fill in the handoff, call ${TOOL} with compact: true (carryOn: true if the task isn't finished and needs nothing from the user) and end your turn.`,
  )
}

const CONTINUE =
  'Continue the task: the conversation was compacted at its context budget. Read the handoff file the usage guard note above names (if none is named, go on from the summary), set the context budget for the rest of the task, and carry on where you stopped.'

const MOVED = `Context budget: the compaction you asked for did not run, because this turn (the user's message) started first. Answer the user. The plugin compacts at the end of this turn and then waits for the user. If the task should still resume by itself afterwards (the user's message doesn't change it), call ${TOOL} again with compact: true and carryOn: true; if the task needs the context, raise the budget instead.`

const RESUME =
  'Context budget: the conversation was just compacted and the task was set to resume by itself, but the user wrote first. Answer them, then carry on with the task from the handoff file the usage guard note names (or the summary) unless their message changes it.'

// At the end of a main-loop turn: the compaction Claude asked for, or past the whole budget the
// fallback one. `mayCarryOn` is false at the usage guard's stop stage.
export async function afterTurn($: EngineInterface, mayCarryOn: boolean) {
  if (!budget) return
  const { tokens: ctx = 0 } = await context($)
  if (!pending && ctx <= budget) return
  const asked = Boolean(pending)
  const carryOn = Boolean(pending?.carryOn) && mayCarryOn
  // compact runs between turns only, so it goes just after this one has ended.
  due?.timer.cancel()
  const timer = $.clock.after(500, () => {
    if (due?.timer !== timer) return
    due = undefined
    void compactNow($, carryOn, asked)
  })
  due = { timer, asked }
}

async function compactNow($: EngineInterface, carryOn: boolean, asked: boolean) {
  const run = (running = { carryOn, userWrote: false })
  try {
    const r = await $.session.compact({
      instructions: `Context budget of ${k(budget)} reached. Keep: the task, its handoff file, the user's open questions and answers, the effort and context budget rules and the current budget (${k(budget)}).`,
    })
    running = undefined
    if (r.skip) {
      // Vetoed (a hook, a PreCompact rule): not asked again at every turn's end.
      pending = undefined
      await save($)
      return
    }
    // The plugin's own compaction steps past its own session.compact hook: do its part here.
    await afterCompaction($)
    await afterCompact($)
    if (carryOn && !run.userWrote) await $.prompt.submit({ text: CONTINUE })
  } catch {
    running = undefined
    await moved($, asked) // a turn started in between
  }
}

// A turn started before the compaction ran: it waits for this turn's end, and Claude hears why.
async function moved($: EngineInterface, asked: boolean) {
  if (!asked) return // past the budget with no request: this turn's end compacts again
  pending = { carryOn: false }
  await save($)
  await note($, MOVED)
}

// A main-loop turn starts (the user's queued message, say) while a compaction waits for its slot.
export async function turnStarted($: EngineInterface) {
  if (!due) return
  const { timer, asked } = due
  due = undefined
  timer.cancel()
  await moved($, asked)
}

// A prompt of the user's while a compaction runs: it goes before the "continue" prompt, which is
// then not sent; Claude reads beside it that the task was meant to resume.
export function duringCompaction(e: PromptSubmitInput): PromptSubmitInput {
  if (!running?.carryOn || e.command || !USER.includes(e.origin?.kind)) return e
  running.userWrote = true
  return { ...e, context: [...(e.context ?? []), RESUME] }
}

// Any compaction of the main conversation (also /compact or Claude Code's own): the request is
// done and the 90 % note may come again.
export async function afterCompaction($: EngineInterface) {
  noted = false
  pending = undefined
  await save($)
}
