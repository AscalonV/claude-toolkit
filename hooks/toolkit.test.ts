import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const RESET = '2026-10-22T15:40:00Z'
const files = new Map<string, string>()
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
let sid = SID // the session id; a /clear changes it
let ctxNow = 0 // the context size session.usage answers
let winNow = 1000000 // the model's window
let compactAt: number | undefined // where Claude Code compacts on its own (breakdown)
let clock: any
let compactedWith: string | undefined // the instructions of the last compaction
let refuseCompact = false // the next compaction is refused, as when a turn started first
let vetoCompact = false // the next compactions are vetoed, as by a PreCompact hook
let holdCompact: Promise<void> | undefined // a compaction waits for this, so a prompt can come meanwhile
const AGENT_1 = { id: 'agent-1', description: 'build docs', type: 'general-purpose', status: 'running' }
let agentsNow: object[] = [] // what agent.list answers
// The engine hands paths over resolved for this OS (C:\home\t on Windows): compare them as /home/t.
const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

// The world beneath the plugin: a home folder with a login, one running agent, and by default
// a project in git at /proj. Without git, `cwd` is where the session runs.
function world(on: any, { git = true, cwd = '/proj', statusLine = { type: 'command', command: 'x' } as object, settings = {} as object } = {}) {
  files.clear()
  files.set('/home/t/.claude.json', JSON.stringify({ oauthAccount: { displayName: 'Alex', accountUuid: 'acct-1' } }))
  mock.env(on, { HOME: '/home/t' })
  sid = SID
  ctxNow = 0
  winNow = 1000000
  compactAt = undefined
  compactedWith = undefined
  refuseCompact = false
  vetoCompact = false
  holdCompact = undefined
  clock = mock.clock(on, { now: NOW })
  on('tool.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.usage', (_: unknown, e: { breakdown?: string } = {}) => ({
    value: {
      startedAt: NOW,
      context: { window: winNow, tokens: ctxNow, ...(e?.breakdown && compactAt ? { breakdown: { autoCompactThreshold: compactAt } } : {}) },
      rateLimits: [],
    },
  }))
  on('settings.read', () => ({ value: { statusLine, ...settings } }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    files.has(norm(e.path)) ? { value: files.get(norm(e.path)) } : Promise.reject(new Error('missing')))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(norm(e.path), e.text), { value: undefined }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: [...files.keys()]
      .filter(p => p.slice(0, p.lastIndexOf('/')) === norm(e.path))
      .map(p => ({ name: p.slice(p.lastIndexOf('/') + 1), kind: 'file' })),
  }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const out: Record<string, string> = { 'rev-parse': '/proj', branch: 'main', status: ' M src/a.ts' }
    if (!git) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: out[e.argv[1]] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  agentsNow = [AGENT_1]
  on('agent.list', () => ({ value: agentsNow }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('session.compact', async (_: unknown, e: { instructions?: string; trigger: string }) => {
    if (e.trigger !== 'precompute' && refuseCompact) {
      refuseCompact = false
      throw new Error('a turn is running')
    }
    if (e.trigger !== 'precompute' && holdCompact) await holdCompact
    if (e.trigger !== 'precompute' && vetoCompact) return { skip: 'a PreCompact hook blocked it' }
    compactedWith = e.instructions ?? ''
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('ui.status', () => ({ value: undefined }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as never
  })
  return mock.session(on)
}

const measure = (percentUsed: number, changed = ['rateLimits']) => ({
  context: { tokens: 1000, window: 200000 },
  rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: RESET }],
  changed,
})

const texts = (rows: readonly { message: { content: readonly { text?: unknown }[] }; agentId?: string }[]) =>
  rows.map(r => `${r.agentId ?? 'main'}: ${String(r.message.content[0]?.text)}`)

test('careful, then stop, each once, for main and the running agent', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)

  await $.session.measure(measure(50) as never)
  expect(session.appended().length).toBe(0)

  await $.session.measure(measure(91) as never)
  await $.session.measure(measure(92) as never)
  const wrap = texts(session.appended())
  expect(wrap.length).toBe(2)
  expect(wrap[0]).toMatch(/^main: Usage guard: 5-hour limit at 91% \(careful mode at 90%/)
  expect(wrap[0]).toMatch(/\/proj\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12\.md/)
  expect(wrap[1]).toMatch(/^agent-1: .*Careful mode: carry on.*Keep your notes file current/)

  const handoff = [...files.keys()].find(p => p.startsWith('/proj/handoffs/'))!
  expect(files.get(handoff)).toMatch(/Account: Alex/)
  expect(files.get(handoff)).toMatch(/Git branch: `main`/)
  expect(files.get(handoff)).toMatch(/build docs/)
  expect(files.get(handoff)).toMatch(/## Open questions/)

  await $.session.measure(measure(96) as never)
  const all = texts(session.appended())
  expect(all.length).toBe(4)
  expect(all[2]).toMatch(/^main: .*stop at 95%.*Start no new work/)
  expect(all[3]).toMatch(/^agent-1: .*Stop: start no new work/)
  expect([...files.keys()].filter(p => p.startsWith('/proj/handoffs/')).length).toBe(1)
})

test('after /login, the old account numbers are ignored until a fresh reading', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(10) as never)

  files.set('/home/t/.claude.json', JSON.stringify({ oauthAccount: { displayName: 'Sam', accountUuid: 'acct-2' } }))
  await $.session.measure(measure(86, ['context']) as never)
  expect(session.appended().length).toBe(0)

  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/^main: Usage guard/)
})

test('a bad threshold falls back to the default with one notice', { options: { fiveHourCareful: 96, fiveHourStop: 95 } }, async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  const notices = session.appended().filter(r => r.message.type === 'system')
  expect(notices.length).toBe(1)

  await $.session.measure(measure(91) as never)
  expect(texts(session.appended()).some(t => /careful mode at 90%/.test(t))).toBe(true)
})

