// Usage refresh: Claude Code reads the limits only from its own API responses, so they stand still
// while the session makes no requests (agents in long builds, the main chat waiting) and miss what
// other sessions on the same account use. Every `usagePoll` seconds while work runs here (every five
// minutes when idle) the account's usage is fetched with the session's own login: the engine sets
// the credential header, the plugin never sees the token. Off for an API key or a 3P provider.
import type { EngineInterface, Timer } from 'claude-code'

import type { Window } from './guard'

const URL = 'https://api.anthropic.com/api/oauth/usage'
const IDLE_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 10 * 60 * 1000
const KINDS = ['five_hour', 'seven_day']

let timer: Timer | undefined
let last = 0 // the last fetch started, in clock ms
let wait = 0 // after a failed fetch: how long until the next one
let off = false // no first-party login: nothing to fetch with
let running = false

type Reading = { utilization?: unknown; resets_at?: unknown }

// The windows of one answer, in the engine's shape (resetsAt as toISOString, like its own readings).
export function parse(text: string): Window[] | undefined {
  let body: Record<string, Reading | null>
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const windows: Window[] = []
  for (const kind of KINDS) {
    const r = body?.[kind]
    if (!r || typeof r.utilization !== 'number') continue
    const at = typeof r.resets_at === 'string' ? new Date(r.resets_at) : undefined
    windows.push({ kind, percentUsed: r.utilization, ...(at && !isNaN(at.getTime()) ? { resetsAt: at.toISOString() } : {}) })
  }
  return windows.length ? windows : undefined
}

async function fetchUsage($: EngineInterface): Promise<Window[] | undefined> {
  const auth = await $.session.authorize().catch(() => null)
  if (!auth || auth.kind !== 'bearer') {
    off = true
    return undefined
  }
  const r = await $.http.fetch(URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
  return r.ok ? parse(r.text) : undefined
}

// Starts the timer (again after a reload, whose module starts over). `isBusy` says whether the main
// chat or an agent is working; `onReading` takes each fresh reading.
export function startPoll(
  $: EngineInterface,
  seconds: number,
  isBusy: () => Promise<boolean>,
  onReading: (w: Window[]) => Promise<void>,
) {
  timer?.cancel()
  timer = undefined
  if (!seconds) return
  const tick = async () => {
    if (off || running) return
    const now = await $.clock.now()
    if (wait ? now - last < wait : now - last < IDLE_MS && !(await isBusy())) return
    running = true
    last = now
    try {
      const windows = await fetchUsage($)
      if (windows) {
        wait = 0
        await onReading(windows)
      } else if (!off) wait = Math.min(Math.max(wait * 2, seconds * 2000), MAX_BACKOFF_MS)
    } catch {
      wait = Math.min(Math.max(wait * 2, seconds * 2000), MAX_BACKOFF_MS)
    } finally {
      running = false
    }
  }
  timer = $.clock.every(seconds * 1000, () => void tick())
}
