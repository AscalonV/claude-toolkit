// Status line: Alex | high | ctx 95k | 5h 42% (resets 15:30) | week 18% (resets Fri 09:00)
//
// Plugins can't draw in the status line row, and Claude Code ignores a statusLine a plugin
// answers through settings.read. So on first start this adds a `statusLine` command to
// ~/.claude/settings.json (only where none is set), and keeps every running session's line in
// one small file, `account-statusline.tsv`: session id, last write, line. The command picks
// its session's row by the session_id Claude Code pipes to it.
import type { EngineInterface, Register } from 'claude-code'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

let name: string | undefined
let effort: string | undefined
let ctx: number | undefined
let limits: { kind: string; percentUsed: number; resetsAt?: string }[] = []

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

// ~/.claude (or CLAUDE_CONFIG_DIR), with forward slashes so the path works in the status command.
async function configDir($: EngineInterface) {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const path = dir ?? (home ? `${home}/.claude` : undefined)
  return path?.replace(/\\/g, '/')
}

// The account isn't exposed to plugins, so read it from the login record in .claude.json.
async function readName($: EngineInterface) {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const path = dir ? `${dir}/.claude.json` : home ? `${home}/.claude.json` : undefined
  if (!path) return undefined
  try {
    const acct = JSON.parse(await $.fs.read(path)).oauthAccount ?? {}
    return acct.displayName || acct.emailAddress || undefined
  } catch {
    return undefined
  }
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
    name = await readName($)
    const level = await $.settings.read({ key: 'effortLevel' })
    if (typeof level === 'string') effort ??= level
    const usage = await $.session.usage()
    ctx ??= usage.context.tokens
    if (!limits.length) limits = usage.rateLimits
    await draw($)
    await install($)
  })())

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    return next(e)
  })

  // turn.step streams, so its hook is an async generator that forwards the stream.
  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined && !e.agentId) {
      effort = String(e.effort)
      await draw($)
    }
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    ctx = e.context.tokens
    limits = e.rateLimits
    await draw($)
    return next(e)
  })
}
