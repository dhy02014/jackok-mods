import type { Elements, RenderSurface } from 'claude-code'

import type { PaneBoard, PaneOwnerRun, PaneTask, PaneTaskStatus } from '../types'
import type { Strings } from './strings'

// The task list's pure half: the tool specs, the list step task_update applies, the
// stored and mirrored task shape, and the tree the pane's upper part draws. Every hook and every
// `$` call is in ./register.tsx (the engine follows `$` into no imported file).

export const EMPTY: PaneBoard = { sessionId: null, lastId: 0, tasks: [] }

export const MARK: Record<PaneTaskStatus, string> = { pending: '○', in_progress: '◐', completed: '✓' }
const COLOR: Record<PaneTaskStatus, string> = { pending: 'white', in_progress: 'yellow', completed: 'green' }

const UPDATE_FIELDS = {
  taskId: { type: 'string' },
  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
  subject: { type: 'string' },
  activeForm: { type: 'string' },
  owner: { type: 'string' },
} as const

const UPDATE_DESCRIPTION =
  'taskId is required. Every field that changes goes in one call; several tasks go in one call as `updates`, in order, all or nothing.'
const CLAIM_DESCRIPTION = ' An Agent description opening `#N ` claims task N itself; owner here reassigns ("" clears).'

// Subject and activeForm are the person's to read, so they follow the settings' `language`; no language set:
// no sentence. The pane's own words stay English (./strings).
export const toolsFor = (o: { language?: unknown }) => {
  const lang = typeof o.language === 'string' && o.language.trim() !== '' ? o.language.trim() : undefined
  const inLang = lang === undefined ? '' : ` Write subject and activeForm in ${lang}.`
  return TOOLS.map(t =>
    t.name === 'task_update'
      ? { ...t, description: UPDATE_DESCRIPTION + CLAIM_DESCRIPTION + inLang }
      : t.name === 'task_create'
        ? { ...t, description: t.description + inLang }
        : t,
  )
}

