import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PaneBoard, PaneCall, PaneTask } from '../types'
import {
  busyOwner,
  frontmatterIn,
  keepLast,
  newAgent,
  RECENT_KEPT,
  restart,
  runOf,
  targetOf,
  liveOwners,
  otherAgentsTree,
  taskAgentsTree,
  taskMarkOf,
  tasksDone,
  touch,
} from './agents'
import { flag, idOf, newTask, patchOf } from './input'
import { bankIfShrunk, diskBody, instructionsTree, mergeLoads, scanLoads } from './instructions'
import { clampOffset, failureText, HEADER_ROWS, HOOK_LIMIT_MS, isOutOfTime, paneTree, QUEUED_TOO_LONG, rowsBelow, treeRows, windowed } from './pane'
import { slashed } from './platform'
import { EN } from './strings'
import type { AppliedMany, Patch } from './tasks'
import { createdLines, createLines, summary, updateLines, withText } from './toolrow'
import { applyPatches, asStatus, asTask, doneFilter, EMPTY, listText, own, str, taskKey, tasksTree, toolsFor } from './tasks'

// One pane, open at session start: the session's tasks on top, its subagents pinned
// under them, and below them the instruction files the context carried with their load
// counts; /pane opens or closes it. The task tools are served here; each session's list is
// kept in `$.store` under its session id, so a resumed session picks it back up. Nothing is
// written outside the store: the CLI's tasks directory is never read or written.
// The pure halves are ./tasks and ./agents; everything that touches `$` stays in this file,
// the only one the engine follows it into.

type Options = {
  open_on_start?: unknown
}

// From `register`'s options; the default is the manifest's.
let openOnStart = true
// From `session.start`: a non-interactive (`-p`) session opens no pane and starts no timer.
let isInteractive = true

const t = EN

const PANE = 'manage-pane'
// Here rather than in ./tasks: a matcher's literal is read off this file's source.
const CREATE = 'mcp__manage-pane__task_create'
const UPDATE = 'mcp__manage-pane__task_update'
const LIST = 'mcp__manage-pane__task_list'
const AGENT = 'Agent'
// Code mode's script tool: no row of its own; the calls its script makes are.
const REPL = 'REPL'

const board = atom({ plugin: 'manage-pane', key: 'board' } as const, EMPTY, { shape: 'v2' })
const blink = atom({ plugin: 'manage-pane', key: 'blink' } as const, false)
const isDoneHidden = atom({ plugin: 'manage-pane', key: 'isDoneHidden' } as const, false)
const agents = atom({ plugin: 'manage-pane', key: 'agents' } as const, {}, { shape: 'v7' })
const instructions = atom({ plugin: 'manage-pane', key: 'instructions' } as const, {}, { shape: 'v1' })
const instructionsBase = atom({ plugin: 'manage-pane', key: 'instructionsBase' } as const, {}, { shape: 'v1' })
const instructionsLast = atom({ plugin: 'manage-pane', key: 'instructionsLast' } as const, { messages: 0, live: {} }, { shape: 'v1' })
// Each task call's result lines, by tool_use_id, as the call left them: a redraw after later updates
// shows what that call did. The newest ROWS_KEPT calls; a session that lost them draws the engine's own.
const toolRows = atom({ plugin: 'manage-pane', key: 'toolRows' } as const, {}, { shape: 'v1' })
const ROWS_KEPT = 200
const tab = atom({ plugin: 'manage-pane', key: 'tab' } as const, 'task' as 'task' | 'prompt')
// Where each tab's window under the pinned header starts, and the task a follow keeps in view
// until the person scrolls.
const scrollTop = atom({ plugin: 'manage-pane', key: 'scrollTop' } as const, { task: 0, prompt: 0 } as { task: number; prompt: number; follow?: string }, { shape: 'v1' })
// The window as last drawn on the terminal, which a wheel tick moves from; undefined while the
// view fits, or on a surface that scrolls the whole tree itself.
let shownWindow: { tab: 'task' | 'prompt'; offset: number; listRows: number; win: number } | undefined

const ignore = () => undefined

const remember = ($: EngineInterface, id: string | undefined, lines: string[]) =>
  id === undefined
    ? undefined
    : update($, toolRows, all => Object.fromEntries(Object.entries({ ...all, [id]: lines }).slice(-ROWS_KEPT))).catch(ignore)

// ---- the blink timer: it runs only while there is something to move ----

// An in-progress task's mark blinks on its own timer, which runs only while one is in progress.
const BLINK_MS = 500
let blinkTimer: { cancel: () => void } | undefined

const isLive = async ($: EngineInterface) => (await read($, board)).tasks.some(t => t.status === 'in_progress')

const stopBlink = async ($: EngineInterface) => {
  blinkTimer?.cancel()
  blinkTimer = undefined
  await update($, blink, () => false)
}

const blinkTick = async ($: EngineInterface) => {
  if (await isLive($)) await update($, blink, v => !v)
  else await stopBlink($)
}

const syncBlink = async ($: EngineInterface) => {
  const live = await isLive($)
  if (live && blinkTimer === undefined && isInteractive) {
    await update($, blink, () => true)
    blinkTimer = $.clock.every(BLINK_MS, () => void blinkTick($).catch(ignore))
  } else if (!live && blinkTimer !== undefined) {
    await stopBlink($)
  }
}