test('after compaction, Claude is pointed at the handoff', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toMatch(/^main: .*compacted\. Read the handoff file \/proj\/handoffs\/.*abcdef12\.md/)
})

test("after a reload, the guard goes on with the session's own handoff, not a new one", async ($, on) => {
  const session = world(on)
  files.set('/proj/handoffs/2026-10-22-0900-abcdef12.md', '# Handoff (before the reload)')
  files.set('/proj/handoffs/2026-10-22-0930-99999999.md', '# Handoff of another session')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/the handoff file \/proj\/handoffs\/2026-10-22-0900-abcdef12\.md/)
  expect([...files.keys()].filter(p => p.startsWith('/proj/handoffs/')).length).toBe(2)
  expect(files.get('/proj/handoffs/2026-10-22-0900-abcdef12.md')).toBe('# Handoff (before the reload)')
})

test('a broad task outside any project keeps its handoff in the config folder', async ($, on) => {
  const session = world(on, { git: false, cwd: '/home/t' })
  files.set('/home/t/.claude', '') // ~/.claude exists, but it doesn't make the home folder a project
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/\/home\/t\/\.claude\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12\.md/)
  const handoff = [...files.keys()].find(p => p.startsWith('/home/t/.claude/handoffs/'))!
  expect(files.get(handoff)).toMatch(/Project: none \(task outside a project\)/)
  expect(files.get(handoff)).toMatch(/Git: not a repository/)
})

test('a project without git is found by its CLAUDE.md, from a subfolder', async ($, on) => {
  const session = world(on, { git: false, cwd: '/work/notes/sub' })
  files.set('/work/notes/CLAUDE.md', '# notes')
  await $.session.start({ cwd: '/work/notes/sub', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/\/work\/notes\/handoffs\//)
})

// The context each prompt reached the engine with.
const contextWorld = (on: any) => {
  const session = world(on)
  const contexts: (readonly string[])[] = []
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => (contexts.push(e.context ?? []), { text: e.text }))
  return { session, contexts }
}

test('a prompt that starts a turn carries the usage line in its context, never as a row', async ($, on) => {
  const { session, contexts } = contextWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'hi', turnId: 't0' } as never)
  expect(contexts[0].length).toBe(1)
  expect(contexts[0][0]).toMatch(/^Usage now \(toolkit\): Alex \| .*5h\/week not known yet$/)
  await $.session.measure(measure(42) as never)
  await $.prompt.submit({ text: 'more', origin: { kind: 'composer' }, turnId: 't0' } as never) // delivered into t0
  await $.prompt.submit({ text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: '/idea x', command: { name: 'idea', args: 'x' }, origin: { kind: 'composer' } } as never)
  expect(contexts[1].length).toBe(0)
  expect(contexts[2].length).toBe(1)
  expect(contexts[2][0]).toMatch(/^Usage now \(toolkit\): Alex \| .*ctx 1k\/300k \| 5h 42% \(resets \d\d:40\)$/)
  expect(contexts[3].length).toBe(0)
  expect(session.appended().length).toBe(0)
})

test('the usage rule joins the main prompt only; usageLine false turns line and rule off', { options: { usageLine: false } }, async ($, on) => {
  const { contexts } = contextWorld(on)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect(contexts[0].length).toBe(0)
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Agent'], outputStyle: null, traits: [] })
  expect(sections.some(s => s.id === 'toolkit:usage')).toBe(false)
})

test('the usage rule is in the main prompt by default', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [] }))
  const main = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Agent'], outputStyle: null, traits: [] })
  expect(main.sections.find(s => s.id === 'toolkit:usage')?.text).toMatch(/never say you can't see the usage/)
  const agent = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(agent.sections.some(s => s.id === 'toolkit:usage')).toBe(false)
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
  await $.turn.start({ text: '', turnId: 't0' } as never)
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
  expect(sections.find((s: { id: string }) => s.id === 'toolkit:effort').text).toMatch(/\(only when the user asks for agents\)/)
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

const budgetTool = 'mcp__toolkit__ContextBudget'
const turnEnd = ($: any) => $.turn.complete({ answer: '', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' } as never)

test('Claude sets the budget; above the cap only when the user asked', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  const set = async (input: object) => JSON.stringify(await $.tool.call({ tool: budgetTool, ...input } as never))
  expect(await set({ tokens: 500000, reason: 'render debugging' })).toMatch(/set to 500k/)
  expect(await set({ tokens: 950000, reason: 'huge' })).toMatch(/set to 800k \(capped/)
  expect(await set({ tokens: 950000, reason: 'user wants it', userAsked: true })).toMatch(/set to 950k/)
  expect(await set({ tokens: 20000, reason: 'tiny' })).toMatch(/set to 100k/)
})

// A world where the queued prompts are kept.
const budgetWorld = (on: any) => {
  const session = world(on)
  const submitted: string[] = []
  on('prompt.submit', (_: unknown, e: { text: string }) => (submitted.push(e.text), { text: e.text }))
  return { session, submitted }
}
const start = async ($: any, budget: number) => {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.tool.call({ tool: budgetTool, tokens: budget, reason: 'test' } as never)
}

test('an idle main chat is woken by its guard note; during a turn it is appended', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await turnEnd($) // main waits for its agent now
  await $.session.measure(measure(91) as never)
  expect(submitted.filter(t => /^Usage guard: 5-hour limit at 91% \(careful mode at 90%/.test(t)).length).toBe(1)
  const rows = texts(session.appended())
  expect(rows.some(t => t.startsWith('main: Usage guard'))).toBe(false)
  expect(rows.find(t => t.startsWith('agent-1:'))).toMatch(/Careful mode: carry on with your task/)

  await $.turn.start({ text: '', turnId: 't2' } as never) // the woken turn: no second note
  await $.session.measure(measure(96) as never)
  expect(submitted.filter(t => /Usage guard/.test(t)).length).toBe(1)
  expect(texts(session.appended()).find(t => t.startsWith('main: Usage guard'))).toMatch(/stop at 95%/)
})

test('at 90 % Claude must decide; a compaction it asks for with carryOn resumes the task', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)

  ctxNow = 150000
  await $.session.measure(measure(10) as never)
  expect(session.appended().length).toBe(0)

  ctxNow = 185000
  await $.session.measure(measure(10) as never)
  await $.session.measure(measure(10) as never)
  const notes = texts(session.appended())
  expect(notes.length).toBe(1)
  expect(notes[0]).toMatch(/^main: Context budget: 185k of 200k\. Decide now/)

  // Between 90 % and the budget, no decision yet: nothing happens at the turn's end.
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)

  const answer = JSON.stringify(await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never))
  expect(answer).toMatch(/then the task resumes by itself/)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget\. Keep: the task, its handoff file/)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toMatch(/^Continue the task/)
})

