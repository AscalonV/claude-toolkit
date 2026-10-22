// Status line: Alex | high | ctx 95k | 5h 42% (resets 15:30) | week 18% (resets Fri 09:00)
//
// Plugins can't draw in the status line row, and Claude Code ignores a statusLine a plugin
// answers through settings.read. So on first start this adds a `statusLine` command to
// ~/.claude/settings.json (only where none is set), and keeps every running session's line in
// one small file, `toolkit.tsv`: session id, last write, line. The command picks
// its session's row by the session_id Claude Code pipes to it.
//
// The same usage numbers drive the usage guard (guard.ts); effort.ts adds the effort rules,
// agents.ts the project's rules for subagents and the optional rule to start agents unasked,
// context.ts the per-task context budget.
import type { EngineInterface, Register } from 'claude-code'

import { agentRules, agentUseRules, withRules } from './agents'
import { readConfig } from './config'
import {
  TOOL,
  afterCompaction,
  afterTurn,
  beforeRequest,
  compacting,
  currentBudget,
  rules as budgetRules,
  duringCompaction,
  measureLimit,
  promptSubmitted,
  resetBudget,
  restoreBudget,
  setBudget,
  setFromTool,
  setInteractive,
  toolSpec,
  turnAborted,
  turnEnded,
  turnStarted,
} from './context'
import { defaultLevel, effortRules } from './effort'
import { configDir, homeDir } from './paths'
import { afterCompact, atStop, check, checkAll, mainTurnStarted, resetGuard, restoreGuard, setConfig, setUsage } from './guard'
import type { Window } from './guard'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

let name: string | undefined
let accountId: string | undefined
let effort: string | undefined
let ctx: number | undefined
let limits: Window[] = []
// After a switch to another account (/login), the windows still standing may be the old
// account's: they are set aside until a fresh reading, one that moved or has new reset times.
let held: Window[] | undefined

function resetText(iso: string | undefined, withDay: boolean) {
  if (!iso) return ''
  const t = new Date(iso)
  if (isNaN(t.getTime())) return ''
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  return ` (resets ${withDay ? `${DAYS[t.getDay()]} ${hm}` : hm})`
}

function line() {
  const parts: string[] = []
  if (name) parts.push(name)
  if (effort) parts.push(effort)
  if (ctx) parts.push(`ctx ${Math.floor(ctx / 1000)}k${currentBudget() ? `/${Math.round(currentBudget() / 1000)}k` : ''}`)
  for (const [kind, label, withDay] of [['five_hour', '5h', false], ['seven_day', 'week', true]] as const) {
    const w = limits.find(l => l.kind === kind)
    if (w) parts.push(`${label} ${Math.round(w.percentUsed)}%${resetText(w.resetsAt, withDay)}`)
  }
  return parts.join(' | ')
}

// The account isn't exposed to plugins, so read it from the login record in .claude.json.
async function readAccount($: EngineInterface): Promise<{ name?: string; id?: string }> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await homeDir($)
  const path = dir ? `${dir}/.claude.json` : home ? `${home}/.claude.json` : undefined
  if (!path) return {}
  try {
    const acct = JSON.parse(await $.fs.read(path)).oauthAccount ?? {}
    return { name: acct.displayName || acct.emailAddress || undefined, id: acct.accountUuid }
  } catch {
    return {}
  }
}

const resetKeys = (w: Window[]) => w.map(l => `${l.kind}@${l.resetsAt?.slice(0, 16)}`).sort().join()

// Takes a reading: notes an account switch, and keeps only windows that are current.
async function takeReading($: EngineInterface, next: Window[], isFresh: boolean) {
  const acct = await readAccount($)
  if (accountId && acct.id && acct.id !== accountId) held = limits
  accountId = acct.id ?? accountId
  name = acct.name ?? name
  if (held && (isFresh || (held.length > 0 && resetKeys(next) !== resetKeys(held)))) held = undefined
  const now = await $.clock.now()
  // A window whose reset time has passed is stale too.
  limits = held ? [] : next.filter(l => !l.resetsAt || Date.parse(l.resetsAt) > now)
  setUsage(limits, name)
}

// One row per running session; a row not written for this long belongs to a session that ended.
const STALE_MS = 12 * 60 * 60 * 1000
const TABLE = 'toolkit.tsv'
// Before the plugin was renamed from account-statusline; its statusLine is replaced.
const OLD_TABLE = 'account-statusline.tsv'

const draw = async ($: EngineInterface) => {
  const base = await configDir($)
  if (!base) return
  const file = `${base}/${TABLE}`
  const id = await $.session.id()
  const now = await $.clock.now()
  let rows: string[] = []
  try {
    rows = (await $.fs.read(file)).split('\n')
  } catch {}
  const kept = rows.filter(row => {
    const [rowId, at] = row.split('\t')
    return rowId && rowId !== id && now - Number(at) < STALE_MS
  })
  await $.fs.write(file, [...kept, `${id}\t${now}\t${line()}`].join('\n') + '\n')
}

// The command reads the session_id from the JSON on stdin and prints that session's line.
// It runs in Git Bash on Windows and sh elsewhere. Without an id it prints nothing (an empty
// pattern would match another session's row).
const command = (file: string) =>
  `id=$(grep -o '"session_id": *"[^"]*"' | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); ` +
  `[ -z "$id" ] || grep -F "$id" "${file}" | head -1 | cut -f3`