// ---- the pane ----

// A docked pane runs floor to ceiling (no height request exists) and the band above the
// prompt lays out in the transcript column beside it, so the dock asks for a narrow width
// to leave the band room. A width the person dragged still wins.
const DOCK_COLUMNS = 44

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: t.title, columns: DOCK_COLUMNS })

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

const sessionId = ($: EngineInterface) => $.session.id().catch(() => undefined)

// ---- persistence: `$.store`, one key per session; never fails a tool call ----

const STORE_PREFIX = 'board:'
// The store is one file every session on the machine shares, capped at 4 MiB: the
// lists of the newest BOARDS_KEPT sessions are kept, the older ones dropped after start;
// a write the store refuses drops down to half that and tries once more.
const BOARDS_KEPT = 50

// `deleted`: ids this session's processes deleted. Ids are never reused, so a merge drops them for good.
type Stored = { at: number; lastId: number; tasks: PaneTask[]; deleted?: string[] }

const decimals = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^\d+$/.test(x)) : [])

const storedBoard = async ($: EngineInterface, sid: string) => {
  const raw = (await $.store.get(`${STORE_PREFIX}${sid}`).catch(() => undefined)) as Partial<Stored> | null | undefined
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.flatMap(x => {
        const task = asTask(x)
        return task === undefined ? [] : [task]
      })
    : []
  const lastId = typeof raw.lastId === 'number' && Number.isInteger(raw.lastId) ? raw.lastId : 0
  return { lastId: Math.max(lastId, 0, ...tasks.map(x => Number(x.id))), tasks, deleted: decimals(raw.deleted) }
}

// Drops the oldest lists past `keep`; `current`'s is never one of them.
const prune = async ($: EngineInterface, keep: number, current: string | undefined) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith(STORE_PREFIX))
  if (keys.length <= keep) return
  const kept = current === undefined ? undefined : `${STORE_PREFIX}${current}`
  const aged: { key: string; at: number }[] = []
  for (const key of keys) {
    if (key === kept) continue
    const at = Number(((await $.store.get(key).catch(() => undefined)) as Partial<Stored> | undefined)?.at ?? 0)
    aged.push({ key, at: Number.isFinite(at) ? at : 0 })
  }
  aged.sort((a, b) => a.at - b.at)
  for (const { key } of aged.slice(0, keys.length - keep)) await $.store.delete(key).catch(ignore)
}

// ---- the config directory ----

// Windows has no HOME by default: USERPROFILE stands in.
const homeOf = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home === undefined || home === '' ? undefined : slashed(home)
}

// The CLI's config directory: CLAUDE_CONFIG_DIR when set, else <home>/.claude.
const configRoot = async ($: EngineInterface) => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (dir !== undefined && dir !== '') return slashed(dir)
  const home = await homeOf($)
  return home === undefined ? undefined : `${home}/.claude`
}

// What another process of the same session stored since this one read it is kept: its
// tasks, unless deleted here or there; a task this write changed is this process's.
// Store get and set are separate calls, so a write landing between them still wins.
const merged = (b: PaneBoard, stored: Awaited<ReturnType<typeof storedBoard>>, o: { write?: readonly PaneTask[]; remove?: readonly string[] }) => {
  const deleted = new Set([...(stored?.deleted ?? []), ...(o.remove ?? [])])
  const mine = new Set((o.write ?? []).map(x => x.id))
  const byId = new Map<string, PaneTask>()
  for (const x of b.tasks) byId.set(x.id, x)
  for (const x of stored?.tasks ?? []) if (!mine.has(x.id)) byId.set(x.id, x)
  const tasks = [...byId.values()].filter(x => !deleted.has(x.id)).sort((x, y) => Number(x.id) - Number(y.id))
  return { board: { ...b, lastId: Math.max(b.lastId, stored?.lastId ?? 0), tasks }, deleted: [...deleted] }
}

// The board as written, merged with the store's copy and saved whole. Returns the board as saved.
const persist = async (
  $: EngineInterface,
  b: PaneBoard,
  o: { write?: readonly PaneTask[]; remove?: readonly string[] },
): Promise<PaneBoard> => {
  const sid = b.sessionId
  if (sid === null) return b
  const stored = await storedBoard($, sid)
  const m = merged(b, stored, o)
  const key = `${STORE_PREFIX}${sid}`
  const value = { at: Date.now(), lastId: m.board.lastId, tasks: m.board.tasks, deleted: m.deleted } satisfies Stored
  const isSaved = await $.store.set(key, value).then(() => true, () => false)
  // The store is capped: a refused write makes room by dropping older sessions' lists, then tries once more.
  if (!isSaved) {
    await prune($, Math.floor(BOARDS_KEPT / 2), sid).catch(ignore)
    await $.store.set(key, value).catch(ignore)
  }
  return update($, board, cur => (cur.sessionId === sid ? m.board : cur))
}