test('raising the budget at 90 % lets the work go on without a compaction', async ($, on) => {
  budgetWorld(on)
  await start($, 200000)
  ctxNow = 190000
  await $.session.measure(measure(10) as never)
  await $.tool.call({ tool: budgetTool, tokens: 500000, reason: 'needs the context' } as never)
  ctxNow = 230000
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
})

test('past the whole budget the plugin never compacts by itself: Claude is reminded at 100 % and every further 10 %', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  for (const tokens of [185000, 190000, 205000, 215000, 221000, 260000]) {
    ctxNow = tokens
    await $.session.measure(measure(10) as never)
  }
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
  expect(submitted.length).toBe(0)
  const notes = texts(session.appended()).filter(t => /Context budget:/.test(t))
  expect(notes.map(t => /: (\d+k) of/.exec(t)![1])).toEqual(['185k', '205k', '221k', '260k'])
  expect(notes[0]).not.toMatch(/past the budget/)
  expect(notes[1]).toMatch(/205k of 200k, past the budget \(the plugin does not compact by itself\)\. Decide now/)
})

const step = async ($: any) => {
  const stream = $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3 } as never)
  for await (const _ of stream);
}

test('the decision note comes before the next request, mid-turn, without waiting for a measurement', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 150000
  await step($)
  expect(texts(session.appended()).length).toBe(0)
  ctxNow = 190000
  await step($)
  await step($)
  expect(texts(session.appended())).toEqual([expect.stringMatching(/^main: Context budget: 190k of 200k\. Decide now/)])
})

test('headless (-p, an SDK host), the compaction runs as the /compact command', async ($, on) => {
  const { submitted } = budgetWorld(on)
  const commands: { command: string; args?: string }[] = []
  on('command.run', (_: unknown, e: { command: string; args?: string }) => (commands.push(e), { text: '' }))
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.tool.call({ tool: budgetTool, tokens: 200000, reason: 'test' } as never)
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined) // not through $.session.compact, which headless sessions refuse
  expect(commands.map(c => c.command)).toEqual(['compact'])
  expect(commands[0].args).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(submitted).toEqual([expect.stringMatching(/^Continue the task/)])
})

test('a compaction refused for another reason is said once, with the reason, and not tried at every turn', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 200000)
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true } as never)
  await turnEnd($)
  refuseCompact = true
  await clock.advance(1000)
  const last = texts(session.appended()).pop()
  expect(last).toMatch(/^main: Context budget: the compaction you asked for could not run \(.+\)\. If it is still needed/)
  expect(last).not.toMatch(/started first/)
  await turnStart($)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
})

test("at the usage guard's stop stage, a carryOn compaction does not resume by itself", async ($, on) => {
  const { submitted } = budgetWorld(on)
  await start($, 200000)
  await $.session.measure(measure(95) as never)
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(submitted.length).toBe(0)
})

test('the budget rules join the main prompt only, and contextBudget 0 turns it all off', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const main = await compose($, ['Agent', budgetTool])
  expect(main.sections.find((s: { id: string }) => s.id === 'toolkit:context').text).toMatch(/set it with the ContextBudget tool/)
  const sub = await compose($, ['Bash'])
  expect(sub.sections.some((s: { id: string }) => s.id === 'toolkit:context')).toBe(false)
})

test('contextBudget 0: no rules, no compaction', { options: { contextBudget: 0 } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  const { sections } = await compose($, ['Agent'])
  expect(sections.some((s: { id: string }) => s.id === 'toolkit:context')).toBe(false)
  ctxNow = 900000
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
})

test("a compaction never names another session's handoff", async ($, on) => {
  const session = world(on)
  files.set('/proj/handoffs/2026-10-22-0930-99999999.md', '# Handoff of another session')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(10) as never) // no warning, so no draft of its own
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).some(t => /handoff/.test(t))).toBe(false)
})

test("the task's own handoff, named to ContextBudget, wins over a draft", async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  const answer = JSON.stringify(await $.tool.call({ tool: budgetTool, tokens: 300000, reason: 'task', handoff: '/proj/handoffs/2026-10-22-task.md' } as never))
  expect(answer).toMatch(/Handoff file: \/proj\/handoffs\/2026-10-22-task\.md/)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/Keep the handoff file \/proj\/handoffs\/2026-10-22-task\.md current at the end of each step/)
  expect([...files.keys()].some(p => /\/proj\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12/.test(p))).toBe(false)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toMatch(/Read the handoff file \/proj\/handoffs\/2026-10-22-task\.md/)
})

test('a handoff in the Claude Fleet project database: named as fleet:<project>:<slug>, read with fleet handoff show', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  const answer = JSON.stringify(await $.tool.call({ tool: budgetTool, tokens: 300000, reason: 'task', handoff: 'fleet:demo:2026-10-30-login' } as never))
  expect(answer).toMatch(/Handoff: fleet:demo:2026-10-30-login\./)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/Keep the handoff fleet:demo:2026-10-30-login \(`fleet handoff show demo:2026-10-30-login`\) current at the end of each step/)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toMatch(/Read the handoff fleet:demo:2026-10-30-login \(`fleet handoff show demo:2026-10-30-login`\)/)
})

