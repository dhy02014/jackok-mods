import type { Strings } from './strings'
import type { Draw } from './tasks'

// The pane's tabs in order, by id (their names are in ./strings): a tab's place is its hotkey
// (the first `1`, the next `2`, up to `9`), so a new tab is one entry here and takes the next digit.
export const TABS = ['task', 'prompt'] as const

export type PaneTab = (typeof TABS)[number]

// A digit while the tabs fit in 1-9; a tenth tab has none and is pressed by pointer or Enter.
export const tabHotkey = (index: number) => (index < 9 ? String(index + 1) : undefined)

export const tabLabel = (name: string, count: string) => (count === '' ? name : `${name} ${count}`)

// The pane's frame: one header row with a tab per feature on the left (`[ Task 2/5 ]`,
// the active one at full strength, the rest dim) and the active tab's own controls on the
// right; one dim rule `columns` wide; then the active tab's view. A tab is a bracketed
// Button, which the terminal draws with no hotkey shown: its digit presses it while the
// pane holds the focus, and the row stays clean as tabs are added.
export const paneTree = (
  { Box, Text, Button }: Draw,
  t: Strings,
  tabs: { tab: PaneTab; counts: Record<PaneTab, string>; onSet: (tab: PaneTab) => unknown },
  controls: JSX.Element | undefined,
  view: JSX.Element,
  columns: number,
  hint: { above: number; below: number } = { above: 0, below: 0 },
) => {
  return (
    <Box flexDirection="column">
      <Box key="pane-header" justifyContent="space-between">
        <Box flexShrink={0}>
          {TABS.flatMap((id, i) => {
            const hotkey = tabHotkey(i)
            return [
              ...(i > 0 ? [<Text key={`pane-tab-gap:${id}`}> </Text>] : []),
              <Button
                key={`pane-tab:${id}`}
                {...(hotkey !== undefined ? { hotkey } : {})}
                dimColor={tabs.tab !== id}
                label={tabLabel(t.tabs[id], tabs.counts[id])}
                onPress={() => tabs.onSet(id)}
              />,
            ]
          })}
        </Box>
        {controls !== undefined && <Box flexShrink={0}>{controls}</Box>}
      </Box>
      {headerRule({ Text }, columns, hint)}
      {view}
    </Box>
  )
}

// ---- the pane's own window: the header stays, the view under it scrolls ----

// The header row and its rule: drawn above the window, never scrolled away.
export const HEADER_ROWS = 2

type El = { type?: unknown; children?: unknown; props?: Record<string, unknown> & { children?: unknown; key?: unknown }; key?: unknown }

// Rows a tree takes on the terminal as this pane draws it: a Text, a Button or a bare string is
// one row (every line here is cut, never wrapped), a column Box its children stacked plus its own
// vertical margins and padding, a row Box its tallest child. A Box drawn `display: none` takes none.
const childrenOf = (n: El): unknown[] =>
  [n.children ?? n.props?.children].flat(Infinity as 1).filter(c => c !== undefined && c !== null && c !== false && c !== true && c !== '')

const spacing = (p: Record<string, unknown>, side: 'Top' | 'Bottom') => {
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0)
  return num(p[`margin${side}`] ?? p.marginY ?? p.margin) + num(p[`padding${side}`] ?? p.paddingY ?? p.padding)
}

const isColumn = (el: El) => el.type === 'Box' && (el.props?.flexDirection === 'column' || el.props?.flexDirection === 'column-reverse')

const hasVerticalSpace = (el: El) => spacing(el.props ?? {}, 'Top') + spacing(el.props ?? {}, 'Bottom') > 0

export const treeRows = (n: unknown): number => {
  if (Array.isArray(n)) return n.reduce((sum: number, c) => sum + treeRows(c), 0)
  if (typeof n === 'string') return n === '' ? 0 : 1
  if (typeof n === 'number') return 1
  if (n === null || typeof n !== 'object') return 0
  const el = n as El
  if (el.type !== 'Box') return el.type === 'Text' || el.type === 'Button' ? 1 : 0
  const p = el.props ?? {}
  if (p.display === 'none') return 0
  const kids = childrenOf(el).map(treeRows)
  const body = isColumn(el) ? kids.reduce((a, b) => a + b, 0) : Math.max(0, ...kids)
  return body + spacing(p, 'Top') + spacing(p, 'Bottom')
}

const withChildren = (el: El, kids: unknown[]): El =>
  el.children !== undefined || el.props?.children === undefined ? { ...el, children: kids } : { ...el, props: { ...el.props, children: kids } }

// The rows `from` to `from + count` of a tree, as a tree: a column Box keeps the children in
// range, cut the same way; anything else is one block, kept whole when its first row is in range.
export const sliceRows = (n: unknown, from: number, count: number): unknown => {
  const rows = treeRows(n)
  if (count <= 0 || rows === 0 || from >= rows || from + count <= 0) return undefined
  if (from <= 0 && rows <= from + count) return n
  if (Array.isArray(n) || n === null || typeof n !== 'object') return from <= 0 ? n : undefined
  const el = n as El
  if (!isColumn(el) || hasVerticalSpace(el)) return from <= 0 ? n : undefined
  const kept: unknown[] = []
  let top = 0
  for (const kid of childrenOf(el)) {
    const r = treeRows(kid)
    const cut = sliceRows(kid, from - top, count)
    if (cut !== undefined && top + r > from && top < from + count) kept.push(cut)
    top += r
  }
  return withChildren(el, kept)
}

