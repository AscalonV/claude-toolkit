// Status line: Alex | high | ctx 95k | 5h 42% (resets 15:30) | week 18% (resets Fri 09:00)
//
// Plugins can't draw in the status line row, and Claude Code ignores a statusLine a plugin
// answers through settings.read. So on first start this adds a `statusLine` command to
// ~/.claude/settings.json (only where none is set), and keeps every running session's line in
// one small file, `account-statusline.tsv`: session id, last write, line. The command picks
// its session's row by the session_id Claude Code pipes to it.
//
// The same usage numbers drive the usage guard (guard.ts).
import type { EngineInterface, Register } from 'claude-code'

import { readConfig } from './config'
import { configDir, homeDir } from './paths'
import { afterCompact, check, checkAll, setConfig, setUsage } from './guard'
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
  if (ctx) parts.push(`ctx ${Math.floor(ctx / 1000)}k`)
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
const TABLE = 'account-statusline.tsv'

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
// It runs in Git Bash on Windows and sh elsewhere.
const command = (file: string) =>
  `id=$(grep -o '"session_id": *"[^"]*"' | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); ` +
  `grep -F "$id" "${file}" | head -1 | cut -f3`

// Adds the statusLine to the user's settings.json once, unless any settings already have one.
async function install($: EngineInterface) {
  if (await $.settings.read({ key: 'statusLine' })) return
  const base = await configDir($)
  if (!base) return
  const path = `${base}/settings.json`
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(await $.fs.read(path))
  } catch (err) {
    if (await $.fs.exists(path)) return // unreadable: leave the person's file alone
  }
  settings.statusLine = { type: 'command', command: command(`${base}/${TABLE}`) }
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
}

// Name, effort and any usage already known, loaded once.
let loading: Promise<void> | undefined
const load = ($: EngineInterface) =>
  (loading ??= (async () => {
    $.ui.status(undefined) // clear the yellow notice an earlier version pinned
    const acct = await readAccount($)
    name = acct.name
    accountId = acct.id
    const level = await $.settings.read({ key: 'effortLevel' })
    if (typeof level === 'string') effort ??= level
    const usage = await $.session.usage()
    ctx ??= usage.context.tokens
    if (!limits.length) await takeReading($, usage.rateLimits, false)
    await draw($)
    await install($)
  })())

export const register: Register = (on, options) => {
  const { config, bad } = readConfig(options)
  setConfig(config)

  on('session.start', async ($, e, next) => {
    await load($)
    if (bad.length) {
      const text = `account-statusline: invalid setting ${bad.join(', ')}; using the default.`
      await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text))
    }
    return next(e)
  })

  // turn.step streams, so its hook is an async generator that forwards the stream.
  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined && !e.agentId) {
      effort = String(e.effort)
      await draw($)
    }
    await check($, e.agentId) // an agent started after a warning gets its own note here
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    ctx = e.context.tokens
    await takeReading($, e.rateLimits, e.changed.includes('rateLimits'))
    await draw($)
    await checkAll($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && result.messages) await afterCompact($)
    return result
  })
}