test('a project in the Claude Fleet project database gets no draft file: the note says how to write its handoff there', async ($, on) => {
  const session = world(on)
  files.set('/proj/.fleet/project.json', '{"id":"x"}')
  files.set('/home/t/.fleet/fleet.db', '')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  expect([...files.keys()].some(p => p.startsWith('/proj/handoffs/'))).toBe(false)
  expect(texts(session.appended())[0]).toMatch(/Keep the task's handoff in the project database \(`fleet handoff show <slug>`.*\) current at the end of each step, so the stop finds it ready\. Name its ref \(fleet:<project>:<slug>/)
})

test('a draft is marked as one until Claude fills it in', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  const draft = [...files.keys()].find(p => p.startsWith('/proj/handoffs/'))!
  expect(files.get(draft)).toMatch(/^# Handoff .*\nUpdated: \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Status: draft/)
  expect(texts(session.appended())[0]).toMatch(/update that one instead, name it to ContextBudget \(handoff\) and delete .*; otherwise fill it in and set its Status to open/)
})

test("a session's -2 handoff is newer than its first", async ($, on) => {
  const session = world(on)
  files.set('/proj/handoffs/2026-10-22-0900-abcdef12.md', 'first')
  files.set('/proj/handoffs/2026-10-22-0900-abcdef12-2.md', 'second')
  files.set('/proj/handoffs/2026-10-22-0900-abcdef12-10.md', 'tenth')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended())[0]).toMatch(/abcdef12-10\.md/)
})

test('a new budget gets its own 90 % note, also when the context is already past it', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.session.measure(measure(10) as never)
  await $.tool.call({ tool: budgetTool, tokens: 205000, reason: 'a bit more' } as never)
  ctxNow = 190000
  await $.session.measure(measure(10) as never)
  const notes = texts(session.appended()).filter(t => /Context budget:/.test(t))
  expect(notes.length).toBe(2)
  expect(notes[1]).toMatch(/190k of 205k/)
})

test('our status line from an earlier version is updated; one set elsewhere or by someone else stays', async ($, on) => {
  const earlier = { type: 'command', command: `id=x; grep -F "$id" "/home/t/.claude/toolkit.tsv" | head -1 | cut -f3` }
  world(on, { statusLine: earlier })
  files.set('/home/t/.claude/settings.json', JSON.stringify({ statusLine: earlier }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  expect(JSON.parse(files.get('/home/t/.claude/settings.json')!).statusLine.command).toContain('[ -z "$id" ] || grep -F')
})

test("someone else's status line is left alone", async ($, on) => {
  const theirs = { type: 'command', command: 'echo mine' }
  world(on, { statusLine: theirs })
  files.set('/home/t/.claude/settings.json', JSON.stringify({ statusLine: theirs }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  expect(JSON.parse(files.get('/home/t/.claude/settings.json')!).statusLine.command).toBe('echo mine')
})

const summary = [{ role: 'user', text: 'summary', toolUses: [] }]
const turnStart = ($: any, turnId = 't2') => $.turn.start({ text: '', turnId } as never)

test('a precompute is no compaction: no note, and the compaction Claude asked for still runs', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 200000)
  await $.tool.call({ tool: budgetTool, reason: 'task', handoff: '/proj/handoffs/task.md' } as never)
  ctxNow = 185000
  await $.session.measure(measure(10) as never)
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await $.session.compact({ trigger: 'precompute', messages: summary } as never)
  expect(texts(session.appended()).some(t => /just compacted/.test(t))).toBe(false)
  compactedWith = undefined
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
})

test('without a main turn yet, no guard note and no draft; the first turn brings both', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended()).filter(t => t.startsWith('main:')).length).toBe(0) // agents still get theirs
  expect([...files.keys()].some(p => p.startsWith('/proj/handoffs/'))).toBe(false)
  await turnStart($)
  expect(texts(session.appended()).find(t => t.startsWith('main:'))).toMatch(/^main: Usage guard: 5-hour limit at 91% \(careful mode at 90%, stop at 95%, resets /)
  expect([...files.keys()].some(p => p.startsWith('/proj/handoffs/'))).toBe(true)
})

test('the budget, the request, the task handoff and the sent notes are written to $.state', async ($, on) => {
  budgetWorld(on)
  const saved: Record<string, any> = {}
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => ((saved[e.key] = e.value), { value: { isSet: true, version: 1 } }))
  await start($, 500000)
  await $.tool.call({ tool: budgetTool, reason: 'task', handoff: '/proj/handoffs/task.md' } as never)
  await $.tool.call({ tool: budgetTool, reason: 'done', compact: true, carryOn: true } as never)
  await $.session.measure(measure(91) as never)
  expect(saved.context).toEqual({ sessionId: SID, budget: 500000, isSet: true, step: 0, pending: { carryOn: true } })
  expect(saved.guard.sessionId).toBe(SID)
  expect(saved.guard.taskHandoff).toBe('/proj/handoffs/task.md')
  expect(saved.guard.warned).toContain('abcdef12-3456-7890-abcd-ef1234567890|main|five_hour|2026-10-22T15:40|careful')
})

test('after a reload they are read back: no second note, and the compaction asked for still runs', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  const kept: Record<string, unknown> = {
    context: { budget: 500000, noted: true, pending: { carryOn: true } },
    guard: { warned: ['abcdef12-3456-7890-abcd-ef1234567890|main|five_hour|2026-10-22T15:40|careful'], taskHandoff: '/proj/handoffs/task.md' },
  }
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: kept[e.key], version: 1 } }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await turnStart($, 't1')
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended()).filter(t => t.startsWith('main:'))).toEqual([])
  ctxNow = 300000
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 500k context budget/)
  expect(texts(session.appended()).pop()).toMatch(/Read the handoff file \/proj\/handoffs\/task\.md/)
  expect(submitted).toEqual([expect.stringMatching(/^Continue the task/)])
})

