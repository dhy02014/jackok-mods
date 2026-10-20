import type { PaneAgent, PaneOwnerRun, PaneTask } from '../types'
import { isWindowsPath, slashed } from './platform'
import { cells, tailFit, type Strings } from './strings'
import { type Draw } from './tasks'

// The subagents' pure half: under the task an agent owns, what it is for and the call it
// is on while it runs, then who ran, on what model and effort, for how long.
// The tracking hooks and the effort lookup are in ./register.tsx.

const AGENTS_KEPT = 30
// Calls kept per agent: only the current one is shown, so one is all the pane needs.
export const RECENT_KEPT = 1
const TARGET_MAX = 200

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// A home directory reads as `~`, whoever's it is: `C:/Users/u` and Git Bash's `/c/Users/u` too.
export const tilde = (s: string) => s.replace(/(?:(?:[A-Za-z]:|\/[A-Za-z])?\/Users|\/home)\/[^/\s]+(?=\/|\s|$)/g, '~')

// The one thing the call acts on: a file's name, a command's first line, a pattern, a URL.
export const targetOf = (e: Record<string, unknown>) => {
  const path = e.file_path ?? e.notebook_path
  const v = typeof path === 'string' ? slashed(path) : (path ?? e.command ?? e.pattern ?? e.url ?? e.description ?? e.subject)
  if (typeof v !== 'string') return ''
  const first = v.split('\n')[0] ?? ''
  const last = first.includes('/') && !first.includes(' ') ? (first.split('/').pop() ?? first) : first
  return short(tilde(last).replace(/\s+/g, ' ').trim(), TARGET_MAX)
}

// `mcp__server__tool` reads as `server:tool`, as the state band labels it.
const toolLabel = (name: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (m === null) return name
  const server = m[1]!
  const tool = m[2]!
  const serverWords = new Set(server.toLowerCase().split(/[-_]/))
  const kept = tool.split('_').filter(w => !serverWords.has(w.toLowerCase()))
  return short(`${server}:${kept.length > 0 ? kept.join('_') : tool}`, 24)
}

const digitsAtStart = (s: string) => {
  let n = 0
  while (n < s.length && s.charCodeAt(n) >= 48 && s.charCodeAt(n) <= 57) n++
  return s.slice(0, n)
}

// `claude-sonnet-5-5` → `Sonnet 5.5`, wherever the `claude-` part sits in the id. A minor
// version is one or two digits, so the date of `claude-haiku-4-5-20251001` is dropped.
const modelLabel = (id: string) => {
  for (let at = id.indexOf('claude-'); at !== -1; at = id.indexOf('claude-', at + 1)) {
    const [family = '', major = '', minor = ''] = id.slice(at + 'claude-'.length).split('-')
    if (family === '' || family !== family.replace(/[^a-z]/g, '')) continue
    const majorDigits = digitsAtStart(major)
    if (majorDigits === '') continue
    const minorDigits = majorDigits === major ? digitsAtStart(minor) : ''
    const version = minorDigits.length > 0 && minorDigits.length <= 2 ? `${majorDigits}.${minorDigits}` : majorDigits
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
  }
  return id
}

// 42s, 3m12s, 1h05m. A finished agent's run only: the CLI's footer already counts a running one's.
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// What a task completed under this owner keeps of its run: one agent id can serve a later
// task too (a SendMessage resume), so the completed one draws this, never the live record.
export const runOf = (a: PaneAgent, now: number): PaneOwnerRun => ({
  type: a.type,
  ms: (a.endedAt ?? now) - a.startedAt,
  ...(a.model !== '' ? { model: a.model } : {}),
  ...(a.effort !== undefined ? { effort: a.effort } : {}),
})

// `✓ explorer Sonnet 5.5:medium 3m12s`: who ran, on what model and effort, for how long;
// model and effort spelled as the state band spells them.
const finishLabel = (r: PaneOwnerRun) => {
  const model = r.model !== undefined ? modelLabel(r.model) : undefined
  const run = model !== undefined && r.effort !== undefined ? `${model}:${r.effort}` : (model ?? r.effort)
  return ['✓', r.type, run, elapsed(r.ms)].filter(s => s !== undefined).join(' ')
}

// A resume is a new run of the same record: a fresh clock and no calls yet.
export const restart = (a: PaneAgent, now: number): PaneAgent => {
  const { endedAt: _ended, ...rest } = a
  return { ...rest, isRunning: true, startedAt: now, recent: [] }
}

