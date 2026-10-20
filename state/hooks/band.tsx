import type { Elements, RenderSurface } from 'claude-code'

import type { HudAdvisor, HudGit, HudSnap, HudTool, HudWeekly } from '../types'
import { displayModel } from './format'
import { isUnder } from './platform'
import type { BandLabels } from './strings'

// The band's pure half: text helpers and the tree. Every atom read and every `$`
// call stays in ./register.tsx (the engine follows `$` into no imported file).

export type Draw = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button'>

// Left indent of every row under the `── state ──` rule, in cells.
const CONTENT_INDENT = 2

export const kTokens = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const level = (p: number) => (p >= 80 ? 'red' : p >= 50 ? 'yellow' : 'green')

// The context fill turns yellow and red earlier than a rate limit does.
const ctxLevel = (p: number) => (p >= 85 ? 'red' : p >= 70 ? 'yellow' : 'green')

export const short = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

// `mcp__claude-code-docs__search_claude_code_docs` → `claude-code-docs:search`: the
// server keeps its name, the tool drops the words it repeats from the server.
// Display only; counts stay keyed by the full name.
const toolLabel = (name: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (m === null) return name
  const [, server, tool] = m
  const serverWords = new Set(server.toLowerCase().split(/[-_]/))
  const kept = tool.split('_').filter(w => !serverWords.has(w.toLowerCase()))
  return short(`${server}:${kept.length > 0 ? kept.join('_') : tool}`, 24)
}

// Time left to `iso`, rounded up to the minute: `12m`, `3h 26m`, `140h`; empty once it has passed.
export const formatReset = (iso: string | undefined, now: number) => {
  const left = (iso === undefined ? Number.NaN : new Date(iso).getTime()) - now
  if (Number.isNaN(left) || left <= 0) return ''
  const total = Math.ceil(left / 60_000)
  const hours = Math.trunc(total / 60)
  const minutes = total - hours * 60
  const parts = [hours > 0 ? `${hours}h` : '', minutes > 0 || hours === 0 ? `${minutes}m` : '']
  return parts.filter(p => p !== '').join(' ')
}

/** Always in k with two decimals, so the token count stays exact enough to read. */
const kPrecise = (n: number) => `${(n / 1000).toFixed(2)}k`

// At most the last two segments (`…/worktrees/feature-x`), so a deep
// worktree path never wraps the top line; a short path keeps its `~` or `/` root.
const CWD_SEGMENTS = 2

// Windows paths (`C:\Users\me\proj`) split on `\` too; the label keeps the path's own separator.
const cwdLabel = (cwd: string, home: string | undefined) => {
  const underHome = home !== undefined && isUnder(cwd, home)
  const full = underHome ? `~${cwd.slice(home.length)}` : cwd
  const sep = full.includes('\\') && !full.includes('/') ? '\\' : '/'
  const parts = full.split(/[\\/]/).filter(p => p !== '')
  return parts.length > CWD_SEGMENTS ? `…${sep}${parts.slice(-CWD_SEGMENTS).join(sep)}` : full
}

export type BandInput = {
  /** None of these sits where titleRule counts cells. */
  labels: BandLabels
  snap: HudSnap
  git: HudGit | null
  weekly: HudWeekly | null
  effort: string | null
  advisor: HudAdvisor
  blink: boolean
  tools: readonly HudTool[]
  toolCounts: Record<string, number>
  agentTally: Record<string, number>
  isExpanded: boolean
  turnTokens: number | null
  history: readonly number[]
  now: number
  home: string | undefined
  columns: number
  isFolded: boolean
  onToggleFold: () => unknown
  onToggle: () => unknown
  isAgentsExpanded: boolean
  onToggleAgents: () => unknown
  onCopyId: (surface?: RenderSurface) => unknown
  onCopyCwd: (surface?: RenderSurface) => unknown
}

// `── label ─────` exactly `columns` cells wide, the label a button: pressing it folds the band.
// The label is cut to fit, so a narrow band never pushes the row past `columns`. `.length`
// counts cells only for an ASCII label: a double-width one would overrun.
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

