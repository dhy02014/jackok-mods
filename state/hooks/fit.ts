// Terminal-cell widths and the top line's width budget. Pure: no `$`.
//
// The engine truncates a Text whose wrap mode says so, but not one inside a Button: the
// cwd (a copy button) wrapped onto a second row instead. So the top line is sized here,
// before drawing: every part arrives already cut to the cells it is given.

const isWide = (c: number) =>
  (c >= 0x1100 && c <= 0x115f) ||
  (c >= 0x2e80 && c <= 0x303e) ||
  (c >= 0x3041 && c <= 0x33ff) ||
  (c >= 0x3400 && c <= 0x4dbf) ||
  (c >= 0x4e00 && c <= 0x9fff) ||
  (c >= 0xa000 && c <= 0xa4cf) ||
  (c >= 0xa960 && c <= 0xa97f) ||
  (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0xf900 && c <= 0xfaff) ||
  (c >= 0xfe30 && c <= 0xfe4f) ||
  (c >= 0xff00 && c <= 0xff60) ||
  (c >= 0xffe0 && c <= 0xffe6) ||
  (c >= 0x1f300 && c <= 0x1f64f) ||
  (c >= 0x1f900 && c <= 0x1f9ff) ||
  (c >= 0x20000 && c <= 0x3fffd)

const cellsOf = (ch: string) => (/^\p{M}$/u.test(ch) ? 0 : isWide(ch.codePointAt(0) ?? 0) ? 2 : 1)

/** Terminal cells, not UTF-16 units. */
export const cells = (s: string) => {
  let n = 0
  for (const ch of s) n += cellsOf(ch)
  return n
}

const ELLIPSIS = '…'

/** `s` in at most `max` cells, its end replaced by `…` when cut. */
export const truncateEnd = (s: string, max: number) => {
  if (cells(s) <= max) return s
  if (max <= 0) return ''
  let out = ''
  let n = 0
  for (const ch of s) {
    const w = cellsOf(ch)
    if (n + w > max - 1) break
    out += ch
    n += w
  }
  return out + ELLIPSIS
}

/** `s` in at most `max` cells, its start replaced by `…` when cut. */
export const truncateStart = (s: string, max: number) => {
  if (cells(s) <= max) return s
  if (max <= 0) return ''
  const chars = [...s]
  let out = ''
  let n = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] ?? ''
    const w = cellsOf(ch)
    if (n + w > max - 1) break
    out = ch + out
    n += w
  }
  return ELLIPSIS + out
}

export type Part = { width: number; weight: number }

// Shares `room` cells among parts: a part that fits its share keeps its whole width, and
// the parts too long for theirs are cut to a common level divided by their weight, so a
// heavier (less informative) part gives way first and a short one is never cut for a long
// one's sake. Whole cells; a remainder goes to the lightest uncut parts.
export const shareWidths = (parts: readonly Part[], room: number): number[] => {
  const free = Math.max(0, room)
  const widthsAt = (level: number) => parts.map(p => Math.min(p.width, Math.floor(level / Math.max(1, p.weight))))
  const sum = (ws: number[]) => ws.reduce((n, w) => n + w, 0)
  if (sum(parts.map(p => p.width)) <= free) return parts.map(p => p.width)
  let lo = 0
  let hi = Math.max(0, ...parts.map(p => p.width * Math.max(1, p.weight)))
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (sum(widthsAt(mid)) <= free) lo = mid
    else hi = mid - 1
  }
  let left = free - sum(widthsAt(lo))
  const order = parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.weight - b.p.weight || a.i - b.i)
  const bonus = new Set<number>()
  for (const { p, i } of order) {
    if (left <= 0) break
    if (Math.min(p.width, Math.floor(lo / Math.max(1, p.weight))) < p.width) {
      bonus.add(i)
      left--
    }
  }
  return widthsAt(lo).map((w, i) => (bonus.has(i) ? w + 1 : w))
}

// A part cut below this many cells says nothing; it is dropped with its separator instead.
export const MIN_PART = 4

// The widths each part gets in `room` cells when `sep` cells go before each kept part,
// or -1 for a dropped one. While a cut part would show fewer than MIN_PART cells, the
// heaviest kept part (the least informative) is dropped and the rest are fitted again.
export const fitParts = (parts: readonly Part[], room: number, sep: number): number[] => {
  let kept = parts.map((p, i) => ({ p, i }))
  for (;;) {
    const widths = shareWidths(
      kept.map(k => k.p),
      room - sep * kept.length,
    )
    const isTooShort = kept.some((k, n) => {
      const w = widths[n] ?? 0
      return w < k.p.width && w < MIN_PART
    })
    if (!isTooShort || kept.length === 0) {
      const byIndex = new Map(kept.map((k, n) => [k.i, widths[n] ?? 0]))
      return parts.map((_, i) => byIndex.get(i) ?? -1)
    }
    const heaviest = kept.reduce((a, b) => (b.p.weight >= a.p.weight ? b : a))
    kept = kept.filter(k => k !== heaviest)
  }
}