// A task that goes in progress is brought into view, moving the pane's window the least
// that shows it whole: the next draw places the window, and keeps it so until the person scrolls.
const follow = ($: EngineInterface, id: string | undefined) => {
  if (id === undefined || !isInteractive) return
  void update($, scrollTop, cur => ({ ...cur, follow: taskKey(id) })).catch(ignore)
  // A surface other than the terminal scrolls the whole tree itself: ask it, after the redraw.
  void $.session
    .surfaces()
    .then(all => {
      if (all.some(x => x !== 'terminal')) $.clock.after(1, () => void $.ui.scroll({ to: { key: taskKey(id) }, in: PANE }).catch(ignore))
    })
    .catch(ignore)
}

// The session's list from the store when the board holds another session's (or none): a
// fresh hooks worker, a /resume, a new id after /clear (which finds nothing and starts at 1).
const restore = async ($: EngineInterface) => {
  const sid = await sessionId($)
  if (sid === undefined) return
  if ((await read($, board)).sessionId === sid) return
  const stored = await storedBoard($, sid)
  await update($, board, (b: PaneBoard) => (b.sessionId === sid ? b : { sessionId: sid, lastId: stored?.lastId ?? 0, tasks: stored?.tasks ?? [] }))
}

// The tool_use_ids whose task body has begun, for `failureText`.
const started = new Set<string>()

// A task hook's error handler: a call the engine timed out while it waited in the queue is told to call again.
const failedOrQueued = (_: unknown, e: { tool_use_id?: string }, next?: { error?: { kind?: unknown } }) => ({
  deny: failureText(next?.error?.kind, e.tool_use_id, started),
})

// Task calls and claims run one at a time: calls a script fires side by side would each
// persist a board read before the other's write and put it back over it. The queue waits on
// one run for at most a hook's limit, so a run that never settles cannot hold every later call.
// The limit counts from when a run's turn comes, so a slow run that is not stuck keeps the queue
// for its full limit and never overlaps the next one.
let taskQueue: Promise<unknown> = Promise.resolve()
const serial = <T,>($: EngineInterface, body: () => Promise<T>): Promise<T> => {
  let timer: { cancel: () => void } | undefined
  let release: () => void = ignore
  const stalled = new Promise<void>(resolve => (release = resolve))
  const run = taskQueue.then(() => {
    // No clock, or a non-interactive session: the queue waits on the run alone.
    if (isInteractive) {
      try {
        timer = $.clock.after(HOOK_LIMIT_MS, release)
      } catch {
        // No clock.
      }
    }
    return body()
  })
  const settled = run.then(
    () => timer?.cancel(),
    () => timer?.cancel(),
  )
  taskQueue = Promise.race([settled, stalled]).catch(ignore)
  return run
}

// A task call's body: refused when its time ran out while queued (the engine answers that
// call with the error handler while a late body would still write), marked begun otherwise.
const taskBody = <T,>(next: Parameters<typeof isOutOfTime>[0], id: string | undefined, body: () => Promise<T>) => async () => {
  if (isOutOfTime(next)) return { deny: QUEUED_TOO_LONG }
  if (id !== undefined) started.add(id)
  try {
    return await body()
  } finally {
    if (id !== undefined) started.delete(id)
  }
}

// ---- instruction files ----

// The list recounted from the main conversation as the model is sent it: the bank (copies
// a compaction or a rewind took out) plus the live window's copies.
// One at a time: two scans reading the same last scan would bank a shrink twice.
let scanning: Promise<void> = Promise.resolve()
const scanInstructions = ($: EngineInterface) => (scanning = scanning.catch(ignore).then(() => scanOnce($)))

// A main-loop call's scan, on the clock (off the call's path); calls that end before it runs share it.
// A non-interactive session skips it: only the pane shows the list, and turn.complete still scans.
// A refused timer neither throws nor fires, so a scan queued SCAN_LOST_MS ago counts as lost.
const SCAN_LOST_MS = 1000
let scanQueuedAt: number | undefined
const queueScan = async ($: EngineInterface) => {
  if (!isInteractive) return
  const now = await $.clock.now()
  if (scanQueuedAt !== undefined && now - scanQueuedAt < SCAN_LOST_MS) return
  scanQueuedAt = now
  try {
    $.clock.after(1, () => {
      scanQueuedAt = undefined
      void scanInstructions($).catch(ignore)
    })
  } catch {
    scanQueuedAt = undefined
  }
}

// Each loaded file is read back so its size ends where the file does; one that cannot be read
// is sized by its span in the conversation.
const scanOnce = async ($: EngineInterface) => {
  const messages = await $.session.messages({ as: 'api' })
  const paths = Object.keys(scanLoads(messages))
  const disk = Object.fromEntries(await Promise.all(paths.map(async p => [p, diskBody(await $.fs.read(p).catch(() => ''))] as const)))
  const live = scanLoads(messages, disk)
  const shown = await read($, instructions)
  const last = await read($, instructionsLast)
  const base = await update($, instructionsBase, b => bankIfShrunk(shown, b, last, messages.length))
  await update($, instructionsLast, () => ({ messages: messages.length, live }))
  await update($, instructions, prev => mergeLoads(prev, base, live))
}

// ---- a subagent's task: made at its spawn, completed at its report, reopened at its resume ----

// An agent spawned with a name, by that name: SendMessage addresses it so.
const idByName = new Map<string, string>()

type NewItem = { subject: string; fields: Record<string, unknown> }

