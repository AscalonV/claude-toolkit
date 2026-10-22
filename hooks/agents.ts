// Agents: a project's own rules for its subagents, and an optional rule for the main chat to
// start agents on its own.
//
// Rules: `.claude/agent-rules.md` in the agent's working directory or the project root. They are
// added to the end of every new subagent's prompt (agent.spawn), so the agent has them before its
// first request. A resumed agent already has them.
import type { EngineInterface } from 'claude-code'

import { projectRoot } from './handoff'
import { slash } from './paths'

export const RULES_FILE = '.claude/agent-rules.md'

// The rules file and its text, or undefined where the project has none (or it is empty).
export async function agentRules($: EngineInterface, cwd: string | undefined) {
  const project = await projectRoot($)
  const dirs = [slash(cwd ?? (await $.session.cwd())), ...(project ? [project] : [])]
  for (const dir of dirs) {
    const path = `${dir}/${RULES_FILE}`
    try {
      const text = (await $.fs.read(path)).trim()
      if (text) return { path, text }
    } catch {} // no rules file here
  }
  return undefined
}

export const withRules = (prompt: string, rules: { path: string; text: string }) =>
  `${prompt}\n\n---\nThis project's rules for agents (${rules.path}):\n\n${rules.text}`

// Added to the main chat's system prompt when the `agentUse` setting is on.
export const agentUseRules = () =>
  [
    '# Agents',
    '- This replaces the default of starting agents only when the user asks: start subagents without being asked whenever parallel work makes sense, for example one agent codes while another researches, reviews or analyses logs, or one agent per repo for a batch of tasks. Small or tightly coupled work stays in the main chat.',
    "- Agents must not interfere: each owns the repo or files named in its prompt, and two agents never edit the same files. Bookkeeping (task lists, notes, the handoff) and the final summary to the user stay with the main chat.",
    "- An agent starts without this conversation's context: give it a self-contained prompt with the goal, the files it owns, what is already known and what to report back.",
    '- Agents cost tokens (each re-reads what it needs), so skip them for quick one-off tasks. At the usage guard\'s wrap-up stage, start no agents for large new work.',
  ].join('\n')
