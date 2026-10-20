import type { HudWeekly } from '../types'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export const USAGE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'jackok-state' }

type LimitEntry = {
  kind?: string
  group?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } } | null
}

/**
 * Per-model weekly windows out of the usage endpoint's body: `limits[]` entries
 * of group `weekly` with a model scope (`weekly_all` is the 7d figure
 * `session.measure` already pushes). No model name is hardcoded; a name seen
 * twice keeps its last entry.
 * Throws on a body that is not JSON.
 */
export const parseWeekly = (text: string): HudWeekly => {
  const body = JSON.parse(text) as { limits?: unknown }
  const limits = Array.isArray(body.limits) ? (body.limits as LimitEntry[]) : []
  const byName = new Map<string, { name: string; percent: number; resetsAt?: string }>()
  for (const l of limits) {
    const name = l.scope?.model?.display_name
    if (l.group !== 'weekly' || l.kind === 'weekly_all' || name === undefined) continue
    if (typeof l.percent !== 'number' || !Number.isFinite(l.percent)) continue
    byName.set(name.toLowerCase(), { name, percent: Math.round(Math.max(0, Math.min(100, l.percent))), resetsAt: l.resets_at })
  }
  return { models: [...byName.values()] }
}