// New tasks numbered past every id the session minted, in one board write; `owner` goes on each.
// Callers hold the task queue (`serial`), so side-by-side creates and spawns each get their own ids.
const addTasks = async ($: EngineInterface, items: readonly NewItem[], owner?: string) => {
  await restore($).catch(ignore)
  const sid = await sessionId($)
  // Another process of the same session may have minted ids since this one loaded.
  const stored = (sid === undefined ? undefined : await storedBoard($, sid))?.lastId ?? 0
  const seen = { wasIdle: false }
  const local = await update($, board, b => {
    const cur = own(b, sid)
    const first = Math.max(cur.lastId, stored, ...cur.tasks.map(x => Number(x.id))) + 1
    const made = items.map((it, i) => ({ ...newTask(first + i, it.subject, it.fields), ...(owner !== undefined ? { owner } : {}) }))
    seen.wasIdle = cur.tasks.every(x => x.status === 'completed')
    return { sessionId: cur.sessionId, lastId: first + items.length - 1, tasks: [...cur.tasks, ...made] }
  })
  const made = local.tasks.slice(-items.length)
  await persist($, local, { write: made })
  // The first task of a list reopens the pane; one the person closed mid-list stays
  // closed until the next list. /pane toggles it any time. The tab the person picked
  // stays put: the Task tab redraws from the board whether it is shown or not.
  if (seen.wasIdle && isInteractive) await openPane($).catch(ignore)
  await syncBlink($).catch(ignore)
  follow($, made.filter(x => x.status === 'in_progress').at(-1)?.id)
  return made
}

// The patches `plan` picks from the session's list, applied in one board write and stored.
const patchList = async ($: EngineInterface, plan: (tasks: readonly PaneTask[]) => Patch[]) => {
  await restore($).catch(ignore)
  const sid = await sessionId($)
  let applied: AppliedMany = { error: 'unchanged' }
  const local = await update($, board, b => {
    const cur = own(b, sid)
    const patches = plan(cur.tasks)
    applied = patches.length === 0 ? { error: 'unchanged' } : applyPatches(cur.tasks, patches)
    return applied.error !== undefined ? b : { ...cur, tasks: applied.tasks }
  })
  const done = applied as AppliedMany
  if (done.error !== undefined || done.touched.length === 0) return []
  await persist($, local, { write: local.tasks.filter(x => done.touched.includes(x.id)) })
  await syncBlink($).catch(ignore)
  return done.touched
}

// A run that ended `completed` completes every open task its agent owns, its run frozen on each.
// A failed or stopped run reports too and leaves them open. A task another agent still works
// waits for that agent's report (`tasksDone`).
const finish = ($: EngineInterface, agentId: string) =>
  serial($, async () => {
    const team = await read($, agents)
    const now = await $.clock.now().catch(() => Date.now())
    const frozen = (owner: string) => (team[owner] !== undefined ? runOf(team[owner], now) : undefined)
    return patchList($, tasks => tasksDone(tasks, team, agentId).map(x => ({ ...patchOf(x.id, { status: 'completed' }), runOf: frozen })))
  })

// A resumed agent's newest task goes back in progress if it was completed (which thaws its frozen
// run); the run's report completes it again.
const reopen = ($: EngineInterface, agentId: string) =>
  serial($, async () => {
    const touched = await patchList($, tasks => {
      const last = tasks.filter(x => x.owner === agentId).sort((x, y) => Number(x.id) - Number(y.id)).at(-1)
      return last?.status === 'completed' ? [patchOf(last.id, { status: 'in_progress' })] : []
    })
    follow($, touched[0])
  })

// ---- subagents' isolation ----

// Run-scoped: a reload re-reads the definitions, which is what an edited agent
// file wants. Keyed by cwd too, since project definitions differ per worktree.
type AgentDef = { isWorktree: boolean }
const defByType = new Map<string, AgentDef>()

// The isolation an agent type's definition pins (frontmatter), project definitions over
// user ones. Reads flat `<type>.md` files only: a plugin, nested, `--agents` or managed
// definition reads as not isolated. Effort is never read here: the definition's is only
// one input of the effective level (see the `turn.step` hook).
const agentDef = async ($: EngineInterface, type: string): Promise<AgentDef> => {
  const cwd = await $.session.cwd()
  const key = `${cwd}\0${type}`
  const known = defByType.get(key)
  if (known !== undefined) return known
  let found: AgentDef = { isWorktree: false }
  if (/^[A-Za-z0-9_-]+$/.test(type)) {
    const root = await configRoot($)
    for (const dir of [`${slashed(cwd)}/.claude/agents`, ...(root !== undefined ? [`${root}/agents`] : [])]) {
      const path = `${dir}/${type}.md`
      if (!(await $.fs.exists(path))) continue
      const file = await $.fs.read(path)
      found = { isWorktree: frontmatterIn(file, 'isolation') === 'worktree' }
      break
    }
  }
  defByType.set(key, found)
  return found
}

// A tracked agent's model and effort as its latest request had them; written only on a change,
// since every request of every subagent passes here.
// A model left out keeps the one drawn.
const noteRun = async ($: EngineInterface, id: string, run: { model?: string; effort: string | undefined }) => {
  const a = (await read($, agents))[id]
  if (a === undefined) return
  const model = run.model ?? a.model
  if (a.model === model && a.effort === run.effort) return
  await update($, agents, all => touch(all, id, x => ({ ...x, model, effort: run.effort })))
}