// Adds the statusLine to the user's settings.json once, unless any settings already have one.
// Our own line from an earlier version (or from before the rename) is brought up to date.
async function install($: EngineInterface) {
  const base = await configDir($)
  if (!base) return
  const wanted = command(`${base}/${TABLE}`)
  const current = (await $.settings.read({ key: 'statusLine' })) as { command?: unknown } | undefined
  const was = String(current?.command ?? '')
  const isOurs = was.includes(OLD_TABLE) || was.includes(`"${base}/${TABLE}"`)
  if (current && (!isOurs || was === wanted)) return
  const path = `${base}/settings.json`
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(await $.fs.read(path))
  } catch (err) {
    if (await $.fs.exists(path)) return // unreadable: leave the person's file alone
  }
  // Ours, but set in another settings file: that one isn't ours to change.
  if (current && String((settings.statusLine as { command?: unknown } | undefined)?.command ?? '') !== was) return
  settings.statusLine = { type: 'command', command: wanted }
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
}

// Name, effort and any usage already known, loaded once.
let loading: Promise<void> | undefined
const load = ($: EngineInterface) =>
  (loading ??= (async () => {
    const acct = await readAccount($)
    name = acct.name
    accountId = acct.id
    effort ??= await defaultLevel($)
    const usage = await $.session.usage()
    ctx ??= usage.context.tokens
    if (!limits.length) await takeReading($, usage.rateLimits, false)
    await draw($)
    await install($)
  })())

export const register: Register = (on, options) => {
  const { config, bad } = readConfig(options)
  setConfig(config)
  setBudget(config.contextBudget, config.contextCap)

  on('session.start', async ($, e, next) => {
    // A hot reload starts the module over: what Claude set and the guard sent are in $.state.
    setInteractive(e.isInteractive)
    await restoreGuard($)
    await restoreBudget($)
    await load($)
    if (config.contextBudget) await measureLimit($)
    if (config.contextBudget) await $.tool.register(toolSpec)
    if (bad.length) {
      const text = `${$.plugin.name}: invalid setting ${bad.join(', ')}; using the default.`
      await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text))
    }
    return next(e)
  })

  // A main turn: a compaction still waiting for its slot moves to this turn's end; the guard's
  // notes for the main chat start with its first turn.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      mainTurnStarted()
      await turnStarted($)
      await check($)
    }
    return next(e)
  })

  // A message of the user's while a compaction runs goes before the "continue" prompt; where the
  // prompt came from tells a turn the user started from a notification's.
  on('prompt.submit', async ($, e, next) => {
    promptSubmitted(e)
    return next(duringCompaction(e))
  })

  // turn.step streams, so its hook is an async generator that forwards the stream.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) mainTurnStarted()
    if (e.effort !== undefined && !e.agentId) {
      effort = String(e.effort)
      await draw($)
    }
    await check($, e.agentId) // an agent started after a warning gets its own note here
    if (!e.agentId) await beforeRequest($) // past 90 % of the budget, Claude must decide, also mid-turn
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    ctx = e.context.tokens
    await takeReading($, e.rateLimits, e.changed.includes('rateLimits'))
    await draw($)
    await checkAll($)
    if (config.contextBudget) await measureLimit($) // a model switch moves Claude Code's own compaction
    await beforeRequest($) // the context changed (after a turn)
    return next(e)
  })

  // The ContextBudget tool: the main chat only.
  on('tool.call', { tool: `mcp__toolkit__${TOOL}` }, async ($, e) => {
    if (e.agentId) return { deny: "The context budget is the main conversation's; agents have their own window." }
    const result = await setFromTool($, e as unknown as Record<string, unknown>)
    await draw($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) turnEnded()
    if (!e.agentId && e.isAborted) await turnAborted($)
    if (!e.agentId && !e.isAborted) await afterTurn($, !atStop())
    return result
  })

  // A /clear or a resume goes on in this process under another session id, with no session.start:
  // the budget, a request and the task's handoff belonged to the conversation before.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      resetBudget()
      resetGuard()
    }
    return next(e)
  })

  // A new subagent gets the project's agent rules at the end of its prompt.
  on('agent.spawn', async ($, e, next) => {
    if (!config.agentRules || e.resume) return next(e)
    const rules = await agentRules($, e.cwd).catch(() => undefined)
    return next(rules ? { ...e, prompt: withRules(e.prompt, rules) } : e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = [...result.sections]
    if (config.effortRules) {
      sections.push({ id: `${$.plugin.name}:effort`, text: await effortRules($, config.agentUse, e.model), scope: 'session' as const })
    }
    // Only where the model can start agents: the main chat, not the agents themselves.
    if (config.agentUse && e.tools.includes('Agent')) {
      sections.push({ id: `${$.plugin.name}:agents`, text: agentUseRules(), scope: 'session' as const })
    }
    if (config.contextBudget && e.tools.includes('Agent')) {
      sections.push({ id: `${$.plugin.name}:context`, text: budgetRules(), scope: 'session' as const })
    }
    return { sections }
  })

  // A precompute only prepares a summary for later: the conversation stays as it is. The plugin's
  // own compaction (should this hook hear it) is followed up where it is made.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !compacting() && result.messages) {
      await afterCompaction($)
      await afterCompact($)
    }
    return result
  })
}
