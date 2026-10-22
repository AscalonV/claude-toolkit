import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const RESET = '2026-10-22T15:40:00Z'
const files = new Map<string, string>()
// The engine hands paths over resolved for this OS (C:\home\t on Windows): compare them as /home/t.
const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

// The world beneath the plugin: a home folder with a login, one running agent, and by default
// a project in git at /proj. Without git, `cwd` is where the session runs.
function world(on: any, { git = true, cwd = '/proj', statusLine = { type: 'command', command: 'x' } as object } = {}) {
  files.clear()
  files.set('/home/t/.claude.json', JSON.stringify({ oauthAccount: { displayName: 'Alex', accountUuid: 'acct-1' } }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'abcdef12-3456-7890-abcd-ef1234567890' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: { statusLine } }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    files.has(norm(e.path)) ? { value: files.get(norm(e.path)) } : Promise.reject(new Error('missing')))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(norm(e.path), e.text), { value: undefined }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const out: Record<string, string> = { 'rev-parse': '/proj', branch: 'main', status: ' M src/a.ts' }
    if (!git) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: out[e.argv[1]] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: [{ id: 'agent-1', description: 'build docs', type: 'general-purpose', status: 'running' }] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  on('ui.status', () => ({ value: undefined }))
  return mock.session(on)
}

const measure = (percentUsed: number, changed = ['rateLimits']) => ({
  context: { tokens: 1000, window: 200000 },
  rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: RESET }],
  changed,
})

const texts = (rows: readonly { message: { content: readonly { text?: unknown }[] }; agentId?: string }[]) =>
  rows.map(r => `${r.agentId ?? 'main'}: ${String(r.message.content[0]?.text)}`)

test('wrap-up, then stop, each once, for main and the running agent', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.session.measure(measure(50) as never)
  expect(session.appended().length).toBe(0)

  await $.session.measure(measure(86) as never)
  await $.session.measure(measure(87) as never)
  const wrap = texts(session.appended())
  expect(wrap.length).toBe(2)
  expect(wrap[0]).toMatch(/^main: Usage guard: 5-hour limit at 86% \(wrap-up at 85%/)
  expect(wrap[0]).toMatch(/\/proj\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12\.md/)
  expect(wrap[1]).toMatch(/^agent-1: .*update your notes file/)

  const handoff = [...files.keys()].find(p => p.startsWith('/proj/handoffs/'))!
  expect(files.get(handoff)).toMatch(/Account: Alex/)
  expect(files.get(handoff)).toMatch(/Git branch: `main`/)
  expect(files.get(handoff)).toMatch(/build docs/)
  expect(files.get(handoff)).toMatch(/## Open questions/)

  await $.session.measure(measure(92) as never)
  const all = texts(session.appended())
  expect(all.length).toBe(4)
  expect(all[2]).toMatch(/^main: .*stop at 90%.*Start no new work/)
  expect(all[3]).toMatch(/^agent-1: .*Stop: start no new work/)
  expect([...files.keys()].filter(p => p.startsWith('/proj/handoffs/')).length).toBe(1)
})

test('after /login, the old account numbers are ignored until a fresh reading', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(10) as never)

  files.set('/home/t/.claude.json', JSON.stringify({ oauthAccount: { displayName: 'Sam', accountUuid: 'acct-2' } }))
  await $.session.measure(measure(86, ['context']) as never)
  expect(session.appended().length).toBe(0)

  await $.session.measure(measure(86) as never)
  expect(texts(session.appended())[0]).toMatch(/^main: Usage guard/)
})

test('a bad threshold falls back to the default with one notice', { options: { fiveHourWrapUp: 95, fiveHourStop: 90 } }, async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const notices = session.appended().filter(r => r.message.type === 'system')
  expect(notices.length).toBe(1)

  await $.session.measure(measure(86) as never)
  expect(texts(session.appended()).some(t => /wrap-up at 85%/.test(t))).toBe(true)
})

test('after compaction, Claude is pointed at the handoff', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(86) as never)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toMatch(/^main: .*compacted\. Read the handoff file \/proj\/handoffs\/.*abcdef12\.md/)
})

test('a broad task outside any project keeps its handoff in the config folder', async ($, on) => {
  const session = world(on, { git: false, cwd: '/home/t' })
  files.set('/home/t/.claude', '') // ~/.claude exists, but it doesn't make the home folder a project
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(86) as never)
  expect(texts(session.appended())[0]).toMatch(/\/home\/t\/\.claude\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12\.md/)
  const handoff = [...files.keys()].find(p => p.startsWith('/home/t/.claude/handoffs/'))!
  expect(files.get(handoff)).toMatch(/Project: none \(task outside a project\)/)
  expect(files.get(handoff)).toMatch(/Git: not a repository/)
})

