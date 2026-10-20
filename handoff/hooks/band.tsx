import type { Elements, RenderSurface } from 'claude-code'

import type { HandoffCard, HandoffFilter, HandoffStatus } from '../types'
import { BAND_MAX, BAND_WINDOW, cardAge, ordered, windowStart } from './cards'
import { cells, headFit } from './cells'
import type { Strings } from './strings'

// The band's own words, from register.tsx. A card row's age and status are measured in cells
// (cardRow), so a longer word shortens the card text rather than overrunning the row.
export type BandText = Pick<Strings, 'title' | 'noCards' | 'noFilterCards' | 'age'>

// Fewer cells than this left for `next` after `#N title — `, and the row drops ` — next`.
const MIN_NEXT = 4

// `#N title — next` cut to `room` cells: next gives way first, then the title. Cut here because
// 1.1.2's wrap="truncate-end" on this Button's child did not cut in a real terminal.
export const cardRow = (n: number, title: string, next: string, room: number) => {
  const full = `#${n} ${title} — ${next}`
  if (cells(full) <= room) return full
  const head = `#${n} ${title} — `
  if (cells(head) + MIN_NEXT <= room) return head + headFit(next, room - cells(head))
  return headFit(`#${n} ${title}`, room)
}

// The band's pure half: its rule, buttons and tree, drawn from plain values and callbacks
// that ./register.tsx reads from the atoms and passes in.

export type Draw = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button'>

const CONTENT_INDENT = 2

// Ready to pick up reads green; waiting on a decision reads magenta, apart from the yellow age.
const STATUS_COLOR: Record<HandoffStatus, string> = { open: 'green', hold: 'magenta' }

// The button names the hidden count in both states, `[more +2]` / `[less -2]`, the same
// width, so it never moves under the pointer.
export const expandLabel = (isExpanded: boolean, total: number) =>
  isExpanded ? `[less -${total - BAND_MAX}]` : `[more +${total - BAND_MAX}]`

export const FILTERS = ['all', 'open', 'hold'] as const satisfies readonly HandoffFilter[]

// `/handoff open|hold|all`; undefined for anything else.
export const asFilter = (s: string): HandoffFilter | undefined =>
  s === 'all' ? 'all' : s === 'open' ? 'open' : s === 'hold' ? 'hold' : undefined

export const filterLabel = (f: HandoffFilter) => (f === 'all' ? '[all]' : f === 'open' ? '[open]' : '[hold]')

// The cells between the rule's end and the first filter button.
const FILTER_GAP = 2

// `[all] [open] [hold]`: the labels plus one space between each.
const FILTER_WIDTH = FILTERS.reduce((n, f) => n + filterLabel(f).length, 0) + FILTERS.length - 1

// `── label ─────` exactly `columns` cells wide, the label a button: pressing it folds the band.
// The label is cut to fit, so a narrow band never pushes the row past `columns`.
const titleRule = ({ Box, Button, Text }: Draw, label: string, columns: number, onPress: () => unknown) => {
  const shown = label.slice(0, Math.max(0, columns - 4))
  return (
    <Box>
      <Text dimColor>── </Text>
      <Button key="fold" plain dimColor label={shown} onPress={onPress} />
      <Text dimColor>{` ${'─'.repeat(Math.max(0, columns - 4 - shown.length))}`}</Text>
    </Box>
  )
}