test("a queued message that starts a turn first moves the compaction to that turn's end, and Claude is told", async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.session.measure(measure(10) as never)
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await turnStart($) // the queued message, before the 0.5 s wait is over
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: the compaction you asked for did not run.*call ContextBudget again with compact: true and carryOn: true/)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(submitted.length).toBe(0) // then the user is waited for
})

test('after the move, Claude asking again with carryOn resumes the task', async ($, on) => {
  const { submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  refuseCompact = true // the turn started just as the compaction was about to run
  await clock.advance(1000)
  await turnStart($)
  await $.tool.call({ tool: budgetTool, reason: 'answered; task unchanged', compact: true, carryOn: true } as never)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(submitted).toEqual([expect.stringMatching(/^Continue the task/)])
})

test('a message typed while the compaction runs goes first, with the note to resume; no continue prompt', async ($, on) => {
  world(on)
  const prompts: { text: string; context?: readonly string[]; origin?: unknown }[] = []
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[]; origin?: unknown }) => (prompts.push(e), { text: e.text }))
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  let release!: () => void
  holdCompact = new Promise(r => (release = r))
  await turnEnd($)
  await clock.advance(1000)
  await $.prompt.submit({ text: 'quick question', origin: { kind: 'composer' } } as never)
  release()
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(prompts.map(p => p.text)).toEqual(['quick question'])
  expect(prompts[0].context?.join()).toMatch(/the user wrote first\. Answer them, then carry on/)
})

test('the effort default follows the per-model setting', { options: {} }, async ($, on) => {
  world(on, { settings: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5[1m]', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections.find((s: { id: string }) => s.id === 'toolkit:effort')!.text).toMatch(/The default is `medium`/)
})

test('the budget rules keep the configured default after Claude sets a budget', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await start($, 500000)
  const { sections } = await compose($, ['Agent'])
  expect(sections.find((s: { id: string }) => s.id === 'toolkit:context').text).toMatch(/\(default 300k;/)
})

test("after a /clear the new conversation keeps neither the old task's handoff nor its budget", async ($, on) => {
  const session = world(on)
  await start($, 120000)
  await $.tool.call({ tool: budgetTool, reason: 'x', handoff: '/proj/handoffs/old-task.md' } as never)
  await $.session.end({ reason: 'clear', sessionId: sid, resume: {} } as never)
  sid = '11111111-2222-3333-4444-555555555555'
  await turnStart($, 't5')
  ctxNow = 130000 // past the old budget, under the 300k default
  await $.session.measure(measure(10) as never)
  await $.session.compact({ trigger: 'auto', messages: summary } as never)
  expect(texts(session.appended()).some(t => /old-task\.md|Context budget:/.test(t))).toBe(false)
  const answer = JSON.stringify(await $.tool.call({ tool: budgetTool, reason: 'new task', compact: true } as never))
  expect(answer).toMatch(/No handoff file is named yet/)
})

test("after a reload, another session's budget and handoff are not taken over", async ($, on) => {
  const session = world(on)
  const kept: Record<string, unknown> = {
    context: { sessionId: 'old-session', budget: 120000, isSet: true, step: 0 },
    guard: { sessionId: 'old-session', warned: [], taskHandoff: '/proj/handoffs/old-task.md' },
  }
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: kept[e.key], version: 1 } }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await turnStart($, 't1')
  ctxNow = 130000
  await $.session.measure(measure(10) as never)
  await $.session.compact({ trigger: 'auto', messages: summary } as never)
  expect(texts(session.appended()).some(t => /old-task\.md|Context budget:/.test(t))).toBe(false)
})

test('after a reload, a budget Claude never set follows the settings', { options: { contextBudget: 500000 } }, async ($, on) => {
  const session = world(on)
  const kept: Record<string, unknown> = { context: { sessionId: SID, budget: 300000, isSet: false, step: 0 } }
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: kept[e.key], version: 1 } }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await turnStart($, 't1')
  ctxNow = 280000 // past 90 % of the old 300k, not of the new 500k
  await $.session.measure(measure(10) as never)
  expect(texts(session.appended()).some(t => /Context budget:/.test(t))).toBe(false)
})

test('an interrupted turn keeps the compaction Claude asked for, but the task no longer resumes by itself', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await $.turn.complete({ answer: '', reason: 'aborted', durationMs: 1, isAborted: true, turnId: 't1' } as never)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: the turn that asked for the compaction was interrupted/)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
  await turnStart($) // the user's message
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(submitted.length).toBe(0)
})

test("a budget above Claude Code's own compaction point: the notes count against that point", async ($, on) => {
  const { session } = budgetWorld(on)
  winNow = 200000
  compactAt = 167000
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never) // the default budget, 300k
  ctxNow = 140000
  await $.session.measure(measure(10) as never)
  expect(texts(session.appended()).filter(t => /Context budget:/.test(t)).length).toBe(0)
  ctxNow = 152000
  await $.session.measure(measure(10) as never)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: 152k of 167k\. Claude Code compacts on its own at 167k, below the budget of 300k/)
})

test('without a compaction point, the model window caps the budget the notes count against; a model switch starts them over', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 500000)
  ctxNow = 185000
  await $.session.measure(measure(10) as never)
  expect(texts(session.appended()).filter(t => /Context budget:/.test(t)).length).toBe(0)
  winNow = 200000 // /model to a 200k model
  await $.session.measure(measure(10) as never)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: 185k of 200k\./)
})