// A key an agent definition file's frontmatter pins (`effort:`, `isolation:`), if any.
export const frontmatterIn = (file: string, key: 'effort' | 'isolation') => {
  const m = new RegExp(`^${key}:[ \\t]*(?:"([^"]*)"|'([^']*)'|(\\S+))[ \\t]*$`, 'm').exec(file.split(/^---$/m)[1] ?? '')
  return m?.[1] ?? m?.[2] ?? m?.[3]
}

// At most the last two segments, a home directory as `~` when the tail starts there:
// `/home/u/work/app` → `~/work/app`, `/a/b/c/d` → `c/d`.
export const dirLabel = (path: string) => {
  const t = tilde(slashed(path))
  const rest = t.split('/').filter(s => s !== '' && s !== '~')
  if (rest.length <= 2) return t
  return rest.slice(-2).join('/')
}

// The directory as the head row has room for: cut from its start, so the name, model and
// effort before it give way only once it is gone.
const dirFit = (t: Strings, a: PaneAgent, headCells: number, columns: number) => {
  const label = a.dir !== undefined ? dirLabel(a.dir) : a.isWorktree === true ? t.worktree : undefined
  const room = columns - headCells - 2
  if (label === undefined || room < 2) return undefined
  return tailFit(label, room)
}

export const keepLast = (all: Record<string, PaneAgent>) => Object.fromEntries(Object.entries(all).slice(-AGENTS_KEPT))

export const touch = (all: Record<string, PaneAgent>, id: string, fn: (a: PaneAgent) => PaneAgent) => {
  const a = all[id]
  return a === undefined ? all : { ...all, [id]: fn(a) }
}

// One running agent: who and where, what it is for, the call it is on; drawn under the task it owns, or under Other.
export const agentBlock = ({ Box, Text }: Draw, t: Strings, id: string, a: PaneAgent, columns: number) => {
  const model = a.model !== '' ? modelLabel(a.model) : undefined
  const head = 2 + cells(a.type) + (model !== undefined ? cells(model) + 1 : 0) + (a.effort !== undefined ? cells(a.effort) + 1 : 0)
  const dir = dirFit(t, a, head, columns)
  return (
    <Box key={`pane-agent:${id}`} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color="yellow">◐ </Text>
        <Text weight="bold" color="magenta">
          {a.type}
        </Text>
        {model !== undefined && <Text color="cyan"> {model}</Text>}
        {a.effort !== undefined && <Text dimColor>{model !== undefined ? ':' : ' '}{a.effort}</Text>}
        {dir !== undefined && <Text color="blue">  {dir}</Text>}
      </Text>
      {/* What it is for. */}
      <Text wrap="truncate-end">
        {'  '}
        {a.description}
      </Text>
      {/* The call it is on: yellow while in flight, dim once it returned and the agent thinks. */}
      {a.recent.map(c => (
        <Text key={`call:${id}:${c.seq}`} wrap="truncate-end">
          <Text color={c.isCalling ? 'yellow' : 'green'} dimColor={!c.isCalling}>
            {c.isCalling ? '  ▸ ' : '  · '}
          </Text>
          <Text color="cyan" dimColor={!c.isCalling}>
            {toolLabel(c.tool)}
          </Text>
          {c.target !== '' && <Text dimColor> {c.target}</Text>}
        </Text>
      ))}
    </Box>
  )
}

// What a task's owner adds under the task line: the owner's running block, its finish
// time once done, or its short id when this load never saw it spawn (a reload, a resume).
// A completed task's `frozen` run wins over the live record. The owner is the caller's
// to set and clear; nothing here guesses or completes one.
export const ownerTree = (
  draw: Draw,
  t: Strings,
  owner: string,
  a: PaneAgent | undefined,
  columns: number,
  frozen?: PaneOwnerRun,
) => {
  const { Box, Text } = draw
  if (frozen === undefined && a?.isRunning === true) {
    return (
      <Box key={`pane-owned:${owner}`} paddingLeft={2}>
        {agentBlock(draw, t, owner, a, columns - 2)}
      </Box>
    )
  }
  const label = frozen !== undefined ? finishLabel(frozen) : a === undefined ? owner.slice(0, 8) : finishLabel(runOf(a, a.endedAt ?? a.startedAt))
  return (
    <Text key={`pane-owned:${owner}`} wrap="truncate-end" dimColor>
      {'  └ '}
      {label}
    </Text>
  )
}

