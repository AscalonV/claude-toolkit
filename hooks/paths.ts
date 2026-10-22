// Home and Claude config folders, with forward slashes so they work in commands on every OS.
import type { EngineInterface } from 'claude-code'

export const slash = (p: string) => p.replace(/\\/g, '/')

export async function homeDir($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? slash(home) : undefined
}

// ~/.claude, or CLAUDE_CONFIG_DIR.
export async function configDir($: EngineInterface) {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return slash(dir)
  const home = await homeDir($)
  return home ? `${home}/.claude` : undefined
}