export const TOOLS = [
  {
    name: 'task_create',
    isDeferred: false,
    description:
      'Track work as tasks; subject is required, status in_progress starts it now. Several go in one call as `tasks`, in order.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        activeForm: { type: 'string' },
        status: { type: 'string', enum: ['in_progress'] },
        tasks: { type: 'array', description: 'Items take the fields above.', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'task_update',
    isDeferred: false,
    description: UPDATE_DESCRIPTION + CLAIM_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        ...UPDATE_FIELDS,
        updates: { type: 'array', description: 'Items take the fields above.', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'task_list',
    // Deferred: the Open-tasks reminder covers the common case; this is for after a compaction.
    isDeferred: true,
    description: 'List open tasks with status and blockers.',
  },
] as const

export const asStatus = (v: unknown): PaneTaskStatus | undefined =>
  v === 'pending' || v === 'in_progress' || v === 'completed' ? v : undefined

export const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

export const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []

// The list belongs to one session id: a /clear (a new id) starts an empty one.
export const own = (b: PaneBoard, sid: string | undefined): PaneBoard =>
  sid === undefined || b.sessionId === sid ? b : { ...EMPTY, sessionId: sid }

const asRun = (v: unknown): PaneOwnerRun | undefined => {
  const r = v as Record<string, unknown> | null | undefined
  if (typeof r?.type !== 'string' || typeof r.ms !== 'number') return undefined
  return {
    type: r.type,
    ms: r.ms,
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    ...(typeof r.effort === 'string' ? { effort: r.effort } : {}),
  }
}

// A task as read back from `$.store`; undefined for anything that is not one. Ids are decimal:
// the next id is minted from the largest, and the mirror names files by it.
export const asTask = (raw: unknown): PaneTask | undefined => {
  const r = raw as Record<string, unknown> | null
  const id = str(r?.id)
  const status = asStatus(r?.status)
  if (r === null || id === undefined || !/^\d+$/.test(id) || status === undefined) return undefined
  return {
    id,
    subject: str(r.subject) ?? id,
    description: typeof r.description === 'string' ? r.description : '',
    status,
    activeForm: str(r.activeForm),
    owner: str(r.owner),
    ownerRun: asRun(r.ownerRun),
    blocks: strings(r.blocks),
    blockedBy: strings(r.blockedBy),
  }
}

// The mirror file: exactly the CLI's task-file keys and layout, plus `ownerRun`, which only this pane reads.
export const fileText = (t: PaneTask) =>
  JSON.stringify(
    {
      id: t.id,
      subject: t.subject,
      description: t.description,
      ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
      status: t.status,
      ...(t.owner !== undefined ? { owner: t.owner } : {}),
      ...(t.ownerRun !== undefined ? { ownerRun: t.ownerRun } : {}),
      blocks: t.blocks,
      blockedBy: t.blockedBy,
    },
    null,
    2,
  )

// ---- task_update as a pure step over the list ----

export type Patch = {
  id: string
  status?: PaneTaskStatus | 'deleted'
  subject?: string
  activeForm?: string
  /** An agent id; "" clears it. */
  owner?: string
  addBlockedBy: string[]
  /** The owner's run so far, by agent id; undefined for one this load never saw spawn. */
  runOf?: (owner: string) => PaneOwnerRun | undefined
}

export type Applied =
  | { error: string }
  | { error?: undefined; tasks: PaneTask[]; fields: string[]; touched: string[]; removed: string[] }

export const applyPatch = (list: readonly PaneTask[], p: Patch): Applied => {
  if (!list.some(t => t.id === p.id)) return { error: `Task #${p.id} not found.` }
  const unknown = p.addBlockedBy.filter(b => !list.some(t => t.id === b))
  if (unknown.length > 0) return { error: `Task #${unknown.join(', #')} not found.` }

  if (p.status === 'deleted') {
    const touched: string[] = []
    const tasks = list
      .filter(t => t.id !== p.id)
      .map(t => {
        if (!t.blocks.includes(p.id) && !t.blockedBy.includes(p.id)) return t
        touched.push(t.id)
        return { ...t, blocks: t.blocks.filter(b => b !== p.id), blockedBy: t.blockedBy.filter(b => b !== p.id) }
      })
    return { tasks, fields: ['deleted'], touched, removed: [p.id] }
  }

  const byId = new Map(list.map(t => [t.id, { ...t, blocks: [...t.blocks], blockedBy: [...t.blockedBy] }]))
  const me = byId.get(p.id)!
  const fields: string[] = []
  const touched = new Set<string>()
  const set = <K extends 'status' | 'subject' | 'activeForm' | 'owner'>(k: K, v: PaneTask[K] | undefined) => {
    if (v === undefined || me[k] === v) return
    me[k] = v
    fields.push(k)
  }
  set('status', p.status)
  set('subject', p.subject)
  set('activeForm', p.activeForm)
  if (p.owner === '' && me.owner !== undefined) {
    delete me.owner
    fields.push('owner')
  } else if (p.owner !== '') set('owner', p.owner)
  // Completing freezes the owner's run on the task; reopening or a new owner thaws it.
  if (fields.includes('status') || fields.includes('owner')) {
    const run = me.status === 'completed' && me.owner !== undefined ? p.runOf?.(me.owner) : undefined
    if (run !== undefined) me.ownerRun = run
    else delete me.ownerRun
  }
  // Each link is written on both ends, as the CLI keeps `blocks` and `blockedBy`.
  const link = (from: PaneTask, to: PaneTask) => {
    if (from.id === to.id || from.blocks.includes(to.id)) return false
    from.blocks.push(to.id)
    if (!to.blockedBy.includes(from.id)) to.blockedBy.push(from.id)
    touched.add(from.id).add(to.id)
    return true
  }
  if (p.addBlockedBy.map(b => link(byId.get(b)!, me)).includes(true)) fields.push('blockedBy')
  if (fields.length > 0) touched.add(me.id)
  return { tasks: list.map(t => byId.get(t.id)!), fields, touched: [...touched], removed: [] }
}

export type AppliedMany =
  | { error: string }
  | { error?: undefined; tasks: PaneTask[]; results: { id: string; fields: string[] }[]; touched: string[]; removed: string[] }

// Several patches in order, all or nothing: the first error leaves the list as it was.
export const applyPatches = (list: readonly PaneTask[], patches: readonly Patch[]): AppliedMany => {
  let tasks = [...list]
  const results: { id: string; fields: string[] }[] = []
  const touched = new Set<string>()
  const removed = new Set<string>()
  for (const p of patches) {
    const done = applyPatch(tasks, p)
    if (done.error !== undefined) return { error: done.error }
    tasks = done.tasks
    results.push({ id: p.id, fields: done.fields })
    for (const t of done.touched) touched.add(t)
    for (const r of done.removed) removed.add(r)
  }
  return { tasks, results, touched: [...touched].filter(t => !removed.has(t)), removed: [...removed] }
}

// The tasks left to do, then how many are completed: a completed task changes no next
// step, so the model's context carries its count, never its line.
export const listText = (tasks: readonly PaneTask[]) => {
  if (tasks.length === 0) return 'No tasks found.'
  const left = tasks.filter(t => t.status !== 'completed')
  const done = tasks.length - left.length
  if (left.length === 0) return `No open tasks (${done} completed).`
  const open = new Set(left.map(t => t.id))
  const lines = left.map(t => {
    const waiting = t.blockedBy.filter(b => open.has(b))
    const blocked = waiting.length > 0 ? ` [blocked by #${waiting.join(', #')}]` : ''
    const owner = t.owner !== undefined ? ` (owner: ${t.owner})` : ''
    return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`
  })
  return [...lines, ...(done > 0 ? [`(${done} completed, not listed)`] : [])].join('\n')
}

// ---- what the main loop is reminded of: model-only context, never the system prompt ----

const SUBJECT_MAX = 60
const OWNER_SHOWN = 8

const clip = (s: string) => (s.length > SUBJECT_MAX ? `${s.slice(0, SUBJECT_MAX - 1)}…` : s)

const openOf = (tasks: readonly PaneTask[]) => tasks.filter(t => t.status !== 'completed')

// `Open tasks: #2 [in_progress] subject (owner: a1b2c3d4), #4 [pending] subject`, or
// undefined while every task is completed. The reminder on a task tool's own result
// drops subjects (`#2 [in_progress]`): the model just wrote them and they are in context.
export const openText = (tasks: readonly PaneTask[], withSubject = true) => {
  const open = openOf(tasks)
  if (open.length === 0) return undefined
  const rows = open.map(t => {
    const owner = t.owner !== undefined ? ` (owner: ${t.owner.slice(0, OWNER_SHOWN)})` : ''
    return `#${t.id} [${t.status}]${withSubject ? ` ${clip(t.subject)}` : ''}${owner}`
  })
  return `Open tasks: ${rows.join(', ')}`
}

// The owners of open tasks that `text` names as a whole token: a notification's text
// is the engine's prose, so the id is looked for rather than parsed out of a format.
export const ownersIn = (tasks: readonly PaneTask[], text: string) =>
  [...new Set(openOf(tasks).flatMap(t => (t.owner !== undefined ? [t.owner] : [])))].filter(id =>
    new RegExp(`(?:^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9]|$)`).test(text),
  )

// The reminder at a hand-back: the tasks each agent owns, then the open list. With no
// agent named (a notification no owner matched) the open list alone.
export const handbackText = (tasks: readonly PaneTask[], agentIds: readonly string[]) => {
  const open = openText(tasks)
  if (open === undefined) return undefined
  const lines = agentIds.map(id => {
    const owned = openOf(tasks).filter(t => t.owner === id)
    const label = id.slice(0, OWNER_SHOWN)
    return owned.length === 0
      ? `Agent ${label} handed back.`
      : `Agent ${label} handed back; it owns #${owned.map(t => t.id).join(', #')} — reassign, clear owner, or complete it.`
  })
  return [...lines, open].join(' ')
}

// The constructors a tree is drawn with: `$.ui.resolve(e)`'s, handed in by the render hook.
export type Draw = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button'>

// A task's rows (its line, activeForm and owner) as one element, so `$.ui.scroll` can bring it into view.
export const taskKey = (id: string) => `pane-task:${id}`

// The Task tab's `[all] [open]` filter, drawn on the pane's header row: shown only while a
// task is completed, the active one at full strength.
export const doneFilter = (
  { Box, Text, Button }: Draw,
  t: Strings,
  list: readonly PaneTask[],
  done: { isHidden: boolean; onSet: (isHidden: boolean) => unknown },
) =>
  list.some(x => x.status === 'completed') ? (
    <Box key="pane-filter">
      <Button key="filter-all" plain dimColor={done.isHidden} label={t.filterAll} onPress={() => done.onSet(false)} />
      <Text> </Text>
      <Button key="filter-open" plain dimColor={!done.isHidden} label={t.filterOpen} onPress={() => done.onSet(true)} />
    </Box>
  ) : undefined

// The Task tab's body: one row per task (two while in progress), and under each task
// what `below` draws for it (its agents, if any); with the filter on `[open]` the completed ones are left out.
export const tasksTree = (
  { Box, Text }: Draw,
  s: Strings,
  list: readonly PaneTask[],
  isLit: boolean,
  below: (t: PaneTask) => JSX.Element | undefined = () => undefined,
  isDoneHidden = false,
) => {
  const open = new Set(list.filter(t => t.status !== 'completed').map(t => t.id))
  const shown = isDoneHidden ? list.filter(t => open.has(t.id)) : list
  return (
    <Box flexDirection="column">
      {list.length === 0 && <Text dimColor>{s.noTasks}</Text>}
      {shown.map(t => {
        const waiting = t.blockedBy.filter(b => open.has(b))
        const isLive = t.status === 'in_progress'
        return (
          <Box key={taskKey(t.id)} flexDirection="column">
            <Text wrap="truncate-end" dimColor={t.status === 'completed'}>
              <Text color={COLOR[t.status]} dimColor={isLive && !isLit}>
                {MARK[t.status]}{' '}
              </Text>
              <Text dimColor>#{t.id} </Text>
              <Text weight={isLive ? 'bold' : undefined} strikethrough={t.status === 'completed'}>
                {t.subject}
              </Text>
              {waiting.length > 0 && <Text dimColor>{s.blockedBy(waiting)}</Text>}
            </Text>
            {t.status === 'in_progress' && t.activeForm !== undefined && (
              <Text wrap="truncate-end" color="yellow">
                {'  '}
                {t.activeForm}
              </Text>
            )}
            {below(t)}
          </Box>
        )
      })}
    </Box>
  )
}