test('a project without git is found by its CLAUDE.md, from a subfolder', async ($, on) => {
  const session = world(on, { git: false, cwd: '/work/notes/sub' })
  files.set('/work/notes/CLAUDE.md', '# notes')
  await $.session.start({ cwd: '/work/notes/sub', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(86) as never)
  expect(texts(session.appended())[0]).toMatch(/\/work\/notes\/handoffs\//)
})

test('the effort rules join the system prompt, naming the plugin skills', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const effort = sections[sections.length - 1]
  expect(effort.id).toBe('toolkit:effort')
  expect(effort.text).toMatch(/The default is `high`/)
  expect(effort.text).toMatch(/toolkit:effort-low, toolkit:effort-medium, toolkit:effort-high, toolkit:effort-xhigh/)
})

test('a status line from before the rename is replaced', async ($, on) => {
  const old = { type: 'command', command: 'grep -F "$id" "/home/t/.claude/account-statusline.tsv" | cut -f3' }
  world(on, { statusLine: old })
  files.set('/home/t/.claude/settings.json', JSON.stringify({ model: 'opus', statusLine: old }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const settings = JSON.parse(files.get('/home/t/.claude/settings.json')!)
  expect(settings.model).toBe('opus')
  expect(settings.statusLine.command).toMatch(/\/home\/t\/\.claude\/toolkit\.tsv/)
})

test('a project with its own effort skills gets those named instead', async ($, on) => {
  world(on)
  files.set('/proj/.claude/skills/effort-low/SKILL.md', '---\nname: effort-low\n---')
  files.set('/proj/.claude/skills/effort-xhigh/SKILL.md', '---\nname: effort-xhigh\n---')
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const text = sections[sections.length - 1].text
  expect(text).toMatch(/effort-low, toolkit:effort-medium, toolkit:effort-high, effort-xhigh skills/)
  expect(text).toMatch(/This project has its own effort-low, effort-xhigh: use them/)
})

const spawnWorld = (on: any) => {
  world(on)
  const prompts: string[] = []
  on('agent.spawn', (_: unknown, e: { prompt: string }) => (prompts.push(e.prompt), { model: 'm', agentId: 'agent-2' }))
  return prompts
}

test("a new agent gets the project's agent rules at the end of its prompt", async ($, on) => {
  const prompts = spawnWorld(on)
  files.set('/proj/.claude/agent-rules.md', '- Only touch the files your prompt names.\n')
  await $.agent.spawn({ prompt: 'Fix the build.', description: 'fix build' })
  expect(prompts[0]).toMatch(/^Fix the build\.\n\n---\nThis project's rules for agents \(\/proj\/\.claude\/agent-rules\.md\):\n\n- Only touch the files your prompt names\.$/)
})

test('without a rules file, the prompt is left alone', async ($, on) => {
  const prompts = spawnWorld(on)
  await $.agent.spawn({ prompt: 'Fix the build.', description: 'fix build' })
  expect(prompts[0]).toBe('Fix the build.')
})

test('agentRules off leaves the prompt alone', { options: { agentRules: false } }, async ($, on) => {
  const prompts = spawnWorld(on)
  files.set('/proj/.claude/agent-rules.md', '- Only touch the files your prompt names.')
  await $.agent.spawn({ prompt: 'Fix the build.', description: 'fix build' })
  expect(prompts[0]).toBe('Fix the build.')
})

const compose = ($: any, tools: string[]) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools, outputStyle: null, traits: [] })

test('the agent-use rule is off by default', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const { sections } = await compose($, ['Agent', 'Bash'])
  expect(sections.some((s: { id: string }) => s.id === 'toolkit:agents')).toBe(false)
  expect(sections[sections.length - 1].text).toMatch(/\(only when the user asks for agents\)/)
})

test('with agentUse on, the main chat is told to start agents; agents themselves are not', { options: { agentUse: true } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const main = await compose($, ['Agent', 'Bash'])
  const agents = main.sections.find((s: { id: string }) => s.id === 'toolkit:agents')
  expect(agents.text).toMatch(/start subagents without being asked/)
  const effort = main.sections.find((s: { id: string }) => s.id === 'toolkit:effort')
  expect(effort.text).not.toMatch(/only when the user asks/)
  const sub = await compose($, ['Bash', 'Read'])
  expect(sub.sections.some((s: { id: string }) => s.id === 'toolkit:agents')).toBe(false)
})