// Agent calls asking `isolation: 'worktree'`, by tool_use_id, which `agent.spawn` carries
// as the call it belongs to; the spawn input itself names no isolation.
const isolatedCalls = new Set<string>()

// The task a spawn's `#N` names gets the agent as owner and goes in progress, the same
// write a task_update would make. A missing or completed task is left alone: a stale
// number must not reopen finished work, and a task another running agent works stays its.
// True when the task is open, claimed or not: the agent is drawn under it either way.
const claim = ($: EngineInterface, taskId: string, agentId: string) => serial($, () => claimNow($, taskId, agentId))

const claimNow = async ($: EngineInterface, taskId: string, agentId: string) => {
  await restore($).catch(ignore)
  const sid = await sessionId($)
  const all = await read($, agents)
  let applied: AppliedMany = { error: 'unclaimed' }
  let isTaskOpen = false
  await update($, board, b => {
    const cur = own(b, sid)
    const x = cur.tasks.find(y => y.id === taskId)
    if (x === undefined || x.status === 'completed') return b
    isTaskOpen = true
    if (busyOwner(x, all, agentId) !== undefined) return b
    applied = applyPatches(cur.tasks, [patchOf(taskId, { owner: agentId, status: 'in_progress' })])
    return applied.error !== undefined ? b : { ...cur, tasks: applied.tasks }
  })
  const done = applied as AppliedMany
  if (done.error !== undefined || done.touched.length === 0) return isTaskOpen
  const written = own(await read($, board), sid)
  await persist($, written, { write: written.tasks.filter(x => done.touched.includes(x.id)) })
  await syncBlink($).catch(ignore)
  follow($, taskId)
  return isTaskOpen
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Options
  openOnStart = flag(o.open_on_start, true)
  isInteractive = true

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive !== false
    await $.command.register({ name: 'pane', description: t.commandDescription }).catch(ignore)
    const { language } = (await $.settings.read().catch(() => undefined)) ?? {}
    for (const tool of toolsFor({ language })) await $.tool.register(tool).catch(ignore)
    await restore($).catch(ignore)
    // A reload starts with no timer: an in-progress task left in the state blinks again.
    blinkTimer = undefined
    await syncBlink($).catch(ignore)
    const started = await next(e)
    // Off the start's path (on the clock where timers may run); never the current session's list.
    const sid = await sessionId($)
    if (isInteractive) $.clock.after(1, () => void prune($, BOARDS_KEPT, sid).catch(ignore))
    else void prune($, BOARDS_KEPT, sid).catch(ignore)
    await scanInstructions($).catch(ignore)
    if (openOnStart && isInteractive) await openPane($).catch(ignore)
    return started
  })

  // A /clear starts a new conversation: no tasks, its agents are not this one's, and
  // its instruction files are loaded afresh.
  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (e.reason === 'resume' || e.reason === 'clear') idByName.clear()
    if (e.reason === 'resume' || e.reason === 'clear') await update($, scrollTop, () => ({ task: 0, prompt: 0 }))
    if (e.reason === 'resume') {
      await update($, board, () => EMPTY)
      await stopBlink($)
      await update($, agents, () => ({}))
    }
    if (e.reason === 'clear') {
      await update($, board, () => EMPTY)
      await stopBlink($)
      await update($, agents, () => ({}))
      await update($, instructions, () => ({}))
      await update($, instructionsBase, () => ({}))
      await update($, instructionsLast, () => ({ messages: 0, live: {} }))
    }
    return done
  })

  // ---- instruction files: recounted after each main-thread turn and main-loop tool call ----

  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    await scanInstructions($).catch(ignore)
    return out
  })

  on('command.run', { command: 'pane' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: t.paneClosed }
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? t.paneOpened : t.paneWaits(String(opened.reason)) }
  })

  // ---- subagents ----

  // A resume keeps its row; `session.send` and the agent's next call restart it. Its task
  // reopens here, and again harmlessly at the send or the call, whichever the engine shows.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume) {
      const resumed = await next(e)
      if (resumed.deny === undefined) {
        const id = e.resume.agentId
        await update($, agents, all => touch(all, id, ({ outcome: _outcome, ...a }) => a))
        await reopen($, id).catch(ignore)
      }
      return resumed
    }
    const ran = await next(e)
    if (ran.deny === undefined && ran.agentId !== undefined) {
      const id = ran.agentId
      if (typeof e.name === 'string' && e.name !== '') idByName.set(e.name, id)
      const startedAt = await $.clock.now()
      // The model it starts on, resolved; $.agent.list() does not carry it. Its effort is
      // unknown until its first request (`turn.step`), so none is drawn before.
      const model = ran.model ?? ''
      const def = await agentDef($, e.subagentType).catch((): AgentDef => ({ isWorktree: false }))
      // The call's `cwd` (relative to the session's) or the session's. An isolated agent's
      // worktree path is on no event while it runs, so it shows as `worktree`.
      const isWorktree = isolatedCalls.delete(e.tool_use_id) || def.isWorktree
      const fresh = newAgent(e, { model, isWorktree, cwd: await $.session.cwd(), startedAt })
      await update($, agents, all => keepLast({ ...all, [id]: fresh }))
      const { taskId } = taskMarkOf(e.description)
      // A workflow's agent() or a teammate raises no `agent.report`, so a task it owned would never
      // close: it neither claims nor gets one, and a `#N` only draws it under an open task N.
      const isReporting = e.workflow === undefined && e.isTeammate !== true
      if (taskId !== undefined && !isReporting) {
        const isOpen = await serial($, async () => {
          await restore($).catch(ignore)
          return own(await read($, board), await sessionId($)).tasks.some(x => x.id === taskId && x.status !== 'completed')
        }).catch(() => false)
        if (isOpen) await update($, agents, all => touch(all, id, a => ({ ...a, taskId })))
      } else if (taskId !== undefined && (await claim($, taskId, id).catch(() => false))) {
        await update($, agents, all => touch(all, id, a => ({ ...a, taskId })))
      } else if (taskId === undefined && isReporting) {
        // No mark: the agent gets a task of its own, in progress, with no model call.
        const subject = e.description.trim() || e.subagentType
        const made = await serial($, () => addTasks($, [{ subject, fields: { status: 'in_progress' } }], id)).catch((): PaneTask[] => [])
        const mine = made[0]?.id
        if (mine !== undefined) await update($, agents, all => touch(all, id, a => ({ ...a, taskId: mine })))
      }
    }
    return ran
  })

  // A subagent's effort as its request carries it at this hook's place in the chain: the
  // engine's effective level (env override, per-call `effort`, definition, session, model
  // support and caps applied), absent on a model without effort; a turn.step hook below this
  // one may still change it. A definition file would miss the per-call value, plugin and
  // `--agents` definitions, and the caps. The model is the one the result says answered.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    const effort = typeof e.effort === 'string' ? e.effort : undefined
    await noteRun($, id, { effort }).catch(ignore)
    const res = yield* next(e)
    const answered = (res.usage as { model?: unknown } | null | undefined)?.model
    // `<synthetic>` and the like name a placeholder message, not a model.
    if (typeof answered === 'string' && answered !== '' && !answered.startsWith('<')) {
      await noteRun($, id, { model: answered, effort }).catch(ignore)
    }
    return res
  })

  // Registered before the task tools' hooks, so it is outer: a subagent's task_create is
  // its current call too.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    // The spawn runs inside the Agent call, so its isolation is noted on the way down; a
    // call that never spawns (refused later) leaves its id here, consumed by no one.
    if (e.tool === AGENT && e.isolation === 'worktree' && e.tool_use_id !== undefined) isolatedCalls.add(e.tool_use_id)
    if (agentId === undefined && e.tool === AGENT) {
      const ran = await next(e)
      // A foreground hand-back, for a run whose `agent.report` never came (hooks off): one that
      // came, failed or stopped included, already decided. A background launch (`async_launched`)
      // completes at its report alone.
      const r = ran.result as { status?: unknown; agentId?: unknown } | undefined
      if (ran.deny === undefined && r?.status === 'completed' && typeof r.agentId === 'string') {
        const id = r.agentId
        if ((await read($, agents))[id]?.outcome === undefined) await finish($, id).catch(ignore)
      }
      return ran
    }
    if (agentId === undefined) {
      // A rule a read pulled in rides the next request: a scan after a call keeps the list near
      // live and banks close to an auto-compaction mid-turn.
      const ran = await next(e)
      await queueScan($).catch(ignore)
      return ran
    }
    // Only subagents' calls, and only agents this load saw spawn. A REPL script is no row of
    // its own (its input names no target); the calls it makes are.
    if (e.tool === REPL || (await read($, agents))[agentId] === undefined) return next(e)
    const now = await $.clock.now()
    // Calls of one agent may run side by side: each is marked done by its own sequence number.
    let seq = 0
    let isResumed = false
    await update($, agents, all =>
      // A call from a finished agent is a resume the send did not show (one addressed by name).
      touch(all, agentId, prev => {
        isResumed = !prev.isRunning
        const a = prev.isRunning ? prev : restart(prev, now)
        seq = a.calls + 1
        const call: PaneCall = { seq, tool: String(e.tool), target: targetOf(e as Record<string, unknown>), isCalling: true }
        return { ...a, calls: seq, recent: [call, ...a.recent].slice(0, RECENT_KEPT) }
      }),
    )
    if (isResumed) await reopen($, agentId).catch(ignore)
    const ran = await next(e)
    await update($, agents, all =>
      touch(all, agentId, a => ({ ...a, recent: a.recent.map(c => (c.seq === seq ? { ...c, isCalling: false } : c)) })),
    )
    return ran
  })

  // Each run that ends or is stopped reports here before its parent hears of it, foreground or
  // background (claude-code.d.ts `agent.report`); the report itself passes on as it came.
  on('agent.report', async ($, e, next) => {
    const out = await next(e)
    const outcome = e.status
    await update($, agents, all => touch(all, e.agentId, a => ({ ...a, outcome }))).catch(ignore)
    if (outcome === 'completed') await finish($, e.agentId).catch(ignore)
    return out
  })

  // A message to a finished subagent resumes it from its transcript (SessionSendAddress):
  // the same id and a new run. A send may address the agent by name.
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    const id = idByName.get(e.to) ?? e.to
    if (sent.isDelivered && (await read($, agents))[id]?.isRunning === false) {
      const now = await $.clock.now()
      await update($, agents, all => touch(all, id, a => (a.isRunning ? a : restart(a, now))))
      await reopen($, id).catch(ignore)
    }
    return sent
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId
    if (agentId !== undefined) {
      const endedAt = await $.clock.now()
      await update($, agents, all =>
        touch(all, agentId, a => ({ ...a, isRunning: false, endedAt, recent: a.recent.map(c => ({ ...c, isCalling: false })) })),
      )
    } else {
      // How a /resume or /branch gets its list back: it goes on under another session id with no session.start.
      await restore($).catch(ignore)
      await syncBlink($).catch(ignore)
      await scanInstructions($).catch(ignore)
    }
    return done
  })

  // ---- the task tools ----

  // A subagent's call lands in the same list: the CLI keeps one list per session too.
  // One task by the top-level fields, or several as `tasks`, numbered in order in one
  // board write: the first bad entry denies the call and nothing is created.
  on('tool.call', { tool: CREATE }, async ($, e, next) => serial($, taskBody(next, e.tool_use_id, async () => {
    const entries: unknown[] = Array.isArray(e.tasks) ? e.tasks : [e]
    if (entries.length === 0) return { deny: 'task_create needs a subject, or a non-empty tasks list.' }
    const items: NewItem[] = []
    for (const raw of entries) {
      const c = (raw ?? {}) as Record<string, unknown>
      const subject = str(c.subject)
      if (subject === undefined) return { deny: 'task_create needs a non-empty subject in every task.' }
      if (c.status !== undefined && c.status !== 'pending' && c.status !== 'in_progress') {
        return { deny: `task_create status must be pending or in_progress, not "${String(c.status)}".` }
      }
      items.push({ subject, fields: c })
    }
    const made = await addTasks($, items)
    await remember($, e.tool_use_id, createLines(made))
    // JSON, so a REPL script reads the ids it made; the transcript row shows `remember`'s lines.
    return { result: JSON.stringify({ created: made.map(x => ({ id: x.id, subject: x.subject })) }) }
  }))).catch(failedOrQueued)

  // One task by the top-level fields, or several as `updates`, applied in order in one
  // board write: the first bad entry denies the call and nothing changes.
  on('tool.call', { tool: UPDATE }, async ($, e, next) => serial($, taskBody(next, e.tool_use_id, async () => {
    const entries: unknown[] = Array.isArray(e.updates) ? e.updates : [e]
    if (entries.length === 0) return { deny: 'task_update needs a taskId, or a non-empty updates list.' }
    const patches = []
    for (const raw of entries) {
      const u = (raw ?? {}) as Record<string, unknown>
      const id = idOf(u.taskId)
      if (id === undefined) return { deny: 'task_update needs a taskId in every update.' }
      if (u.status !== undefined && u.status !== 'deleted' && asStatus(u.status) === undefined) {
        return { deny: `Unknown status "${String(u.status)}": use pending, in_progress, completed or deleted.` }
      }
      patches.push(patchOf(id, u))
    }
    await restore($).catch(ignore)
    const team = await read($, agents)
    // The id the Agent result shows is cut short: a unique prefix of a known agent's id (4 characters or more) is that agent.
    for (const p of patches) {
      const prefix = p.owner
      if (prefix === undefined || prefix.length < 4 || team[prefix] !== undefined) continue
      const ids = Object.keys(team).filter(id => id.startsWith(prefix))
      if (ids.length > 1) return { deny: `owner "${prefix}" matches ${ids.length} agents; give more of the id.` }
      if (ids.length === 1) p.owner = ids[0]
    }
    // The clock only when a run can be frozen.
    const now = patches.some(p => p.status === 'completed') && Object.keys(team).length > 0 ? await $.clock.now() : 0
    for (const p of patches) p.runOf = owner => (team[owner] !== undefined ? runOf(team[owner], now) : undefined)
    const sid = await sessionId($)
    let applied: AppliedMany = { error: 'task_update changed nothing.' }
    const was = new Map<string, string>()
    const local = await update($, board, b => {
      const cur = own(b, sid)
      for (const x of cur.tasks) was.set(x.id, x.subject)
      applied = applyPatches(cur.tasks, patches)
      return applied.error !== undefined ? b : { ...cur, tasks: applied.tasks }
    })
    const done = applied as AppliedMany
    if (done.error !== undefined) return { deny: done.error }
    const changed = local.tasks.filter(x => done.touched.includes(x.id))
    const written = await persist($, local, { write: changed, remove: done.removed })
    await syncBlink($).catch(ignore)
    const isLiveTask = (id: string) => written.tasks.find(x => x.id === id)?.status === 'in_progress'
    follow($, done.results.filter(r => r.fields.includes('status') && isLiveTask(r.id)).at(-1)?.id)
    await remember($, e.tool_use_id, updateLines(patches.map(p => ({
      id: p.id,
      status: p.status,
      subject: p.subject ?? written.tasks.find(x => x.id === p.id)?.subject ?? was.get(p.id) ?? '',
    }))))
    return {
      result: done.results
        .map(r => `Updated task #${r.id} ${r.fields.length > 0 ? r.fields.join(', ') : '(no changes)'}`)
        .join('\n'),
    }
  }))).catch(failedOrQueued)

  on('tool.call', { tool: LIST }, async ($, e, next) => serial($, taskBody(next, e.tool_use_id, async () => {
    await restore($).catch(ignore)
    const b = own(await read($, board), await sessionId($))
    return { result: listText(b.tasks) }
  }))).catch(failedOrQueued)

  // A task_create / task_update call's row keeps the engine's header, spinner and error
  // colours; only its input shows as a count. Another tool, or an input with nothing
  // to show, is drawn as it came.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const input = e.props.tool === CREATE || e.props.tool === UPDATE ? summary(e.props.tool, e.props.input) : undefined
    return next(input === undefined ? e : { ...e, props: { ...e.props, input } })
  })

  // The result block under those rows lists one task per line, `#N subject`, from the lines the
  // call left behind, or for task_create from its JSON result. An errored result, another tool,
  // or an update with no lines kept (after /clear or a resume) is drawn as it came.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isErrored || (e.props.tool !== CREATE && e.props.tool !== UPDATE)) return next(e)
    const lines = (await read($, toolRows))[e.props.tool_use_id] ?? (e.props.tool === CREATE ? createdLines(e.props.output) : undefined)
    const output = lines === undefined ? undefined : withText(e.props.output, lines.join('\n'))
    return next(output === undefined ? e : { ...e, props: { ...e.props, output } })
  })

  // The pane's one render hook: the header row (tabs with their counts, the Task tab's
  // filter), then the active tab's view — the tasks with each owner and each agent its `#N`
  // named under its task, with any unclaimed agent under Other, or the instruction files by directory.
  // On the terminal the header stays and the view under it is drawn as a window the wheel
  // moves (the ui.scroll hook below); the header's rule counts the rows above and below it.
  // Another surface gets the tree whole and scrolls it itself.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const draw = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const shown = await read($, tab)
    const all = await read($, agents)
    const list = (await read($, board)).tasks
    const loads = await read($, instructions)
    const isHidden = await read($, isDoneHidden)
    const isLit = await read($, blink)
    const doneCount = list.filter(x => x.status === 'completed').length
    const counts = {
      task: list.length === 0 ? '' : `${doneCount}/${list.length}`,
      prompt: String(Object.keys(loads).length),
    }
    const view =
      shown === 'prompt' ? (
        instructionsTree(draw, t, loads)
      ) : (
        <draw.Box flexDirection="column">
          {tasksTree(draw, t, list, isLit, x => taskAgentsTree(draw, t, x, all, columns, liveOwners(list, isHidden)), isHidden)}
          {otherAgentsTree(draw, t, list, all, columns, isHidden)}
        </draw.Box>
      )
    const top = await read($, scrollTop)
    const w = e.surface === 'terminal' ? windowed(view, e.props.scroll.bodyRows, top[shown], shown === 'task' ? top.follow : undefined) : undefined
    // Only the terminal's draw says where its window stands: another surface draws the whole tree.
    if (e.surface === 'terminal') shownWindow = w !== undefined && w.listRows > w.win ? { tab: shown, offset: w.offset, listRows: w.listRows, win: w.win } : undefined
    // A phone wraps cut lines, so rows cannot be counted there: no count.
    const hint = w !== undefined ? w : e.surface === 'mobile' ? { above: 0, below: 0 } : { above: 0, below: rowsBelow(HEADER_ROWS + treeRows(view), e.props.scroll) }
    return paneTree(
      draw,
      t,
      { tab: shown, counts, onSet: next => update($, tab, () => next) },
      shown === 'task' ? doneFilter(draw, t, list, { isHidden, onSet: v => update($, isDoneHidden, () => v) }) : undefined,
      w !== undefined ? w.view : view,
      columns,
      { above: hint.above, below: hint.below },
    )
  })

  // A wheel tick or scroll key over the pane moves the window under the pinned header; the
  // engine's own window stays put (the tree drawn fits it). The person's move ends a follow.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const s = shownWindow
    // A plugin's move (a follow on another surface) and a surface that draws the whole tree,
    // which has rows of its own to move, are the engine's.
    if (s === undefined || e.origin.kind !== 'person' || e.contentRows > e.bodyRows) return next(e)
    // A page key (or Home/End, which the fitted tree makes a page too) moves one window, not the body's rows.
    const by = e.pointer === undefined && Math.abs(e.by) >= e.bodyRows ? Math.sign(e.by) * s.win : e.by
    await update($, scrollTop, cur => {
      // From the stored offset, so ticks landing before the redraw add up; a follow's placement
      // lives only in the last draw.
      const base = s.tab === 'task' && cur.follow !== undefined ? s.offset : clampOffset(cur[s.tab], s.listRows, s.win)
      const offset = clampOffset(base + by, s.listRows, s.win)
      if (s.tab !== 'task') return { ...cur, [s.tab]: offset }
      const { follow: _follow, ...rest } = cur
      return { ...rest, task: offset }
    })
    return {}
  })
}
