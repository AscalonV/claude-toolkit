// Effort rules: added to the system prompt so Claude picks its effort per turn with the
// plugin's effort-* skills. The default is the session's own effort setting.
import type { EngineInterface } from 'claude-code'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export async function effortRules($: EngineInterface) {
  const set = await $.settings.read({ key: 'effortLevel' })
  const level = typeof set === 'string' && LEVELS.includes(set) ? set : 'high'
  const skill = (l: string) => `${$.plugin.name}:effort-${l}`
  return [
    '# Effort (save tokens)',
    `- The default is \`${level}\`. For a turn with tool work, pick the level from the descriptions of the ${['low', 'medium', 'high', 'xhigh'].map(skill).join(', ')} skills. If it isn't \`${level}\`, invoke that skill in the same message as the first tool call (no extra round trip). A turn without tool calls doesn't switch.`,
    '- Name the level in one line of every reply, e.g. `Effort: low (bookkeeping)`. The user overrides it with `/effort`.',
    `- When unsure, keep \`${level}\`: a wrong low costs more in rework. \`max\` only when the user says so.`,
    '- Subagents for searching or exploring (only when the user asks for agents): `effort: low`.',
  ].join('\n')
}
