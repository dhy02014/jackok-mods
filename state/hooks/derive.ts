import type { HudGit, HudLimit, HudSnap } from '../types'
import { short } from './band'

// Pure derivations from engine values. No `$`: the callers in ./register.tsx fetch, these shape.

// Stored long; the row truncates it at the terminal's edge, so a command reads in full where it fits.
const TARGET_MAX = 200

export const targetOf = (e: Record<string, unknown>) => {
  const v = e.file_path ?? e.notebook_path ?? e.command ?? e.pattern ?? e.url ?? e.description
  if (typeof v !== 'string') return ''
  const last = /[\\/]/.test(v) && !v.includes(' ') ? (v.split(/[\\/]/).pop() ?? v) : v
  return short(last.replace(/\s+/g, ' '), TARGET_MAX)
}

export const toLimits = (rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): HudLimit[] =>
  rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt }))

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// A pull started before the last `session.measure` keeps the measured figures.
export const mergePulled = (pulled: HudSnap, cur: HudSnap | null, startedAt: number): HudSnap => {
  const measured = cur?.measuredAt
  return cur !== null && measured !== undefined && measured >= startedAt
    ? { ...pulled, ctxPercent: cur.ctxPercent, ctxTokens: cur.ctxTokens, limits: cur.limits, usd: cur.usd, measuredAt: measured }
    : { ...pulled, measuredAt: measured }
}

// `git status --porcelain=v2 --branch` output.
export const parseGitStatus = (stdout: string): HudGit => {
  // Git for Windows may end lines with \r\n.
  const lines = stdout.split(/\r?\n/).filter(l => l !== '')
  const head = lines.find(l => l.startsWith('# branch.head '))?.slice(14) ?? '?'
  const ab = /^# branch\.ab \+(\d+) -(\d+)\r?$/m.exec(stdout)
  return {
    branch: head,
    ahead: Number(ab?.[1] ?? 0),
    behind: Number(ab?.[2] ?? 0),
    changed: lines.filter(l => !l.startsWith('#')).length,
  }
}

const FRONTMATTER_EFFORT = /^effort:[ \t]*(?:"([^"]*)"|'([^']*)'|(\S+))[ \t]*$/m

// The `effort:` value in an agent definition's frontmatter.
export const frontmatterEffort = (fileText: string) => {
  const m = FRONTMATTER_EFFORT.exec(fileText.split(/^---$/m)[1] ?? '')
  return m?.[1] ?? m?.[2] ?? m?.[3]
}
