// The handoff file: created by the plugin at the first guard warning, filled in by Claude.
import type { EngineInterface } from 'claude-code'

export type Usage = { label: string; percent: number; resets: string }

export type HandoffInfo = {
  account?: string
  sessionId: string
  usage: Usage[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const slash = (p: string) => p.replace(/\\/g, '/')
const isAbsolute = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p)

async function git($: EngineInterface, args: string[], cwd: string) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined // no git on this PC
  }
}

// The project root: the git top level, else the working directory.
export async function projectRoot($: EngineInterface) {
  const cwd = await $.session.cwd()
  return slash((await git($, ['rev-parse', '--show-toplevel'], cwd)) ?? cwd)
}

export async function handoffDir($: EngineInterface, folder: string) {
  return isAbsolute(folder) ? slash(folder) : `${await projectRoot($)}/${slash(folder)}`
}

// The newest handoff in the folder, by the date-and-time in its name.
export async function newestHandoff($: EngineInterface, dir: string) {
  try {
    const names = (await $.fs.list(dir))
      .filter(f => f.kind === 'file' && /^\d{4}-\d{2}-\d{2}-\d{4}-.*\.md$/.test(f.name))
      .map(f => f.name)
      .sort()
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
  return [
    `# Handoff ${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    '',
    `- Account: ${info.account ?? 'unknown'}`,
    `- Session: \`${info.sessionId}\``,
    `- Working directory: \`${cwd}\``,
    ...(branch === undefined ? ['- Git: not a repository'] : [`- Git branch: \`${branch || '(detached)'}\``, '- Uncommitted files:', ...changed]),
    ...info.usage.map(u => `- Usage ${u.label}: ${u.percent}%${u.resets}`),
    '',
    '## Running agents',
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
