import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

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
  otherAgentsTree,
  taskAgentsTree,
  taskMarkOf,
  touch,
} from './agents'
import { flag, idOf, newTask, patchOf } from './input'
import { bankIfShrunk, diskBody, instructionsTree, mergeLoads, scanLoads } from './instructions'
import { failureText, HOOK_LIMIT_MS, isOutOfTime, paneTree, QUEUED_TOO_LONG, remind, withContext } from './pane'
import { slashed } from './platform'
import { EN } from './strings'
import type { AppliedMany } from './tasks'
import { createdLines, createLines, summary, updateLines, withText } from './toolrow'
import {
  applyPatches,
  asStatus,
  asTask,
  doneFilter,
  EMPTY,
  handbackText,
  listText,
  namesId,
  own,
  ownersIn,
  str,
  taskKey,
  tasksTree,
  toolsFor,
} from './tasks'

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

const t = EN

const PANE = 'manage-pane'
// Here rather than in ./tasks: a matcher's literal is read off this file's source.
const CREATE = 'mcp__manage-pane__task_create'
const UPDATE = 'mcp__manage-pane__task_update'
const LIST = 'mcp__manage-pane__task_list'
const AGENT = 'Agent'
// The tool a subagent ends its run with in auto mode (not a fork); a background agent's report
// then reaches the main loop as a peer prompt. Whether a foreground one's also does is unverified.
const HANDBACK = 'SubagentHandback'
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
  if (live && blinkTimer === undefined) {
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
// that shows it whole. On the clock: after the redraw that draws it.
const follow = ($: EngineInterface, id: string | undefined) => {
  if (id === undefined) return
  $.clock.after(1, () => void $.ui.scroll({ to: { key: taskKey(id) }, in: PANE }).catch(ignore))
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
let taskQueue: Promise<unknown> = Promise.resolve()
const serial = <T,>($: EngineInterface, body: () => Promise<T>): Promise<T> => {
  const run = taskQueue.then(body)
  let timer: { cancel: () => void } | undefined
  const stalled = new Promise<void>(resolve => {
    try {
      timer = $.clock.after(HOOK_LIMIT_MS, resolve)
    } catch {
      // No clock: the queue waits on the run alone.
    }
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
let scanQueued = false
const queueScan = ($: EngineInterface) => {
  if (scanQueued) return
  scanQueued = true
  $.clock.after(1, () => {
    scanQueued = false
    void scanInstructions($).catch(ignore)
  })
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

// ---- open-task reminders: a tool result's `context`, which the model reads and the user
// never sees. Not the system prompt (a section change busts the prompt cache) and not the
// prompt's text (a rewrite changes the message on screen). Main loop only.

const currentTasks = async ($: EngineInterface) => own(await read($, board), await sessionId($)).tasks

// Subagents whose SubagentHandback call has run and whose report has not yet reached the main
// loop. A peer prompt counts as a hand-back only from one of these: a mid-run SendMessage
// arrives in the same envelope.
// Keyed by agent id.
const handingBack = new Set<string>()
// Agents whose hand-back a peer prompt already told, so a foreground Agent result still pending tells none.
const told = new Set<string>()
// An agent spawned with a name, by that name: SendMessage addresses it so.
const idByName = new Map<string, string>()
// The envelope's opening line, at column zero: the harness indents the report under it. Seen live
// with an agent id as the sender; a named agent's envelope sender is unverified live, so a name
// is mapped to its id when it is one this load saw spawn.
const ENVELOPE = /^<agent-message from="([^"]+)">/

const forgetHandbacks = () => {
  handingBack.clear()
  told.clear()
  idByName.clear()
}

// A foreground Agent call resolves when the subagent has handed back; a background
// launch (`async_launched`) is not one, its report comes as a task notification or a peer prompt.
const agentHandback = async ($: EngineInterface, ran: ToolCallResult) => {
  const r = ran.result as { status?: unknown; agentId?: unknown } | undefined
  if (r?.status !== 'completed' || typeof r.agentId !== 'string') return ran
  // Whether a foreground hand-back also yields a peer prompt is unverified: one that already
  // told this hand-back leaves the result as it is, and one still to come tells nothing.
  handingBack.delete(r.agentId)
  if (told.delete(r.agentId)) return ran
  return withContext(ran, handbackText(await currentTasks($).catch(() => []), [r.agentId]))
}

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

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pane', description: t.commandDescription }).catch(ignore)
    const { language } = (await $.settings.read().catch(() => undefined)) ?? {}
    for (const tool of toolsFor({ language })) await $.tool.register(tool).catch(ignore)
    await restore($).catch(ignore)
    // A reload starts with no timer: an in-progress task left in the state blinks again.
    blinkTimer = undefined
    await syncBlink($).catch(ignore)
    const started = await next(e)
    // On the clock, off the start's path; never the current session's list.
    const sid = await sessionId($)
    $.clock.after(1, () => void prune($, BOARDS_KEPT, sid).catch(ignore))
    await scanInstructions($).catch(ignore)
    if (openOnStart && e.isInteractive !== false) await openPane($).catch(ignore)
    return started
  })

  // A /clear starts a new conversation: no tasks, its agents are not this one's, and
  // its instruction files are loaded afresh.
  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (e.reason === 'resume' || e.reason === 'clear') forgetHandbacks()
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

  // A resume keeps its row; `session.send` and the agent's next call restart it.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume) {
      const resumed = await next(e)
      // The new run's peer messages are not the old run's report, however the resume was addressed.
      // A resume that lands before the old report's prompt.submit drops that report's note (accepted).
      if (resumed.deny === undefined) {
        handingBack.delete(e.resume.agentId)
        told.delete(e.resume.agentId)
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
      if (taskId !== undefined && (await claim($, taskId, id).catch(() => false))) {
        await update($, agents, all => touch(all, id, a => ({ ...a, taskId })))
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
  // its current call too, and a task tool's reminder passes through it untouched.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    // The spawn runs inside the Agent call, so its isolation is noted on the way down; a
    // call that never spawns (refused later) leaves its id here, consumed by no one.
    if (e.tool === AGENT && e.isolation === 'worktree' && e.tool_use_id !== undefined) isolatedCalls.add(e.tool_use_id)
    if (agentId === undefined && e.tool === AGENT) {
      const ran = await next(e)
      return agentHandback($, ran)
    }
    if (agentId === undefined) {
      // A rule a read pulled in rides the next request: a scan after a call keeps the list near
      // live and banks close to an auto-compaction mid-turn.
      const ran = await next(e)
      queueScan($)
      return ran
    }
    // Only subagents' calls, and only agents this load saw spawn. A REPL script is no row of
    // its own (its input names no target); the calls it makes are.
    if (e.tool === REPL || (await read($, agents))[agentId] === undefined) return next(e)
    const now = await $.clock.now()
    // Calls of one agent may run side by side: each is marked done by its own sequence number.
    let seq = 0
    await update($, agents, all =>
      // A call from a finished agent is a resume the send did not show (one addressed by name).
      touch(all, agentId, prev => {
        const a = prev.isRunning ? prev : restart(prev, now)
        seq = a.calls + 1
        const call: PaneCall = { seq, tool: String(e.tool), target: targetOf(e as Record<string, unknown>), isCalling: true }
        return { ...a, calls: seq, recent: [call, ...a.recent].slice(0, RECENT_KEPT) }
      }),
    )
    const ran = await next(e)
    await update($, agents, all =>
      touch(all, agentId, a => ({ ...a, recent: a.recent.map(c => (c.seq === seq ? { ...c, isCalling: false } : c)) })),
    )
    return ran
  })

  // Marked before the call runs: its report can reach the main loop before this hook resumes.
  on('tool.call', { tool: HANDBACK }, async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    handingBack.add(agentId)
    try {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) handingBack.delete(agentId)
      return ran
    } catch (err) {
      handingBack.delete(agentId)
      throw err
    }
  })

  // A message to a finished subagent resumes it from its transcript (SessionSendAddress):
  // the same id and a new run; the `agent.spawn` it also fires (`e.resume`) is passed by.
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    // A fallback for the drop in `agent.spawn`'s resume branch; a send may address the agent by name.
    // A resume that lands before the old report's prompt.submit drops that report's note (accepted).
    const id = idByName.get(e.to) ?? e.to
    if (sent.isDelivered && (await read($, agents))[id]?.isRunning === false) {
      handingBack.delete(id)
      told.delete(id)
    }
    if (sent.isDelivered && (await read($, agents))[e.to]?.isRunning === false) {
      const now = await $.clock.now()
      await update($, agents, all => touch(all, e.to, a => (a.isRunning ? a : restart(a, now))))
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

  // A background agent's report reaches the main loop as a prompt of its own and carries the
  // reminder in its `context`, the text left as it came. As a task notification, the owners its
  // text names are handed back, and another notification (a background command) gets the open
  // list alone. As a peer prompt (`<agent-message from="…">`, after the agent's SubagentHandback
  // call), only the sender is: the report body may name other agents, and a peer prompt from an
  // agent that has not handed back, or in another envelope, gets nothing.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind as string
    if (kind === 'task-notification') {
      // A report told this way leaves no hand-back waiting for a peer prompt.
      for (const id of [...handingBack]) if (namesId(e.text, id)) handingBack.delete(id)
      const tasks = await currentTasks($).catch(() => [])
      const line = handbackText(tasks, ownersIn(tasks, e.text))
      return next(line === undefined ? e : { ...e, context: [...(e.context ?? []), line] })
    }
    const sender = kind === 'peer' ? ENVELOPE.exec(e.text)?.[1] : undefined
    const id = sender === undefined ? undefined : (idByName.get(sender) ?? sender)
    if (id === undefined || !handingBack.delete(id)) return next(e)
    told.add(id)
    const line = handbackText(await currentTasks($).catch(() => []), [id])
    return next(line === undefined ? e : { ...e, context: [...(e.context ?? []), line] })
  })

  // ---- the task tools ----

  // A subagent's call lands in the same list: the CLI keeps one list per session too.
  // One task by the top-level fields, or several as `tasks`, numbered in order in one
  // board write: the first bad entry denies the call and nothing is created.
  on('tool.call', { tool: CREATE }, async ($, e, next) => serial($, taskBody(next, e.tool_use_id, async () => {
    const entries: unknown[] = Array.isArray(e.tasks) ? e.tasks : [e]
    if (entries.length === 0) return { deny: 'task_create needs a subject, or a non-empty tasks list.' }
    const items: { subject: string; fields: Record<string, unknown> }[] = []
    for (const raw of entries) {
      const c = (raw ?? {}) as Record<string, unknown>
      const subject = str(c.subject)
      if (subject === undefined) return { deny: 'task_create needs a non-empty subject in every task.' }
      if (c.status !== undefined && c.status !== 'pending' && c.status !== 'in_progress') {
        return { deny: `task_create status must be pending or in_progress, not "${String(c.status)}".` }
      }
      items.push({ subject, fields: c })
    }
    await restore($).catch(ignore)
    const sid = await sessionId($)
    // Another process of the same session may have minted ids since this one loaded.
    const stored = (sid === undefined ? undefined : await storedBoard($, sid))?.lastId ?? 0
    const seen = { wasIdle: false }
    const local = await update($, board, b => {
      const cur = own(b, sid)
      const first = Math.max(cur.lastId, stored, ...cur.tasks.map(x => Number(x.id))) + 1
      const made = items.map((it, i) => newTask(first + i, it.subject, it.fields))
      seen.wasIdle = cur.tasks.every(x => x.status === 'completed')
      return { sessionId: cur.sessionId, lastId: first + items.length - 1, tasks: [...cur.tasks, ...made] }
    })
    const made = local.tasks.slice(-items.length)
    const written = await persist($, local, { write: made })
    // The first task of a list reopens the pane; one the person closed mid-list stays
    // closed until the next list. /pane toggles it any time. The tab the person picked
    // stays put: the Task tab redraws from the board whether it is shown or not.
    if (seen.wasIdle) await openPane($).catch(ignore)
    await syncBlink($).catch(ignore)
    follow($, made.filter(x => x.status === 'in_progress').at(-1)?.id)
    await remember($, e.tool_use_id, createLines(made))
    // JSON, so a REPL script reads the ids it made; the transcript row shows `remember`'s lines.
    return {
      result: JSON.stringify({ created: made.map(x => ({ id: x.id, subject: x.subject })) }),
      ...remind(e.agentId, written.tasks),
    }
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
      ...remind(e.agentId, written.tasks),
    }
  }))).catch(failedOrQueued)

  // No reminder here: the result already is the whole list, statuses and owners included.
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
  // The tree is drawn whole; a list taller than the pane is the engine's to scroll.
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
    return paneTree(
      draw,
      t,
      { tab: shown, counts, onSet: next => update($, tab, () => next) },
      shown === 'task' ? doneFilter(draw, t, list, { isHidden, onSet: v => update($, isDoneHidden, () => v) }) : undefined,
      shown === 'prompt'
        ? instructionsTree(draw, t, loads)
        : (
            <draw.Box flexDirection="column">
              {tasksTree(draw, t, list, isLit, x => taskAgentsTree(draw, t, x, all, columns), isHidden)}
              {otherAgentsTree(draw, t, list, all, columns, isHidden)}
            </draw.Box>
          ),
      columns,
    )
  })
}
