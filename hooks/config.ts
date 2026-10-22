// The usage guard's settings: the manifest's userConfig values, checked, with defaults.
import type { PluginOptions } from 'claude-code'

export type Stage = 'wrapUp' | 'stop'

export type Config = {
  guard: boolean
  agentNotes: boolean
  handoffFile: boolean
  handoffFolder: string
  outsideProjectFolder: string
  extraNote: string
  thresholds: Record<'five_hour' | 'seven_day', Record<Stage, number>>
}

export const DEFAULTS: Config = {
  guard: true,
  agentNotes: true,
  handoffFile: true,
  handoffFolder: 'handoffs',
  outsideProjectFolder: 'handoffs',
  extraNote: '',
  thresholds: {
    five_hour: { wrapUp: 85, stop: 90 },
    seven_day: { wrapUp: 90, stop: 97 },
  },
}

const flag = (v: unknown, fallback: boolean, key: string, bad: string[]) => {
  if (v === undefined) return fallback
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'false') return v === 'true'
  bad.push(key)
  return fallback
}

const percent = (v: unknown, fallback: number, key: string, bad: string[]) => {
  if (v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isFinite(n) && n > 0 && n <= 100) return n
  bad.push(key)
  return fallback
}

// Returns the settings and the names of the ones that fell back to their defaults.
export function readConfig(options: PluginOptions): { config: Config; bad: string[] } {
  const bad: string[] = []
  const t = DEFAULTS.thresholds
  const pair = (kind: 'five_hour' | 'seven_day', prefix: string) => {
    const wrapUp = percent(options[`${prefix}WrapUp`], t[kind].wrapUp, `${prefix}WrapUp`, bad)
    const stop = percent(options[`${prefix}Stop`], t[kind].stop, `${prefix}Stop`, bad)
    if (wrapUp < stop) return { wrapUp, stop }
    bad.push(`${prefix}WrapUp/${prefix}Stop (wrap-up must be below stop)`)
    return { ...t[kind] }
  }
  const folder = (key: 'handoffFolder' | 'outsideProjectFolder') => {
    const v = options[key]
    if (typeof v === 'string' && v.trim() && !/[\0\r\n]/.test(v)) return v.trim()
    if (v !== undefined) bad.push(key)
    return DEFAULTS[key]
  }
  const extra = options.extraNote
  return {
    config: {
      guard: flag(options.guard, DEFAULTS.guard, 'guard', bad),
      agentNotes: flag(options.agentNotes, DEFAULTS.agentNotes, 'agentNotes', bad),
      handoffFile: flag(options.handoffFile, DEFAULTS.handoffFile, 'handoffFile', bad),
      handoffFolder: folder('handoffFolder'),
      outsideProjectFolder: folder('outsideProjectFolder'),
      extraNote: typeof extra === 'string' ? extra.trim() : DEFAULTS.extraNote,
      thresholds: { five_hour: pair('five_hour', 'fiveHour'), seven_day: pair('seven_day', 'weekly') },
    },
    bad,
  }
}