// Where the element drawn under `key` sits in a tree: its first row and how many it takes.
export const rowOfKey = (n: unknown, key: string, top = 0): { top: number; rows: number } | undefined => {
  if (n === null || typeof n !== 'object' || Array.isArray(n)) return undefined
  const el = n as El
  if (el.props?.key === key || el.key === key) return { top, rows: treeRows(el) }
  if (el.type !== 'Box') return undefined
  let at = top + spacing(el.props ?? {}, 'Top')
  for (const kid of childrenOf(el)) {
    const found = rowOfKey(kid, key, isColumn(el) ? at : top + spacing(el.props ?? {}, 'Top'))
    if (found !== undefined) return found
    if (isColumn(el)) at += treeRows(kid)
  }
  return undefined
}

export const clampOffset = (offset: number, listRows: number, win: number) =>
  Math.min(Math.max(0, Math.round(offset)), Math.max(0, listRows - win))

// The offset that shows `at` whole, moving the least from `offset`; a block taller than the window shows its top.
export const revealOffset = (offset: number, at: { top: number; rows: number }, win: number) =>
  at.top < offset || at.rows >= win ? at.top : at.top + at.rows > offset + win ? at.top + at.rows - win : offset

// The view as the window under the header shows it: `want` clamped to the view, moved the
// least that shows `followKey` whole when it is drawn, and the rows left above and below.
export const windowed = (view: JSX.Element, bodyRows: number, want: number, followKey?: string) => {
  const win = Math.max(1, bodyRows - HEADER_ROWS)
  const listRows = treeRows(view)
  if (listRows <= win) return { view, offset: 0, win, listRows, above: 0, below: 0 }
  const at = followKey === undefined ? undefined : rowOfKey(view, followKey)
  const offset = clampOffset(at === undefined ? want : revealOffset(clampOffset(want, listRows, win), at, win), listRows, win)
  return { view: sliceRows(view, offset, win) as JSX.Element, offset, win, listRows, above: offset, below: listRows - offset - win }
}

// Rows of a `total`-row tree past the bottom of the window `scroll` describes: for a surface
// that scrolls the whole tree itself (no window of the pane's own).
export const rowsBelow = (total: number, scroll: { offset: number; bodyRows: number }) =>
  Math.max(0, total - Math.max(0, scroll.offset) - Math.max(0, scroll.bodyRows))

// The dim rule under the header, `columns` wide; while rows lie past the window it carries
// ` N more below ` (or ` N more above `, or both) near its right end, so the person sees the
// list goes on and scrolls. ASCII only: an arrow glyph is two cells wide in some terminals.
export const ruleLabel = (above: number, below: number) =>
  above > 0 && below > 0 ? ` ${above} above, ${below} below ` : below > 0 ? ` ${below} more below ` : above > 0 ? ` ${above} more above ` : ''

export const ruleParts = (columns: number, above: number, below: number) => {
  const n = Math.max(0, columns)
  const label = ruleLabel(above, below)
  const tail = 2
  if (label === '' || label.length + tail + 2 > n) return { head: '─'.repeat(n), label: '', tail: '' }
  return { head: '─'.repeat(n - label.length - tail), label, tail: '─'.repeat(tail) }
}

const headerRule = ({ Text }: Pick<Draw, 'Text'>, columns: number, hint: { above: number; below: number }) => {
  const r = ruleParts(columns, hint.above, hint.below)
  if (r.label === '') {
    return (
      <Text key="pane-header-rule" dimColor>
        {r.head}
      </Text>
    )
  }
  return (
    <Text key="pane-header-rule">
      <Text dimColor>{r.head}</Text>
      <Text color="yellow">{r.label}</Text>
      <Text dimColor>{r.tail}</Text>
    </Text>
  )
}

// ---- a task call's time: its wait in the mod's queue counts against the hook's limit ----

export const HOOK_LIMIT_MS = 10_000
export const QUEUE_MARGIN_MS = 1000

export const QUEUED_TOO_LONG = 'manage-pane: earlier task calls took too long, so this one did not run; the list is unchanged. Call it again.'

type Budgeted = { signal?: { aborted?: boolean }; budget?: { remainingMs?: number } } | undefined

// Too little left to start a body that would write; an engine with no budget never is.
export const isOutOfTime = (next: Budgeted) =>
  next?.signal?.aborted === true || (next?.budget?.remainingMs ?? Infinity) <= QUEUE_MARGIN_MS

// A failed task call's answer: one the engine timed out before its body began did nothing and
// may be called again; one that began (or carries no id) may already have written.
export const failureText = (errorKind: unknown, toolUseId: string | undefined, started: ReadonlySet<string>) =>
  errorKind === 'timeout' && toolUseId !== undefined && !started.has(toolUseId)
    ? QUEUED_TOO_LONG
    : 'manage-pane: the task tool failed; the list is unchanged.'