test('a new task with handoff "none": the guard no longer names the previous task file; raising the budget keeps it', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 200000)
  await $.tool.call({ tool: budgetTool, reason: 'task 1', handoff: '/proj/handoffs/task1.md' } as never)
  await $.tool.call({ tool: budgetTool, tokens: 300000, reason: 'task 1 needs more' } as never) // no handoff: kept
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toMatch(/Read the handoff file \/proj\/handoffs\/task1\.md/)

  const r = JSON.stringify(await $.tool.call({ tool: budgetTool, tokens: 200000, reason: 'new task: small fix', handoff: 'none' } as never))
  expect(r).toMatch(/no handoff file; the previous one is no longer pointed to/)
  await $.session.measure(measure(91) as never)
  const wrap = texts(session.appended()).filter(t => /^main: Usage guard: 5-hour/.test(t))
  expect(wrap[0]).not.toMatch(/task1\.md/)
  expect(wrap[0]).toMatch(/\/proj\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-abcdef12\.md/) // a new draft for the new task
})

test('handoff "none" also drops the session\'s earlier draft: a compaction then names no file', async ($, on) => {
  const { session } = budgetWorld(on)
  await start($, 200000)
  await $.session.measure(measure(91) as never) // the first warning: a draft for task 1
  const draft = [...files.keys()].find(p => p.startsWith('/proj/handoffs/'))!
  expect(draft).toBeDefined()
  await $.tool.call({ tool: budgetTool, reason: 'new task', handoff: 'none' } as never)
  const before = session.appended().length
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).slice(before).filter(t => /handoff file/.test(t))).toEqual([])
})

test('at the stop stage, compact with carryOn says the user is waited for', async ($, on) => {
  const { submitted } = budgetWorld(on)
  await start($, 200000)
  await $.session.measure(measure(96) as never)
  ctxNow = 185000
  const r = JSON.stringify(await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never))
  expect(r).toMatch(/usage guard is at its stop stage, so the task doesn't resume by itself/)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/^Compaction Claude asked for at 185k of the 200k context budget\./)
  expect(submitted.length).toBe(0)
})

test("a notification that starts a turn first (an agent done, a schedule) is not the user: the compaction runs at that turn's end and the task still resumes", async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await $.prompt.submit({ text: '<task-notification>agent done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await turnStart($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: .*a notification .* started a new turn first\..*the task then resumes by itself/)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at \d+k of the 200k context budget/)
  expect(submitted.filter(t => /^Continue the task/.test(t)).length).toBe(1)
})

test('a message the user typed still moves the compaction and stops the task from resuming by itself', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await $.prompt.submit({ text: '<task-notification>agent done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: 'wait, one more thing', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'wait, one more thing', turnId: 't2' } as never)
  await clock.advance(1000)
  expect(texts(session.appended()).pop()).toMatch(/because a new turn \(the user's message\) started first/)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toMatch(/asked for at/)
  expect(submitted.filter(t => /^Continue the task/.test(t)).length).toBe(0)
})

// Two runs of the module, as across a reload: the first keeps what it wrote to $.state.
let beforeReload: Record<string, any> = {}
test('handoff "none", then a warning: a new draft for the new task (before a reload)', async ($, on) => {
  budgetWorld(on)
  beforeReload = {}
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => ((beforeReload[e.key] = e.value), { value: { isSet: true, version: 1 } }))
  files.set('/proj/handoffs/2026-10-22-0900-abcdef12.md', '# the task before')
  await start($, 200000)
  await $.tool.call({ tool: budgetTool, reason: 'new task', handoff: 'none' } as never)
  await $.session.measure(measure(91) as never)
  beforeReload.files = [...files.keys()].filter(p => p.startsWith('/proj/handoffs/')).sort()
  expect(beforeReload.files.length).toBe(2)
})

test('after a reload, the new task\'s draft goes on: no third file, and the compaction names it', async ($, on) => {
  const { session } = budgetWorld(on)
  for (const f of beforeReload.files) files.set(f, '# draft')
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: beforeReload[e.key], version: 1 } }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await $.session.measure(measure(96) as never)
  const draft = beforeReload.files.find((f: string) => !f.includes('-0900-'))
  expect(texts(session.appended()).find(t => /^main: .*stop at 95%/.test(t))).toContain(draft)
  expect([...files.keys()].filter(p => p.startsWith('/proj/handoffs/')).length).toBe(2)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(texts(session.appended()).pop()).toContain(draft)
})

test('with the guard off, the compaction still points at the handoff named to ContextBudget', { options: { guard: false } }, async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'done', handoff: '/proj/handoffs/task.md', compact: true, carryOn: true } as never)
  await turnEnd($)
  await clock.advance(1000)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: the conversation was just compacted\. Read the handoff file \/proj\/handoffs\/task\.md/)
  expect(submitted).toEqual([expect.stringMatching(/^Continue the task/)])
})

test("Claude Code's compaction point moving above the budget sends no second note", async ($, on) => {
  const { session } = budgetWorld(on)
  compactAt = 967000
  await start($, 200000)
  ctxNow = 185000
  await $.session.measure(measure(10) as never)
  compactAt = undefined // auto-compact off in /config: the window stands in
  await $.session.measure(measure(10) as never)
  compactAt = 967000
  await $.session.measure(measure(10) as never)
  expect(texts(session.appended()).filter(t => /Context budget: 185k/.test(t)).length).toBe(1)
})

