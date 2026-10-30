// The handoff file: created by the plugin at the first guard warning, filled in by Claude.
import type { EngineInterface } from 'claude-code'

import { configDir, homeDir, slash } from './paths'

export type Usage = { label: string; percent: number; resets: string }

export type HandoffInfo = {
  account?: string
  sessionId: string
  project?: string
  usage: Usage[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const isAbsolute = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p)

async function git($: EngineInterface, args: string[], cwd: string) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined // no git on this PC
  }
}

async function isProject($: EngineInterface, dir: string) {
  return (await $.fs.exists(`${dir}/CLAUDE.md`)) || (await $.fs.exists(`${dir}/.claude`))
}

// The project: the git top level, else the nearest folder up with a CLAUDE.md or .claude/
// (not the home folder, which holds ~/.claude). None for a broad task outside a project.
export async function projectRoot($: EngineInterface) {
  const cwd = slash(await $.session.cwd())
  const top = await git($, ['rev-parse', '--show-toplevel'], cwd)
  if (top) return slash(top)
  const home = (await homeDir($))?.toLowerCase()
  for (let dir = cwd; dir && !/^[a-zA-Z]:$/.test(dir); dir = dir.replace(/\/[^/]*$/, '')) {
    if (dir.toLowerCase() !== home && (await isProject($, dir))) return dir
  }
  return undefined
}

// A handoff in the Claude Fleet project database: fleet:<project key>:<slug> (General: fleet:<slug>), read with
// `fleet handoff show`. Anything else is a file path.
export const isFleetRef = (h: string) => h.startsWith('fleet:')
export function handoffName(h: string) {
  if (!isFleetRef(h)) return `the handoff file ${h}`
  const rest = h.slice('fleet:'.length)
  return `the handoff ${h} (\`fleet handoff show ${rest.includes(':') ? rest : `${rest} --general`}\`)`
}

// A project that keeps its work in the Claude Fleet project database: its folder has .fleet/project.json and this
// machine has ~/.fleet/fleet.db. Its handoffs are in the database, so no draft file goes into its folder.
export async function fleetProject($: EngineInterface, project: string | undefined) {
  if (!project) return false
  const home = await homeDir($)
  return Boolean(home) && (await $.fs.exists(`${project}/.fleet/project.json`)) && (await $.fs.exists(`${home}/.fleet/fleet.db`))
}

// Where handoffs go: <project>/<folder> in a project, else the outside folder, relative to the
// Claude config folder (~/.claude/handoffs by default). An absolute path stands as given.
export async function handoffDir($: EngineInterface, folder: string, outside: string) {
  const project = await projectRoot($)
  const pick = project ? folder : outside
  if (isAbsolute(pick)) return { dir: slash(pick), project }
  return { dir: `${project ?? (await configDir($))}/${slash(pick)}`, project }
}

// The newest handoff of this session in the folder, by the date-and-time in its name and then its
// -2, -3, ... (so a reload or restart goes on with the file it already has).
export async function newestHandoff($: EngineInterface, dir: string, sessionId: string) {
  const name = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}-\\d{4})-${sessionId.slice(0, 8)}(?:-(\\d+))?\\.md$`)
  const key = (f: string) => {
    const [, stamp, n] = name.exec(f)!
    return `${stamp}-${String(n ?? 1).padStart(3, '0')}`
  }
  try {
    const names = (await $.fs.list(dir))
      .filter(f => f.kind === 'file' && name.test(f.name))
      .map(f => f.name)
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    return names.length ? `${dir}/${names[names.length - 1]}` : undefined
  } catch {
    return undefined
  }
}

async function agentLines($: EngineInterface) {
  try {
    const active = (await $.agent.list()).filter(a => !['completed', 'failed', 'killed'].includes(a.status))
    return active.length ? active.map(a => `- ${a.description} (${a.type}, ${a.status}, id \`${a.id}\`)`) : ['- none']
  } catch {
    return ['- unknown']
  }
}

async function render($: EngineInterface, info: HandoffInfo, now: Date) {
  const cwd = slash(await $.session.cwd())
  const branch = await git($, ['branch', '--show-current'], cwd)
  const status = branch === undefined ? undefined : await git($, ['status', '--porcelain'], cwd)
  const changed = status ? status.split('\n').slice(0, 50).map(l => `  - \`${l}\``) : ['  - none']
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  // A draft until Claude fills it in: a task finder that looks for `Status: open` skips it, so a
  // file nobody filled in never passes for a task to continue.
  return [
    `# Handoff ${date} ${time}`,
    `Updated: ${date} ${time} · Status: draft (set to open once filled in)`,
    '',
    'Created by the usage guard; the lines below are a snapshot from that moment.',
    '',
    `- Account: ${info.account ?? 'unknown'}`,
    `- Session: \`${info.sessionId}\``,
    `- Project: ${info.project ? `\`${info.project}\`` : 'none (task outside a project)'}`,
    `- Working directory: \`${cwd}\``,
    ...(branch === undefined ? ['- Git: not a repository'] : [`- Git branch: \`${branch || '(detached)'}\``, '- Uncommitted files:', ...changed]),
    ...info.usage.map(u => `- Usage ${u.label}: ${u.percent}%${u.resets}`),
    '',
    '## Running agents (when created)',
    '',
    ...(await agentLines($)),
    '',
    '## Goal',
    '',
    '## Done',
    '',
    '## Next steps',
    '',
    '## Agents and their notes files',
    '',
    '## Open questions',
    '',
  ].join('\n')
}

// Writes a new handoff file and returns its path. Never overwrites: a taken name gets -2, -3, ...
// ($.fs has no exclusive create, but the session id in the name keeps sessions apart.)
export async function createHandoff($: EngineInterface, dir: string, info: HandoffInfo) {
  const now = new Date()
  const stem = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${info.sessionId.slice(0, 8)}`
  for (let i = 1; i < 100; i++) {
    const path = `${dir}/${stem}${i > 1 ? `-${i}` : ''}.md`
    if (await $.fs.exists(path)) continue
    await $.fs.write(path, await render($, info, now))
    return path
  }
  return undefined
}
