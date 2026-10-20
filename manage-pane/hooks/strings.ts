// Every string the person reads (the /pane command and the pane itself). English whatever
// Claude Code's `language` setting is: only text a person or the model wrote, such as a task
// subject, reaches the pane in another script, which is why widths below are counted in cells.

export const EN = {
  commandDescription: 'Open or close the task and agent pane',
  paneClosed: 'Pane closed.',
  paneOpened: 'Pane opened.',
  paneWaits: (reason: string) => `Pane waits: ${reason}`,
  title: 'Manage',
  tabs: { task: 'Task', prompt: 'Prompt' },
  filterAll: '[all]',
  filterOpen: '[open]',
  noTasks: 'No tasks yet.',
  otherAgents: 'Other',
  blockedBy: (ids: readonly string[]) => ` (blocked by #${ids.join(', #')})`,
  noInstructions: 'None loaded yet.',
  instructionsTotal: 'total',
  worktree: 'worktree',
}

export type Strings = typeof EN

// Terminal cells, not UTF-16 units: Hangul, CJK and fullwidth forms take two, combining marks none.
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

// The end of `s` that fits in `room` cells, `…` standing for what was cut from its start.
export const tailFit = (s: string, room: number) => {
  if (cells(s) <= room) return s
  const chars = [...s]
  let kept = ''
  let used = 1
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = cellsOf(chars[i]!)
    if (used + w > room) break
    kept = chars[i] + kept
    used += w
  }
  return `…${kept}`
}