test("a message of the user's delivered into the turn was answered there: a notification's turn after it is still not the user's", async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  await $.prompt.submit({ text: '114.6 ok', origin: { kind: 'composer' }, turnId: 't0' } as never) // delivered into t0
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await $.prompt.submit({ text: '<task-notification>agent done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.turn.start({ text: '<task-notification>agent done</task-notification>', turnId: 't2' } as never)
  await clock.advance(1000)
  expect(texts(session.appended()).pop()).toMatch(/a notification .* started a new turn first\..*the task then resumes by itself/)
  await turnEnd($)
  await clock.advance(1000)
  expect(submitted.filter(t => /^Continue the task/.test(t)).length).toBe(1)
})

test("a slash command of the user's beside a notification still counts as the user stepping in", async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  await turnEnd($)
  await $.prompt.submit({ text: '<task-notification>agent done</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: '/idea a new spell', command: { name: 'idea', args: 'a new spell' }, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Note the idea: a new spell', turnId: 't2' } as never)
  await clock.advance(1000)
  expect(texts(session.appended()).pop()).toMatch(/because a new turn \(the user's message\) started first/)
  await turnEnd($)
  await clock.advance(1000)
  expect(submitted.filter(t => /^Continue the task/.test(t)).length).toBe(0)
})

test('a vetoed compaction is said to Claude once, with the reason; the task does not resume by itself', async ($, on) => {
  const { session, submitted } = budgetWorld(on)
  await start($, 200000)
  ctxNow = 185000
  await $.tool.call({ tool: budgetTool, reason: 'handoff done', compact: true, carryOn: true } as never)
  vetoCompact = true
  await turnEnd($)
  await clock.advance(1000)
  expect(submitted.length).toBe(0)
  expect(texts(session.appended()).pop()).toMatch(/^main: Context budget: the compaction you asked for could not run \(a PreCompact hook blocked it\)/)
  await turnStart($)
  await turnEnd($)
  await clock.advance(1000)
  expect(compactedWith).toBe(undefined)
})

test('the budget rules read sensibly with a cap below 500k', { options: { contextCap: 400000 } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const text = (await compose($, ['Agent', budgetTool])).sections.find((s: { id: string }) => s.id === 'toolkit:context').text
  expect(text).toMatch(/  - 400k: complex work/)
  expect(text).not.toMatch(/500k-400k/)
})

// The account's usage endpoint, as the poll fetches it: `usageNow` answers, `fetches` counts.
const pollWorld = (on: any) => {
  const { session, submitted } = budgetWorld(on)
  const usage = { now: 50, status: 200, fetches: 0, auth: 'bearer' as string | null }
  on('session.authorize', () => ({ value: usage.auth ? { handle: 'h1', kind: usage.auth } : null }))
  on('http.fetch', (_: unknown, e: { url: string; init?: { auth?: string } }) => {
    usage.fetches++
    expect(e.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(e.init?.auth).toBe('h1')
    const text = JSON.stringify({ five_hour: { utilization: usage.now, resets_at: '2026-10-22T15:40:00.119842+00:00' }, seven_day: { utilization: 20, resets_at: '2026-10-25T13:00:00+00:00' } })
    return { value: { status: usage.status, ok: usage.status === 200, headers: {}, text } }
  })
  return { session, submitted, usage }
}
const statusRow = () => String(files.get('/home/t/.claude/toolkit.tsv')).split('\n').find(r => r.startsWith(SID)) ?? ''
const TWO = [AGENT_1, { id: 'agent-2', description: 'fix glass', type: 'general-purpose', status: 'running' }]

test('the usage is fetched every 30 s while work runs, every 5 minutes when idle, and shows how fast it rises', async ($, on) => {
  const { usage } = pollWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never) // the main chat works, agent-1 runs
  await clock.advance(30_000)
  expect(usage.fetches).toBe(1)
  expect(statusRow()).toMatch(/5h 50% \(resets/)
  expect(statusRow()).toMatch(/week 20%/)
  usage.now = 53
  await clock.advance(180_000) // 6 more fetches; 3 points in 3 minutes
  expect(usage.fetches).toBe(7)
  expect(statusRow()).toMatch(/5h 53% \+1\.0\/min/)

  await turnEnd($)
  agentsNow = [] // idle: the next fetch waits for 5 minutes after the last
  await clock.advance(240_000)
  expect(usage.fetches).toBe(7)
  await clock.advance(90_000)
  expect(usage.fetches).toBe(8)
})

test('a fresh reading wakes the idle main chat with its guard note, without any request of its own', async ($, on) => {
  const { usage, submitted } = pollWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await turnEnd($) // main waits for agent-1, whose build makes no requests
  usage.now = 91
  await clock.advance(30_000)
  expect(submitted.filter(t => /^Usage guard: 5-hour limit at 91% \(careful mode at 90%/.test(t)).length).toBe(1)
})

test('with two agents running, main is told to keep one before the stop is due; once per 5 points', async ($, on) => {
  const { usage, submitted } = pollWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await turnEnd($)
  agentsNow = TWO
  usage.now = 60
  await clock.advance(30_000)
  usage.now = 62
  await clock.advance(120_000) // 1 %/min: the stop at 95 % is 33 min away
  expect(submitted.some(t => /keep only|only one agent/.test(t))).toBe(false)
  usage.now = 70
  await clock.advance(60_000) // 10 points in 3.5 min: about 7 min to the stop
  const notes = submitted.filter(t => /Let only one agent go on/.test(t))
  expect(notes.length).toBe(1)
  expect(notes[0]).toMatch(/^Usage guard: 5-hour limit at 70%, rising [\d.]+%\/min, with 2 agents running \(the stop at 95% in about \d+ min\)/)
  expect(notes[0]).toMatch(/Running: build docs \(agent-1\); fix glass \(agent-2\)\./)
  await clock.advance(30_000)
  expect(submitted.filter(t => /Let only one agent go on/.test(t)).length).toBe(1)
  usage.now = 75
  await clock.advance(30_000)
  expect(submitted.filter(t => /Let only one agent go on/.test(t)).length).toBe(2)

  agentsNow = [AGENT_1] // main stopped the other one
  usage.now = 80
  await clock.advance(30_000)
  expect(submitted.filter(t => /Let only one agent go on/.test(t)).length).toBe(2)
})

test('at the one-agent stage two agents bring the note even when usage rises slowly', async ($, on) => {
  const { usage, submitted } = pollWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await turnEnd($)
  agentsNow = TWO
  usage.now = 76
  await clock.advance(30_000)
  expect(submitted.filter(t => /Let only one agent go on/.test(t)).length).toBe(1)
  expect(submitted.filter(t => /^Usage guard: 5-hour limit at 76% \(one agent at a time from 75%, careful mode at 90%/.test(t)).length).toBe(1)
})

test('narrowAgents off: no note to keep one agent', { options: { narrowAgents: false } }, async ($, on) => {
  const { usage, submitted } = pollWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await turnEnd($)
  agentsNow = TWO
  usage.now = 86
  await clock.advance(30_000)
  expect(submitted.some(t => /Let only one agent go on/.test(t))).toBe(false)
})

test('a failed fetch backs off; usagePoll 0 or an API key fetches nothing', { options: { usagePoll: 0 } }, async ($, on) => {
  const { usage } = pollWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await clock.advance(600_000)
  expect(usage.fetches).toBe(0)
})

test('an API key fetches nothing; a failed fetch waits longer each time', async ($, on) => {
  const { usage } = pollWorld(on)
  usage.status = 429
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await clock.advance(30_000)
  expect(usage.fetches).toBe(1)
  await clock.advance(30_000) // waits 60 s
  expect(usage.fetches).toBe(1)
  await clock.advance(30_000)
  expect(usage.fetches).toBe(2)
  await clock.advance(90_000) // waits 120 s
  expect(usage.fetches).toBe(2)
  await clock.advance(30_000)
  expect(usage.fetches).toBe(3)
})

test('the one-agent stage: a note for main only, no draft, and the status line names the mode', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(76) as never)
  const notes = texts(session.appended())
  expect(notes.length).toBe(1)
  expect(notes[0]).toMatch(/^main: Usage guard: 5-hour limit at 76% \(one agent at a time from 75%, careful mode at 90%, resets .*\)\. Work on as usual, but with at most one agent at a time/)
  expect([...files.keys()].some(p => p.startsWith('/proj/handoffs/'))).toBe(false)
  expect(statusRow()).toMatch(/\| guard: one agent \(5h\)$/)

  await $.session.measure(measure(91) as never)
  expect(statusRow()).toMatch(/\| guard: careful \(5h\)$/)
  expect([...files.keys()].some(p => p.startsWith('/proj/handoffs/'))).toBe(true) // careful mode brings the draft
})

test('from the one-agent stage on, a second agent is refused; at the stop stage every new one', async ($, on) => {
  const prompts = spawnWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(70) as never)
  expect((await $.agent.spawn({ prompt: 'A.', description: 'a' })).deny).toBeUndefined() // below the stage

  await $.session.measure(measure(76) as never)
  const r = await $.agent.spawn({ prompt: 'B.', description: 'b' })
  expect(r.deny).toMatch(/^Usage guard: the 5-hour limit is at 76% \(one agent at a time from 75%\), and build docs \(agent-1\) still runs\. Do this work yourself/)
  expect(prompts).toEqual(['A.'])

  agentsNow = [] // the running one is done
  expect((await $.agent.spawn({ prompt: 'C.', description: 'c' })).deny).toBeUndefined()

  await $.session.measure(measure(96) as never)
  expect((await $.agent.spawn({ prompt: 'D.', description: 'd' })).deny).toMatch(/\(stop stage\): start no new agents/)
  expect(prompts).toEqual(['A.', 'C.'])
})

test('guard off: no agent is refused', { options: { guard: false } }, async ($, on) => {
  spawnWorld(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(96) as never)
  expect((await $.agent.spawn({ prompt: 'A.', description: 'a' })).deny).toBeUndefined()
})

test('in careful mode the stop comes early when, at the current rate, it is due within stopLead minutes', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(88) as never)
  await clock.advance(120_000)
  await $.session.measure(measure(91) as never) // 1.5 %/min: the stop at 95 % in under 3 min
  const notes = texts(session.appended()).filter(t => t.startsWith('main: Usage guard'))
  expect(notes.pop()).toMatch(/^main: Usage guard: 5-hour limit at 91% \(stop at 95%, due in about 3 min at \+1\.5%\/min, resets .*\)\. Start no new work/)
})

