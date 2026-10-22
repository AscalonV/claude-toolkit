// Context budget: Claude sets how large the main conversation may grow for the task at hand
// (the ContextBudget tool), and the plugin compacts it at the end of the turn that passes the
// budget. Shortly before, Claude is told to fill in the handoff. Claude Code's own compaction
// stays at the model's window as the safety net for one long turn.
import type { EngineInterface } from 'claude-code'

export const TOOL = 'ContextBudget'
const MIN = 100_000
const NEAR = 0.9 // share of the budget at which Claude is told to update the handoff

let budget = 0 // 0: the feature is off
let cap = 0
let near = false // the "update the handoff" note went out since the last compaction

export const setBudget = (tokens: number, max: number) => ((budget = tokens), (cap = max))
export const currentBudget = () => budget
export const k = (n: number) => `${Math.round(n / 1000)}k`

export const toolSpec = {
  name: TOOL,
  description:
    'Sets the context budget of this conversation: the context size at which the plugin compacts it (at the end of a turn). Set it at the start of every task, also a new task in the same chat, from the rules under "Context budget".',
  inputSchema: {
    type: 'object',
    properties: {
      tokens: { type: 'number', description: 'The budget in tokens, e.g. 200000, 300000, 500000' },
      reason: { type: 'string', description: 'A few words on why this size fits the task' },
      userAsked: { type: 'boolean', description: `True only when the user asked for a budget above the cap` },
    },
    required: ['tokens', 'reason'],
  },
  isDeferred: false,
}

// The tool call: clamps the budget to [100k, cap] (or the model's window when the user asked).
export async function setFromTool($: EngineInterface, input: Record<string, unknown>) {
  const asked = Number(input.tokens)
  if (!Number.isFinite(asked)) return { deny: 'tokens must be a number' }
  const window = (await $.session.usage()).context.window ?? cap
  const top = input.userAsked === true ? Math.max(cap, window) : cap
  budget = Math.round(Math.min(Math.max(asked, MIN), top, window))
  near = false
  const ctx = (await $.session.usage()).context.tokens ?? 0
  const capped = asked > top ? ` (capped: above ${k(cap)} only when the user asks)` : ''
  return { result: `Context budget set to ${k(budget)}${capped}; the context is at ${k(ctx)}.` }
}

// Fixed text (no live numbers), so the system prompt stays cached.
export const rules = () =>
  [
    '# Context budget',
    `- The conversation is compacted at the end of the turn that passes its context budget (default ${k(budget)}; the status line shows context/budget). At the start of every task, also a new task in this chat, set the budget with the ${TOOL} tool in the same message as your first other tool call:`,
    '  - ~200k: bookkeeping, small fixes, tasks that split well across handoffs.',
    '  - 300k: normal feature work.',
    `  - 500k-${k(cap)}: complex work where a compaction would cost quality (debugging or rendering across many files, large refactors, long log analysis).`,
    '- A bigger context makes every turn cost more (the whole conversation is sent each time); a compaction drops details. Pick the smallest budget the task works well with.',
    `- Name it in the effort line, e.g. \`Effort: high (new feature) · Context: 300k\`. Above ${k(cap)} only when the user asks (userAsked).`,
  ].join('\n')

async function note($: EngineInterface, text: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {}
}

// At the end of a main-loop turn: a note near the budget, a compaction past it.
export async function afterTurn($: EngineInterface) {
  if (!budget) return
  const ctx = (await $.session.usage()).context.tokens ?? 0
  if (ctx > budget) {
    // compact runs between turns only, so it goes just after this one has ended.
    $.clock.after(500, () => {
      $.session
        .compact({
          instructions: `Context budget of ${k(budget)} reached. Keep: the task, its handoff file, the user's open questions and answers, the effort and context budget rules and the current budget (${k(budget)}).`,
        })
        .catch(() => {}) // a new turn already started: the next turn's end tries again
    })
  } else if (!near && ctx > budget * NEAR) {
    near = true
    await note($, `Context budget: ${k(ctx)} of ${k(budget)}. Fill in the handoff now; the conversation is compacted after the turn that passes the budget. If the task needs more context, raise the budget with ${TOOL} instead.`)
  }
}

export const afterCompaction = () => {
  near = false
}
