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
  scroll?: { offset: number; bodyRows: number },
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
      {headerRule({ Text }, columns, scroll === undefined ? 0 : rowsBelow(2 + treeRows(view), scroll))}
      {view}
    </Box>
  )
}

// ---- what lies below the pane's window ----

// Rows a tree takes on the terminal as this pane draws it: a Text, a Button or a bare string is
// one row (every line here is cut, never wrapped), a column Box its children stacked plus its own
// vertical margins and padding, a row Box its tallest child. A Box drawn `display: none` takes none.
const childrenOf = (n: { children?: unknown; props?: { children?: unknown } }): unknown[] =>
  [n.children ?? n.props?.children].flat(Infinity as 1)

const spacing = (p: Record<string, unknown>, side: 'Top' | 'Bottom') => {
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0)
  return num(p[`margin${side}`] ?? p.marginY ?? p.margin) + num(p[`padding${side}`] ?? p.paddingY ?? p.padding)
}

export const treeRows = (n: unknown): number => {
  if (Array.isArray(n)) return n.reduce((sum: number, c) => sum + treeRows(c), 0)
  if (typeof n === 'string') return n === '' ? 0 : 1
  if (typeof n === 'number') return 1
  if (n === null || typeof n !== 'object') return 0
  const el = n as { type?: unknown; children?: unknown; props?: Record<string, unknown> & { children?: unknown } }
  if (el.type !== 'Box') return el.type === 'Text' || el.type === 'Button' ? 1 : 0
  const p = el.props ?? {}
  if (p.display === 'none') return 0
  const kids = childrenOf(el).map(treeRows)
  const isColumn = p.flexDirection === 'column' || p.flexDirection === 'column-reverse'
  const body = isColumn ? kids.reduce((a, b) => a + b, 0) : Math.max(0, ...kids)
  return body + spacing(p, 'Top') + spacing(p, 'Bottom')
}

// Rows of a `total`-row tree past the bottom of the window `scroll` describes.
export const rowsBelow = (total: number, scroll: { offset: number; bodyRows: number }) =>
  Math.max(0, total - Math.max(0, scroll.offset) - Math.max(0, scroll.bodyRows))

// The dim rule under the header, `columns` wide; while rows lie below the window it carries
// ` N more below ` near its right end, so the person sees the list goes on and scrolls.
// ASCII only: an arrow glyph is two cells wide in some terminals and would push the rule over.
export const ruleParts = (columns: number, below: number) => {
  const n = Math.max(0, columns)
  const label = ` ${below} more below `
  const tail = 2
  if (below <= 0 || label.length + tail + 2 > n) return { head: '─'.repeat(n), label: '', tail: '' }
  return { head: '─'.repeat(n - label.length - tail), label, tail: '─'.repeat(tail) }
}

const headerRule = ({ Text }: Pick<Draw, 'Text'>, columns: number, below: number) => {
  const r = ruleParts(columns, below)
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