// The rule, shortened so the three filter buttons sit FILTER_GAP cells past its end and the
// row stays `columns` wide; the active filter at full strength, the others dim. Then one row
// per card up to BAND_MAX; past BAND_MAX the last row ends in a button that expands the list and
// folds it back. Expanded past BAND_WINDOW, a window of that many rows shows from `offset`, and
// `[^]` and `[v]` end the two rows over the last, which reads `1-5/10 [less -7]`; a page
// button is dim where it has nowhere to go. Paging is by button, never the wheel.
// A row's `#N` is its place among all cards, so a filter never renumbers one.
// The rule's label is a button that folds the band; folded, the rule is all it draws,
// filter buttons and rows gone. /handoff hides the band before it is drawn. No sizing
// props on the outer Box: `below` goes in it.
export const bandTree = (
  { Box, Text, Button }: Draw,
  o: {
    cards: readonly HandoffCard[]
    columns: number
    now: number
    isExpanded: boolean
    offset: number
    filter: HandoffFilter
    isFolded: boolean
    onToggleFold: () => unknown
    onToggleExpand: () => unknown
    onSetOffset: (n: number) => unknown
    onSetFilter: (f: HandoffFilter) => unknown
    onCopyCard: (file: string, surface?: RenderSurface) => unknown
    text: BandText
  },
  below: JSX.Element,
) => {
  const head = o.filter === 'all' ? o.text.title : `${o.text.title}: ${o.filter}`
  if (o.isFolded) {
    return (
      <Box flexDirection="column">
        {titleRule({ Box, Button, Text }, head, o.columns, o.onToggleFold)}
        {below}
      </Box>
    )
  }
  const all = ordered(o.cards)
  const rank = new Map(all.map((c, i) => [c.file, i + 1]))
  const list = o.filter === 'all' ? all : all.filter(c => c.status === o.filter)
  const hasMore = list.length > BAND_MAX
  const start = o.isExpanded ? windowStart(o.offset, list.length) : 0
  const shown = list.slice(start, start + (o.isExpanded ? BAND_WINDOW : BAND_MAX))
  const isPaged = o.isExpanded && list.length > BAND_WINDOW
  const isFirstPage = start === 0
  const isLastPage = start + shown.length >= list.length
  const label = expandLabel(o.isExpanded, list.length)
  const place = `${start + 1}-${start + shown.length}/${list.length} `
  // [^] and [v] end the two rows above the last, at `bodyColumns` as the expand button does.
  const pageButton = (key: 'page-up' | 'page-down') => {
    const isUp = key === 'page-up'
    return (
      <Box flexShrink={0} paddingLeft={1}>
        <Button
          key={key}
          plain
          dimColor={isUp ? isFirstPage : isLastPage}
          label={isUp ? '[^]' : '[v]'}
          onPress={() => o.onSetOffset(windowStart(start + (isUp ? -BAND_WINDOW : BAND_WINDOW), list.length))}
        />
      </Box>
    )
  }
  const filterButtons = FILTERS.flatMap((f, i) => [
    ...(i > 0 ? [<Text key={`filter-gap:${f}`}> </Text>] : []),
    <Button key={`filter-${f}`} plain dimColor={f !== o.filter} label={filterLabel(f)} onPress={() => o.onSetFilter(f)} />,
  ])
  return (
    <Box flexDirection="column">
      <Box key="handoff-header">
        {titleRule({ Box, Button, Text }, head, o.columns - FILTER_GAP - FILTER_WIDTH, o.onToggleFold)}
        <Box flexShrink={0} paddingLeft={FILTER_GAP}>
          {filterButtons}
        </Box>
      </Box>
      <Box key="handoff-body" flexDirection="column" paddingLeft={CONTENT_INDENT}>
        {shown.length === 0 && <Text dimColor>{o.filter === 'all' ? o.text.noCards : o.text.noFilterCards(o.filter)}</Text>}
        {shown.map((c, i) => {
          const age = cardAge(c, o.now)
          const isLast = hasMore && i === shown.length - 1
          const fromLast = shown.length - 1 - i
          const ageText = ` ${o.text.age(age)}`
          const statusText = ` ${filterLabel(c.status)}`
          // The cells this row's trailing control takes: a page button or the expand button.
          const control =
            isPaged && (fromLast === 2 || fromLast === 1) ? 1 + 3 : isLast ? 1 + (isPaged ? cells(place) : 0) + cells(label) : 0
          const room = o.columns - CONTENT_INDENT - cells(ageText) - cells(statusText) - control
          return (
            // The age, status and any control sit at the row's right end (`bodyColumns`); the
            // card text is cut to the cells left (cardRow), so it never pushes them out.
            <Box key={`card:${c.file}`} justifyContent="space-between">
              <Box flexShrink={1}>
                {/* Pressing the card's text copies the card file's full path. */}
                <Box flexShrink={1}>
                  <Button key={`copy-${c.file}`} plain onPress={p => o.onCopyCard(c.file, p.surface)}>
                    <Text wrap="truncate-end" dimColor={c.status === 'hold'}>
                      {cardRow(rank.get(c.file) ?? 0, c.title, c.next, room)}
                    </Text>
                  </Button>
                </Box>
                <Box flexShrink={0}>
                  <Text color="yellow">{ageText}</Text>
                  <Text color={STATUS_COLOR[c.status]}>{statusText}</Text>
                </Box>
              </Box>
              {isPaged && fromLast === 2 && pageButton('page-up')}
              {isPaged && fromLast === 1 && pageButton('page-down')}
              {isLast && (
                <Box flexShrink={0} paddingLeft={1}>
                  {isPaged && <Text dimColor>{place}</Text>}
                  <Button key="expand" plain label={label} onPress={o.onToggleExpand} />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      {below}
    </Box>
  )
}
