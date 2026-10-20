import type { ToolCallResult } from 'claude-code'

import type { PaneTask } from '../types'
import type { Strings } from './strings'
import { openText, type Draw } from './tasks'

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
      <Text key="pane-header-rule" dimColor>
        {'─'.repeat(Math.max(0, columns))}
      </Text>
      {view}
    </Box>
  )
}

// `next`'s context is kept whole, as the engine requires of an answer built on it.
export const withContext = (ran: ToolCallResult, line: string | undefined): ToolCallResult =>
  line === undefined || ran.deny !== undefined ? ran : ({ ...ran, context: [...(ran.context ?? []), line] } as ToolCallResult)

export const remind = (agentId: string | undefined, tasks: readonly PaneTask[]) => {
  const line = agentId === undefined ? openText(tasks, false) : undefined
  if (line === undefined) return {}
  return { context: [line] }
}
