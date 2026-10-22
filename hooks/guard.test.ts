import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const RESET = '2026-10-22T15:40:00Z'
const files = new Map<string, string>()
// The engine hands paths over resolved for this OS (C:\home\t on Windows): compare them as /home/t.
const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

// The world beneath the plugin: a home folder with a login, a project in git, one running agent.
function world(on: any) {
  files.clear()
  files.set('/home/t/.claude.json', JSON.stringify({ oauthAccount: { displayName: 'Alex', accountUuid: 'acct-1' } }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'abcdef12-3456-7890-abcd-ef1234567890' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: { statusLine: { type: 'command', command: 'x' } } }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    files.has(norm(e.path)) ? { value: files.get(norm(e.path)) } : Promise.reject(new Error('missing')))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(norm(e.path), e.text), { value: undefined }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const out: Record<string, string> = { 'rev-parse': '/proj', branch: 'main', status: ' M src/a.ts' }
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

  await $.session.measure(measure(80) as never)
  await $.session.measure(measure(81) as never)
  const wrap = texts(session.appended())
  expect(wrap.length).toBe(2)
  expect(wrap[0]).toMatch(/^main: Usage guard: 5-hour limit at 80% \(wrap-up at 75%/)
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
  await $.session.measure(measure(80, ['context']) as never)
  expect(session.appended().length).toBe(0)

  await $.session.measure(measure(80) as never)
  expect(texts(session.appended())[0]).toMatch(/^main: Usage guard/)
})

test('a bad threshold falls back to the default with one notice', { options: { fiveHourWrapUp: 95, fiveHourStop: 90 } }, async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const notices = session.appended().filter(r => r.message.type === 'system')
  expect(notices.length).toBe(1)

  await $.session.measure(measure(76) as never)
  expect(texts(session.appended()).some(t => /wrap-up at 75%/.test(t))).toBe(true)
})

test('after compaction, Claude is pointed at the handoff', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(80) as never)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toMatch(/^main: .*compacted\. Read the handoff file \/proj\/handoffs\/.*abcdef12\.md/)
})
