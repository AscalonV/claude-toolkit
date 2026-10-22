// Context budget: Claude sets how large the main conversation may grow for the task at hand
// (the ContextBudget tool). At 90 % of the budget, checked at every request, Claude must decide:
// raise the budget, or fill in the handoff and ask for a compaction (with or without carrying on
// by itself). The plugin compacts at the end of that turn, and queues a "continue" prompt when
// Claude asked for it. Past the whole budget with no decision, it compacts at the turn's end and
// waits for the user. Claude Code's own compaction stays at the model's window as the safety net.
import type { EngineInterface } from 'claude-code'

export const TOOL = 'ContextBudget'
const MIN = 100_000
const NEAR = 0.9 // share of the budget at which Claude must decide

let budget = 0 // 0: the feature is off
let cap = 0
let noted = false // the decision note went out since the last compaction or raise
let pending: { carryOn: boolean } | undefined // Claude asked for a compaction at this turn's end

export const setBudget = (tokens: number, max: number) => ((budget = tokens), (cap = max))
export const currentBudget = () => budget
export const k = (n: number) => `${Math.round(n / 1000)}k`

async function context($: EngineInterface) {
  return (await $.session.usage()).context
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
    },
    required: ['reason'],
  },
  isDeferred: false,
}

// The tool call: a compaction request, or a new budget clamped to [100k, cap] (or the model's
// window when the user asked).
export async function setFromTool($: EngineInterface, input: Record<string, unknown>) {
  const { tokens: ctx = 0, window = cap } = await context($)
  if (input.compact === true) {
    pending = { carryOn: input.carryOn === true }
    return {
      result: `Compaction set for the end of this turn (context ${k(ctx)}), ${pending.carryOn ? 'then the task resumes by itself from the handoff' : 'then the user is waited for'}. End your turn now.`,
    }
  }
  const asked = Number(input.tokens)
  if (!Number.isFinite(asked)) return { deny: 'Give tokens (a new budget) or compact: true.' }
  const top = input.userAsked === true ? Math.max(cap, window) : cap
  budget = Math.round(Math.min(Math.max(asked, MIN), top, window))
  pending = undefined
  if (ctx < budget * NEAR) noted = false
  const capped = asked > top ? ` (capped: above ${k(cap)} only when the user asks)` : ''
  return { result: `Context budget set to ${k(budget)}${capped}; the context is at ${k(ctx)}.` }
}

// Fixed text (no live numbers), so the system prompt stays cached.
export const rules = () =>
  [
    '# Context budget',
    `- The conversation has a context budget (default ${k(budget)}; the status line shows context/budget). At the start of every task, also a new task in this chat, set it with the ${TOOL} tool in the same message as your first other tool call:`,
    '  - ~200k: bookkeeping, small fixes, tasks that split well across handoffs.',
    '  - 300k: normal feature work.',
    `  - 500k-${k(cap)}: complex work where a compaction would cost quality (debugging or rendering across many files, large refactors, long log analysis).`,
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
  const text = `Context budget: ${k(ctx)} of ${k(budget)}. Decide now: if the task needs this context, raise the budget with ${TOOL}. Otherwise finish the current step, fill in the handoff, call ${TOOL} with compact: true (carryOn: true if the task isn't finished and needs nothing from the user) and end your turn.`
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {}
}

const CONTINUE =
  'Continue the task: the conversation was compacted at its context budget. Read the handoff file the usage guard note names (or the newest in the handoff folder), set the context budget for the rest of the task, and carry on where you stopped.'

// At the end of a main-loop turn: the compaction Claude asked for, or past the whole budget the
// fallback one. `mayCarryOn` is false at the usage guard's stop stage.
export async function afterTurn($: EngineInterface, mayCarryOn: boolean) {
  if (!budget) return
  const { tokens: ctx = 0 } = await context($)
  const asked = pending
  if (!asked && ctx <= budget) return
  pending = undefined
  const carryOn = Boolean(asked?.carryOn) && mayCarryOn
  // compact runs between turns only, so it goes just after this one has ended.
  $.clock.after(500, () => {
    $.session
      .compact({
        instructions: `Context budget of ${k(budget)} reached. Keep: the task, its handoff file, the user's open questions and answers, the effort and context budget rules and the current budget (${k(budget)}).`,
      })
      .then(async r => {
        noted = false
        if (carryOn && !r.skip) await $.prompt.submit({ text: CONTINUE })
      })
      .catch(() => {}) // a new turn already started: the next turn's end tries again
  })
}

export const afterCompaction = () => {
  noted = false
  pending = undefined
}
