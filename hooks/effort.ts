// Effort rules: added to the system prompt so Claude picks its effort per turn with the effort-*
// skills. The default is the session's own effort setting. Where the project brings its own
// effort-<level> skill (.claude/skills in the working directory or project root), the rules
// name that one instead of the plugin's.
import type { EngineInterface } from 'claude-code'

import { projectRoot } from './handoff'
import { slash } from './paths'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const SKILLS = ['low', 'medium', 'high', 'xhigh']

async function skillName($: EngineInterface, level: string, dirs: string[]) {
  for (const dir of dirs) {
    if (await $.fs.exists(`${dir}/.claude/skills/effort-${level}/SKILL.md`)) return `effort-${level}`
  }
  return `${$.plugin.name}:effort-${level}`
}

const valid = (v: unknown): v is string => typeof v === 'string' && LEVELS.includes(v)

// The effort the person set: per model (`modelSettings`, where /effort keeps it), else the plain
// `effortLevel`. Without a model (before the first request) a per-model level counts when all agree.
export async function defaultLevel($: EngineInterface, model?: string) {
  const perModel = (await $.settings.read({ key: 'modelSettings' })) as Record<string, { effortLevel?: unknown } | undefined> | undefined
  const levels = Object.entries(perModel ?? {})
  if (model) {
    const ids = [model, model.replace(/\[.*\]$/, '')]
    const hit = levels.find(([id, s]) => ids.includes(id) && valid(s?.effortLevel))
    if (hit) return hit[1]!.effortLevel as string
  } else {
    const all = [...new Set(levels.map(([, s]) => s?.effortLevel).filter(valid))]
    if (all.length === 1) return all[0]
  }
  const set = await $.settings.read({ key: 'effortLevel' })
  return valid(set) ? set : undefined
}

export async function effortRules($: EngineInterface, agentUse = false, model?: string) {
  const level = (await defaultLevel($, model)) ?? 'high'
  const project = await projectRoot($)
  const dirs = [slash(await $.session.cwd()), ...(project ? [project] : [])]
  const names = await Promise.all(SKILLS.map(l => skillName($, l, dirs)))
  const own = names.filter(n => !n.includes(':'))
  return [
    '# Effort',
    `- The default is \`${level}\`. For a turn with tool work, pick the level from the descriptions of the ${names.join(', ')} skills. If it isn't \`${level}\`, invoke that skill in the same message as the first tool call (no extra round trip). A turn without tool calls doesn't switch.`,
    ...(own.length ? [`- This project has its own ${own.join(', ')}: use them, not the ${$.plugin.name}:effort-* skills of the same level.`] : []),
    '- Name the level in one line of every reply, e.g. `Effort: low (bookkeeping)`. The user overrides it with `/effort`.',
    `- When unsure, keep \`${level}\`: a wrong low costs more in rework. \`max\` only when the user says so.`,
    `- Subagents for searching or exploring${agentUse ? '' : ' (only when the user asks for agents)'}: \`effort: low\`; other agents get the level their task fits.`,
  ].join('\n')
}