test('stopLead 0: careful mode goes on until the stop %', { options: { stopLead: 0 } }, async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  await $.session.measure(measure(88) as never)
  await clock.advance(120_000)
  await $.session.measure(measure(91) as never)
  expect(texts(session.appended()).some(t => /stop at 95%, due in/.test(t))).toBe(false)
  expect(texts(session.appended()).some(t => /^main: .*\(careful mode at 90%, stop at 95%/.test(t))).toBe(true)
})

test('the week: one agent and careful mode start together at 90, the stop is at 98', async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  const week = (percentUsed: number) =>
    ({ context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed, resetsAt: '2026-10-25T13:00:00Z' }], changed: ['rateLimits'] }) as never
  await $.session.measure(week(89))
  expect(session.appended().length).toBe(0)
  await $.session.measure(week(90))
  const main = texts(session.appended()).filter(t => t.startsWith('main:'))
  expect(main.length).toBe(1)
  expect(main[0]).toMatch(/^main: Usage guard: weekly limit at 90% \(careful mode at 90%, stop at 98%/)
  await $.session.measure(week(97))
  expect(texts(session.appended()).some(t => /stop at 98%/.test(t) && /Start no new work/.test(t))).toBe(false)
  await $.session.measure(week(98))
  expect(texts(session.appended()).some(t => /^main: .*\(stop at 98%.*Start no new work/.test(t))).toBe(true)
})

test('old wrap-up settings are ignored; one-agent above careful falls back with a notice', { options: { fiveHourWrapUp: 60, fiveHourOneAgent: 92 } }, async ($, on) => {
  const session = world(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't0' } as never)
  expect(session.appended().filter(r => r.message.type === 'system').length).toBe(1)
  await $.session.measure(measure(76) as never)
  expect(texts(session.appended()).some(t => /one agent at a time from 75%/.test(t))).toBe(true)
})