export const bandTree = ({ Box, Button, Text }: Draw, o: BandInput, below: JSX.Element) => {
  // Folded, the rule row is all the band draws.
  const head = titleRule({ Box, Button, Text }, 'state', o.columns, o.onToggleFold)
  if (o.isFolded) {
    return (
      <Box flexDirection="column">
        {head}
        {below}
      </Box>
    )
  }
  const s = o.snap
  const g = o.git
  const wk = o.weekly
  const eff = o.effort
  const adv = o.advisor
  const blink = o.blink
  const expanded = o.isExpanded
  const agentsExpanded = o.isAgentsExpanded
  const trend = o.history
  const now = o.now
  const last = trend.at(-1)
  const prev = trend.at(-2)
  const delta = last !== undefined && prev !== undefined ? last - prev : undefined

  const ctx = s.ctxPercent ?? 0
  const total = s.ctxTokens
  const added = o.turnTokens ?? undefined
  const inFlight = o.tools.filter(t => !t.isDone)
  const running = inFlight.at(-1)
  // One entry per agent type, most spawned first, its runs grouped by model and then effort:
  // `explorer (Sonnet 5.5:medium x1, high x1, Opus 5.5:high x2)`.
  type EffortRuns = { effort: string; n: number }
  type ModelRuns = { model: string; n: number; efforts: EffortRuns[] }
  const byType = new Map<string, { n: number; models: Map<string, ModelRuns> }>()
  for (const [key, n] of Object.entries(o.agentTally)) {
    const [type, id = '', effort = ''] = key.split('\t')
    const model = id === '' ? '' : displayModel(id)
    const t = byType.get(type) ?? { n: 0, models: new Map<string, ModelRuns>() }
    const m = t.models.get(model) ?? { model, n: 0, efforts: [] }
    const ef = m.efforts.find(x => x.effort === effort)
    if (ef !== undefined) ef.n += n
    else m.efforts.push({ effort, n })
    m.n += n
    t.n += n
    t.models.set(model, m)
    byType.set(type, t)
  }
  const spawned = [...byType.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([type, t]) => ({
      type,
      models: [...t.models.values()]
        .sort((a, b) => b.n - a.n)
        .map(m => ({ ...m, efforts: [...m.efforts].sort((a, b) => b.n - a.n) })),
    }))
  const topTools = Object.entries(o.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, expanded ? 12 : 4)

  const usage = [
    // The engine gives one decimal (23.5); the band prints whole percents.
    ...s.limits.map(l => ({ label: o.labels.limits[l.kind] ?? l.kind, percent: Math.round(l.percent), resetsAt: l.resetsAt })),
    ...(wk?.models ?? []).map(m => ({ label: m.name, percent: m.percent, resetsAt: m.resetsAt })),
  ]

  const SEP = <Text dimColor> | </Text>
  // The top line stays one row: every part keeps its width and only the cwd,
  // truncated from the left, gives way. It shows at most two segments; pressing it
  // copies the full path.
  const CWD = (
    <Box flexShrink={1}>
      <Button key="copy-cwd" plain onPress={p => o.onCopyCwd(p.surface)}>
        <Text color="yellow" wrap="truncate-start">{cwdLabel(s.cwd, o.home)}</Text>
      </Button>
    </Box>
  )
  const joinedFixed = (parts: unknown[]) =>
    parts
      .filter(p => p !== null && p !== false)
      .flatMap((p, i) => (i === 0 ? [p] : [SEP, p]))
      .map(p => (p === CWD ? p : <Box flexShrink={0}>{p}</Box>))
  // `a | b | c` from whichever parts are present.
  const joined = (parts: unknown[]) => parts.filter(p => p !== null && p !== false).flatMap((p, i) => (i === 0 ? [p] : [SEP, p]))

  const usageParts = [
    ...usage.map(u => {
      const reset = formatReset(u.resetsAt, now)
      return (
        <Text>
          <Text dimColor>{u.label} </Text>
          <Text color={level(u.percent)}>{u.percent}%</Text>
          {reset !== '' && <Text dimColor> ({reset})</Text>}
        </Text>
      )
    }),
    wk?.error !== undefined && <Text color="yellow">⚠ {o.labels.usage} ({wk.error})</Text>,
    s.usd !== undefined && <Text dimColor>${s.usd.toFixed(2)}</Text>,
  ]

  // Only the tally sits on the tools line; in-flight calls get their own rows
  // below it, so the tally never shifts sideways as calls start and finish.
  const toolParts = [
    ...topTools.map(([name, n]) => (
      <Text>
        <Text color="green">✓ </Text>
        <Text>{toolLabel(name)} </Text>
        <Text dimColor>×{n}</Text>
      </Text>
    )),
    // The advisor tallies like a tool; subagents' calls ride along as `+N sub`.
    adv.calls + adv.agentCalls > 0 && (
      <Text>
        <Text color="green">✓ </Text>
        <Text>advisor </Text>
        <Text dimColor>×{adv.calls}</Text>
        {adv.agentCalls > 0 && <Text dimColor> +{adv.agentCalls} {o.labels.sub}</Text>}
      </Text>
    ),
  ].filter(p => p !== false)

  // Folded, the agents line keeps its top types with their run counts (`explorer x3`),
  // the tools line's limit; expanded, each type's runs by model and effort.
  const agentParts = (agentsExpanded ? spawned : spawned.slice(0, 4)).map(a =>
    agentsExpanded ? (
      <Text>
        <Text color="magenta">{a.type} </Text>
        <Text dimColor>(</Text>
        {a.models
          .flatMap(m =>
            m.efforts.map((ef, i) => (
              <Text>
                {/* The model names the first of its efforts and the rest of that model's follow bare;
                    an unrecorded model or effort reads `?`, so a bare entry is always a further effort. */}
                {i === 0 && <Text color="cyan">{m.model !== '' ? m.model : '?'}</Text>}
                {i === 0 ? (
                  ef.effort !== '' && <Text dimColor>:{ef.effort}</Text>
                ) : (
                  <Text dimColor>{ef.effort !== '' ? ef.effort : '?'}</Text>
                )}
                <Text dimColor> x{ef.n}</Text>
              </Text>
            )),
          )
          .flatMap((p, i) => (i === 0 ? [p] : [<Text dimColor>, </Text>, p]))}
        <Text dimColor>)</Text>
      </Text>
    ) : (
      <Text>
        <Text color="magenta">{a.type} </Text>
        <Text dimColor>x{a.models.reduce((n, m) => n + m.n, 0)}</Text>
      </Text>
    ),
  )

  return (
    // No sizing props here: the engine refuses its own node (`below`) under a
    // Box carrying `width`, and the band is already sized to bodyColumns.
    <Box flexDirection="column">
      {/* A labelled rule so the band never reads as one block with the engine's task row above it. */}
      {head}
      {/* Rows sit indented under the rule. */}
      <Box flexDirection="column" paddingLeft={CONTENT_INDENT}>
      <Box justifyContent="space-between">
        {/* On a narrow terminal the line gives way, never the id: half an id is useless. */}
        <Box flexShrink={1}>
          {joinedFixed([
            <Text>
              <Text dimColor>{o.labels.context} </Text>
              <Text color={ctxLevel(ctx)}>{ctx}%</Text>
              {total !== undefined && <Text dimColor> ({kPrecise(total)})</Text>}
              {added !== undefined && added > 0 && <Text color="cyan"> ▲+{kPrecise(added)}</Text>}
              {delta !== undefined && delta < 0 && (
                // A drop between turns is a compaction; growth is already the ▲ figure.
                <Text color="green"> ▼{kTokens(delta)}</Text>
              )}
            </Text>,
            // `Opus 5.5:medium`, spelled and colored as the agents line spells a subagent's run.
            <Text>
              <Text color="cyan">{displayModel(s.model)}</Text>
              {eff !== null && <Text dimColor>:{eff}</Text>}
            </Text>,
            // The one part that gives way: it truncates from the left, so the line never wraps.
            CWD,
            g !== null && (
              <Text color="magenta">
                {g.branch}
                {g.changed > 0 ? '*' : ''}
                {g.ahead > 0 ? ` ↑${g.ahead}` : ''}
                {g.behind > 0 ? ` ↓${g.behind}` : ''}
              </Text>
            ),
          ])}
        </Box>
        {/* Pressing the id copies it; the button itself is the label. */}
        <Box flexShrink={0}>
          <Button key="copy-id" plain onPress={p => o.onCopyId(p.surface)}>
            <Text color="cyan">{s.sessionId}</Text>
          </Button>
        </Box>
      </Box>
      {usageParts.some(p => p !== false) && <Box>{joined(usageParts)}</Box>}
      {/* The fold toggle leads the tools line it folds. The tally stays one Text,
          not a Box of parts: a Box squeezes each part when the line is too long,
          splitting names mid-word; a Text wraps the line as a whole. */}
      {toolParts.length > 0 && (
        <Box>
          <Box flexShrink={0}>
            <Button key="toggle" plain label={expanded ? '[-]' : '[+]'} onPress={o.onToggle} />
            <Text> </Text>
          </Box>
          <Box flexShrink={1}>
            <Text>{joined(toolParts)}</Text>
          </Box>
        </Box>
      )}
      {/* Which subagents this conversation called, under the tools they were called with,
          led by its own fold toggle as the tools line is: folded, the top types and their
          run counts; expanded, every type with its runs by model and effort. */}
      {spawned.length > 0 && (
        <Box>
          <Box flexShrink={0}>
            <Button key="toggle-agents" plain label={agentsExpanded ? '[-]' : '[+]'} onPress={o.onToggleAgents} />
            <Text> </Text>
          </Box>
          <Box flexShrink={1}>
            <Text>{joined(agentParts)}</Text>
          </Box>
        </Box>
      )}
      {/* One row, always drawn: blank while idle, so the band never grows and
          shrinks as calls start and finish. Parallel calls show the newest and a count. */}
      {adv.inFlight !== undefined ? (
        // An advisor call runs server-side inside the model request: it takes the
        // tool row, its mark blinking while the call is open.
        <Text wrap="truncate-end">
          <Text color="yellow">{blink ? '  ◐ ' : '    '}</Text>
          <Text color="cyan">advisor</Text>
          {adv.inFlight.agentId !== undefined && <Text dimColor> ({o.labels.subagent})</Text>}
        </Text>
      ) : running === undefined ? (
        <Text> </Text>
      ) : (
        <Text wrap="truncate-end">
          <Text color="yellow">{'  ◐ '}</Text>
          <Text color="cyan">{toolLabel(running.name)}</Text>
          {inFlight.length > 1 && <Text color="yellow"> +{inFlight.length - 1}</Text>}
          {running.target !== '' && <Text dimColor>: {running.target}</Text>}
        </Text>
      )}
      {/* Tasks and each running subagent's rows are in the task pane (the manage-pane mod). */}
      </Box>
      {below}
    </Box>
  )
}