// Everyone working a task: its owner, then each other agent whose `#N` named it — parallel
// spawns of one task, which the task's single owner cannot hold — in spawn order.
export const taskAgentsTree = (
  draw: Draw,
  t: Strings,
  task: PaneTask,
  all: Readonly<Record<string, PaneAgent>>,
  columns: number,
) => {
  const owner =
    task.owner === undefined
      ? []
      : [ownerTree(draw, t, task.owner, all[task.owner], columns, task.status === 'completed' ? task.ownerRun : undefined)]
  const others = Object.entries(all)
    .filter(([id, a]) => a.taskId === task.id && id !== task.owner)
    .map(([id, a]) => ownerTree(draw, t, id, a, columns))
  const rows = [...owner, ...others]
  if (rows.length === 0) return undefined
  const { Box } = draw
  return (
    <Box key={`pane-agents:${task.id}`} flexDirection="column">
      {rows}
    </Box>
  )
}

// Agents no task claims: none owned by a task in the list, none whose `#N` names one. Running
// ones first in spawn order, then the newest FINISHED_OTHERS finished, under an `Other` heading.
const FINISHED_OTHERS = 3

export const otherAgentsTree = (
  draw: Draw,
  t: Strings,
  list: readonly PaneTask[],
  all: Readonly<Record<string, PaneAgent>>,
  columns: number,
  isDoneHidden = false,
) => {
  const owners = new Set(list.flatMap(x => (x.owner === undefined ? [] : [x.owner])))
  const ids = new Set(list.map(x => x.id))
  // A running agent is placed when a task it owns shows it (a completed one holds only its
  // frozen run) or a shown task its `#N` names, owned by someone else, lists it.
  const isShown = (x: PaneTask) => !(isDoneHidden && x.status === 'completed')
  const live = new Set(list.flatMap(x => (x.owner === undefined || !isShown(x) || (x.status === 'completed' && x.ownerRun !== undefined) ? [] : [x.owner])))
  const isNamed = (a: PaneAgent) => a.taskId !== undefined && ids.has(a.taskId)
  const isNamedElsewhere = (id: string, a: PaneAgent) => a.taskId !== undefined && list.some(x => x.id === a.taskId && isShown(x) && x.owner !== id)
  const running = Object.entries(all).filter(([id, a]) => a.isRunning && !live.has(id) && !isNamedElsewhere(id, a))
  const finished = Object.entries(all)
    .filter(([id, a]) => !a.isRunning && !owners.has(id) && !isNamed(a))
    .sort(([, x], [, y]) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt))
    .slice(0, FINISHED_OTHERS)
  if (running.length + finished.length === 0) return undefined
  const { Box, Text } = draw
  return (
    <Box key="pane-other" flexDirection="column">
      <Text key="pane-other-gap"> </Text>
      <Text key="pane-other-heading" dimColor>
        {t.otherAgents}
      </Text>
      {running.map(([id, a]) => agentBlock(draw, t, id, a, columns))}
      {finished.map(([id, a]) => (
        <Text key={`pane-other-done:${id}`} wrap="truncate-end" dimColor>
          {'  └ '}
          {finishLabel(runOf(a, a.endedAt ?? a.startedAt))}
        </Text>
      ))}
    </Box>
  )
}

// An Agent description opening with `#N ` names the task the agent works: the spawn
// claims it and the pane shows the rest.
// `#3 Fix the parser` → { taskId: '3', rest: 'Fix the parser' }.
export const taskMarkOf = (description: string): { taskId?: string; rest: string } => {
  const m = /^#(\d+)\s+(\S[\s\S]*)$/.exec(description)
  return m === null ? { rest: description } : { taskId: m[1]!, rest: m[2]! }
}

// The running agent other than `agentId` that owns `task`, which a claim must leave alone.
export const busyOwner = (task: PaneTask, all: Readonly<Record<string, PaneAgent>>, agentId?: string) =>
  task.owner !== undefined && task.owner !== agentId && all[task.owner]?.isRunning === true ? task.owner : undefined

// A spawned agent as the pane first shows it; `cwd` is the session's, `e.cwd` relative to it.
export const newAgent = (
  e: { subagentType: string; description: string; cwd?: string },
  o: { model: string; effort: string | undefined; isWorktree: boolean; cwd: string; startedAt: number },
): PaneAgent => {
  const dir = o.isWorktree ? undefined : e.cwd === undefined ? o.cwd : e.cwd.startsWith('/') || isWindowsPath(e.cwd) ? e.cwd :`${o.cwd}/${e.cwd}`
  return {
    type: e.subagentType,
    model: o.model,
    effort: o.effort,
    ...(dir !== undefined ? { dir } : {}),
    ...(o.isWorktree ? { isWorktree: true as const } : {}),
    description: taskMarkOf(e.description).rest,
    isRunning: true,
    startedAt: o.startedAt,
    calls: 0,
    recent: [],
  }
}
