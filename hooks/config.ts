// The plugin's settings: the manifest's userConfig values, checked, with defaults.
import type { PluginOptions } from 'claude-code'

// The usage guard's stages, lowest first: one agent at a time, careful mode, stop.
export type Stage = 'oneAgent' | 'careful' | 'stop'
export const STAGES: Stage[] = ['oneAgent', 'careful', 'stop']

export type Config = {
  effortRules: boolean
  usageLine: boolean
  guard: boolean
  agentNotes: boolean
  narrowAgents: boolean
  narrowMinutes: number
  stopLead: number
  usagePoll: number
  handoffFile: boolean
  agentRules: boolean
  agentUse: boolean
  contextBudget: number
  contextCap: number
  handoffFolder: string
  outsideProjectFolder: string
  extraNote: string
  thresholds: Record<'five_hour' | 'seven_day', Record<Stage, number>>
}

export const DEFAULTS: Config = {
  effortRules: true,
  usageLine: true,
  guard: true,
  agentNotes: true,
  narrowAgents: true,
  narrowMinutes: 20,
  stopLead: 5,
  usagePoll: 30,
  handoffFile: true,
  agentRules: true,
  agentUse: false,
  contextBudget: 300000,
  contextCap: 800000,
  handoffFolder: 'handoffs',
  outsideProjectFolder: 'handoffs',
  extraNote: '',
  thresholds: {
    five_hour: { oneAgent: 75, careful: 90, stop: 95 },
    seven_day: { oneAgent: 90, careful: 90, stop: 98 },
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

// Tokens from 100000 to 1000000, or 0 where `isOff` allows it.
const tokens = (v: unknown, fallback: number, key: string, bad: string[], isOff = false) => {
  if (v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if ((isOff && n === 0) || (Number.isInteger(n) && n >= 100000 && n <= 1000000)) return n
  bad.push(key)
  return fallback
}

// Whole numbers from min to max, or 0 where `isOff` allows it.
const count = (v: unknown, fallback: number, key: string, bad: string[], min: number, max: number, isOff = false) => {
  if (v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if ((isOff && n === 0) || (Number.isInteger(n) && n >= min && n <= max)) return n
  bad.push(key)
  return fallback
}

// Returns the settings and the names of the ones that fell back to their defaults.
export function readConfig(options: PluginOptions): { config: Config; bad: string[] } {
  const bad: string[] = []
  const t = DEFAULTS.thresholds
  // One agent <= careful < stop: the one-agent stage may start with careful mode (the week's does).
  const triple = (kind: 'five_hour' | 'seven_day', prefix: string) => {
    const d = t[kind]
    const oneAgent = percent(options[`${prefix}OneAgent`], d.oneAgent, `${prefix}OneAgent`, bad)
    const careful = percent(options[`${prefix}Careful`], d.careful, `${prefix}Careful`, bad)
    const stop = percent(options[`${prefix}Stop`], d.stop, `${prefix}Stop`, bad)
    if (oneAgent <= careful && careful < stop) return { oneAgent, careful, stop }
    bad.push(`${prefix}OneAgent/${prefix}Careful/${prefix}Stop (one agent must not be above careful, careful must be below stop)`)
    return { ...d }
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
      effortRules: flag(options.effortRules, DEFAULTS.effortRules, 'effortRules', bad),
      usageLine: flag(options.usageLine, DEFAULTS.usageLine, 'usageLine', bad),
      guard: flag(options.guard, DEFAULTS.guard, 'guard', bad),
      agentNotes: flag(options.agentNotes, DEFAULTS.agentNotes, 'agentNotes', bad),
      narrowAgents: flag(options.narrowAgents, DEFAULTS.narrowAgents, 'narrowAgents', bad),
      narrowMinutes: count(options.narrowMinutes, DEFAULTS.narrowMinutes, 'narrowMinutes', bad, 1, 120),
      stopLead: count(options.stopLead, DEFAULTS.stopLead, 'stopLead', bad, 1, 60, true),
      usagePoll: count(options.usagePoll, DEFAULTS.usagePoll, 'usagePoll', bad, 10, 600, true),
      handoffFile: flag(options.handoffFile, DEFAULTS.handoffFile, 'handoffFile', bad),
      agentRules: flag(options.agentRules, DEFAULTS.agentRules, 'agentRules', bad),
      agentUse: flag(options.agentUse, DEFAULTS.agentUse, 'agentUse', bad),
      contextBudget: tokens(options.contextBudget, DEFAULTS.contextBudget, 'contextBudget', bad, true),
      contextCap: tokens(options.contextCap, DEFAULTS.contextCap, 'contextCap', bad),
      handoffFolder: folder('handoffFolder'),
      outsideProjectFolder: folder('outsideProjectFolder'),
      extraNote: typeof extra === 'string' ? extra.trim() : DEFAULTS.extraNote,
      thresholds: { five_hour: triple('five_hour', 'fiveHour'), seven_day: triple('seven_day', 'weekly') },
    },
    bad,
  }
}
