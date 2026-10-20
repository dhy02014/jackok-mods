// Terminal cells, not UTF-16 units: Hangul, CJK and fullwidth forms take two, combining marks none.
// Copied from manage-pane/hooks/strings.ts (a plugin imports only its own files); keep the two alike.
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

export const cells = (s: string) => {
  let n = 0
  for (const ch of s) n += cellsOf(ch)
  return n
}

// The start of `s` that fits in `room` cells, `…` standing for what was cut from its end.
export const headFit = (s: string, room: number) => {
  if (cells(s) <= room) return s
  if (room < 1) return ''
  let kept = ''
  let used = 1
  for (const ch of s) {
    const w = cellsOf(ch)
    if (used + w > room) break
    kept += ch
    used += w
  }
  return `${kept}…`
}
