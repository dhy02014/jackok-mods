import { expect, mock, test } from 'claude-code/testing'
import { START, HOME, CREATE, UPDATE, LIST, stub, mountPane, said, created, SID2_BOARD, done, instructionStub, reminder, rows } from './helpers'
import type { StoredBoard } from './helpers'

test('built-in tool descriptions stay as they are; task_create teaches the `#N` claim and replaces the built-in task tools', async ($, on) => {
  const { specText } = stub(on)
  on('tool.describe', ($, e) => ({ description: e.description }))
  await $.session.start(START)
  expect((await $.tool.describe({ tool: 'Agent', description: 'Launch an agent.' })).description).toBe('Launch an agent.')
  expect((await $.tool.describe({ tool: 'Bash', description: 'Run a command.' })).description).toBe('Run a command.')
  expect(specText[0]).toContain('An Agent description starting `#3 ` claims task 3.')
  expect(specText[0]).toContain('not TaskCreate/TaskUpdate/TodoWrite')
})

test('create, update and delete keep the list in the store alone: no file write, no tasks-directory read, no process', async ($, on) => {
  const cli = `${HOME}/.claude/tasks/sid-1`
  const { files, writes, reads, argvs, json, storeSets } = stub(on, { files: { [`${cli}/5.json`]: '{}', [`${cli}/.highwatermark`]: '7' } })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: CREATE, tasks: [{ subject: 'One' }, { subject: 'Two' }] }))).toBe(created(['1', 'One'], ['2', 'Two']))
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'deleted' })
  expect(json('sid-1', '1')).toMatchObject({ subject: 'One', status: 'completed' })
  expect(storeSets.every(k => k === 'board:sid-1')).toBe(true)
  // The CLI's own files there neither move the ids nor are read or touched.
  expect(writes).toEqual([])
  expect(reads.filter(p => p.includes('/tasks/'))).toEqual([])
  expect([...files.keys()]).toEqual([`${cli}/5.json`, `${cli}/.highwatermark`])
  expect(argvs).toEqual([])
})

test('on a Windows home with no HOME, a list runs no process and leaves no file, temp or otherwise', async ($, on) => {
  const { files, writes, argvs } = stub(on, { env: { USERPROFILE: 'C:\\Users\\u' } })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, tasks: [{ subject: 'One' }, { subject: 'Two' }] })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'deleted' })
  expect(argvs.flat().filter(a => a.includes('/bin/'))).toEqual([])
  expect(argvs).toEqual([])
  expect(writes).toEqual([])
  expect([...files.keys()].filter(p => p.endsWith('.tmp'))).toEqual([])
})

test('the three tools are registered in front with the built-ins’ required fields, kept small', async ($, on) => {
  const { registered, specText } = stub(on)
  await $.session.start(START)
  expect(registered).toEqual([
    // subject is required per entry: at the top level or in each of `tasks`.
    { name: 'task_create', isDeferred: false, required: undefined },
    // taskId is required per entry: a call carries it at the top level or in each of `updates`.
    { name: 'task_update', isDeferred: false, required: undefined },
    // Deferred: the open-task reminder covers it outside a compaction.
    { name: 'task_list', isDeferred: true, required: undefined },
  ])
  // Descriptions plus schemas stay small: `updates` and `tasks` cost ~100 characters each
  // once and save a whole tool call per batched update or create; the result's JSON shape ~45.
  expect(specText.join('').length).toBeLessThan(1100)
  // The spec teaches the `#N` claim.
  expect(specText.join('')).toContain('starting `#3 ` claims task 3')
})

test('create → update → list: the pane, the tool results and the store agree', async ($, on) => {
  const { opened, json } = stub(on)
  await $.session.start(START)
  expect(opened).toEqual(['manage-pane'])

  expect(said(await $.tool.call({ tool: CREATE, subject: 'Read the types', description: 'd1' }))).toBe(
    created(['1', 'Read the types']),
  )
  await $.tool.call({ tool: CREATE, subject: 'Write the pane', description: 'd2', activeForm: 'Writing the pane' })
  await $.tool.call({ tool: CREATE, subject: 'Old step', description: 'd3' })
  // Only the first task of a list opens it again.
  expect(opened).toEqual(['manage-pane', 'manage-pane'])

  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' }))).toBe('Updated task #1 status')
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '2', status: 'in_progress', addBlockedBy: ['3'] }))).toBe(
    'Updated task #2 status, blockedBy',
  )
  expect(json('sid-1', '3')).toMatchObject({ blocks: ['2'] })
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '3', status: 'deleted' }))).toBe('Updated task #3 deleted')
  // Several tasks in one call, in order: one result line each.
  expect(
    said(
      await $.tool.call({
        tool: UPDATE,
        updates: [
          { taskId: '1', status: 'in_progress' },
          { taskId: '1', status: 'completed' },
          { taskId: '2', activeForm: 'Writing the pane' },
        ],
      }),
    ),
  ).toBe('Updated task #1 status\nUpdated task #1 status\nUpdated task #2 (no changes)')

  const ui = await mountPane($)
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.label).toBe('Task 1/2')
  // A dim rule parts the header from the rows.
  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(50))
  expect(await ui.find({ type: 'Text', text: 'Read the types' })).toBeDefined()
  // Each row is numbered as its id, rows in id order.
  expect((await ui.findAll({ type: 'Text', text: /^#\d+ $/ })).map(t => t.text)).toEqual(['#1 ', '#2 '])
  // The count row's [all] [open] filter hides the completed tasks, then shows them again;
  // the active one is drawn at full strength.
  expect((await ui.find({ key: 'filter-all' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'filter-open' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'filter-open' })
  expect(await ui.find({ type: 'Text', text: 'Read the types' })).toBeUndefined()
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.label).toBe('Task 1/2')
  expect((await ui.find({ key: 'filter-open' }))?.props.dimColor).toBe(false)
  // Pressing the active one again changes nothing.
  await ui.press({ key: 'filter-open' })
  expect(await ui.find({ type: 'Text', text: 'Read the types' })).toBeUndefined()
  await ui.press({ key: 'filter-all' })
  expect(await ui.find({ type: 'Text', text: 'Read the types' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Writing the pane' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Old step' })).toBeUndefined()
  // A blocker that was deleted no longer blocks.
  expect(await ui.find({ type: 'Text', text: /blocked by/ })).toBeUndefined()

  // Completed tasks are a count, not lines.
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#2 [in_progress] Write the pane\n(1 completed, not listed)')

  expect(json('sid-1', '3')).toBeUndefined()
  // The store keeps no activeForm key when none was given.
  expect(Object.keys(json('sid-1', '1')!)).not.toContain('activeForm')
  expect(json('sid-1', '2')).toMatchObject({ subject: 'Write the pane', activeForm: 'Writing the pane', status: 'in_progress' })
})

test('ids only climb: a deleted id is not reused, a /clear starts at 1, a resume continues past the store', async ($, on) => {
  const { session, json } = stub(on, {
    store: {
      'board:sid-old': {
        at: 1,
        lastId: 7,
        tasks: [{ id: '4', subject: 'Left open', description: '', status: 'pending', blocks: [], blockedBy: [] }],
      },
    },
  })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'A', description: '' })
  await $.tool.call({ tool: CREATE, subject: 'B', description: '' })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'deleted' })
  expect(said(await $.tool.call({ tool: CREATE, subject: 'C', description: '' }))).toBe(created(['3', 'C']))

  // /clear: the old list goes, and the new session id counts from 1 under its own key.
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: {} as never })
  session.id = 'sid-2'
  expect(said(await $.tool.call({ tool: LIST }))).toBe('No tasks found.')
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Fresh', description: '' }))).toBe(
    created(['1', 'Fresh']),
  )
  expect(json('sid-2', '1')).toMatchObject({ subject: 'Fresh' })
  expect(json('sid-1', '3')).toMatchObject({ subject: 'C' })

  // A /resume (no session.start) picks its tasks back up on the next task call and mints past the stored mark.
  session.id = 'sid-old'
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#4 [pending] Left open')
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Next', description: '' }))).toBe(
    created(['8', 'Next']),
  )
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '4', status: 'completed' }))).toBe('Updated task #4 status')
})

test('/pane toggles it; one closed mid-list stays closed until the next list', async ($, on) => {
  const { panes } = stub(on)
  await $.session.start(START)
  expect(panes.has('manage-pane')).toBe(true)
  await $.tool.call({ tool: CREATE, subject: 'One', description: 'd' })

  expect(await $.command.run({ command: 'pane' })).toMatchObject({ text: 'Pane closed.' })
  expect(panes.has('manage-pane')).toBe(false)
  await $.tool.call({ tool: CREATE, subject: 'Two', description: 'd' })
  expect(panes.has('manage-pane')).toBe(false)

  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'completed' })
  await $.tool.call({ tool: CREATE, subject: 'Next list', description: 'd' })
  expect(panes.has('manage-pane')).toBe(true)

  expect(await $.command.run({ command: 'pane' })).toMatchObject({ text: 'Pane closed.' })
  expect(await $.command.run({ command: 'pane' })).toMatchObject({ text: 'Pane opened.' })
})

test('with open_on_start off an interactive start opens nothing; the first task of a list still does', { options: { open_on_start: false } }, async ($, on) => {
  const { opened } = stub(on)
  await $.session.start(START)
  expect(opened).toEqual([])
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  expect(opened).toEqual(['manage-pane'])
})

test('with the language set to Korean, /pane and its command description still read in English', async ($, on) => {
  const { described } = stub(on, { language: '한국어' })
  await $.session.start(START)
  expect(described).toEqual(['Open or close the task and agent pane'])
  expect(await $.command.run({ command: 'pane' })).toMatchObject({ text: 'Pane closed.' })
})

test('a store entry past the newest 50 sessions is dropped after start; the rest stay', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const old: Record<string, unknown> = {}
  for (let i = 0; i < 52; i++) old[`board:s${i}`] = { at: 1000 + i, lastId: 0, tasks: [] }
  const { store } = stub(on, { store: { ...old, weekly: 1 } })
  await $.session.start(START)
  // Off the start's path: nothing is dropped until the clock moves.
  expect(store.has('board:s0')).toBe(true)
  await clock.advance(1)
  expect(store.has('board:s0')).toBe(false)
  expect(store.has('board:s1')).toBe(false)
  expect(store.has('board:s2')).toBe(true)
  expect(store.has('board:s51')).toBe(true)
  expect(store.has('weekly')).toBe(true)
})

test('pruning never drops the current session’s list, even the oldest', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const old: Record<string, unknown> = {
    'board:sid-1': { at: 1, lastId: 1, tasks: [{ id: '1', subject: 'Mine', description: '', status: 'pending', blocks: [], blockedBy: [] }] },
  }
  for (let i = 0; i < 51; i++) old[`board:s${i}`] = { at: 1000 + i, lastId: 0, tasks: [] }
  const { store, boards } = stub(on, { store: old })
  await $.session.start(START)
  await clock.advance(1)
  expect(store.has('board:sid-1')).toBe(true)
  // 52 lists keep 50: the two oldest others go in its place.
  expect(store.has('board:s0')).toBe(false)
  expect(store.has('board:s1')).toBe(false)
  expect(store.has('board:s2')).toBe(true)
  expect(boards()).toHaveLength(50)
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [pending] Mine')
})

test('a store that refuses a write is pruned to 25 lists and written once more', async ($, on) => {
  const old: Record<string, unknown> = {}
  for (let i = 0; i < 40; i++) old[`board:s${i}`] = { at: 1000 + i, lastId: 0, tasks: [] }
  const { store, boards, json } = stub(on, { store: old, boardCap: 30 })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Saved', description: '' }))).toBe(created(['1', 'Saved']))
  expect(json('sid-1', '1')).toMatchObject({ subject: 'Saved' })
  expect(boards()).toHaveLength(26)
  expect(store.has('board:s14')).toBe(false)
  expect(store.has('board:s15')).toBe(true)
})

test('a /resume, which runs no session.start, gets its list back on the next main-loop turn', async ($, on) => {
  const { session } = stub(on, { store: SID2_BOARD })
  instructionStub(on)
  session.id = 'sid-2'
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Resumed work' })).toBeUndefined()
  await ui.unmount()
  const { agentId: _, ...main } = done('a1')
  await $.turn.complete(main)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Resumed work' })).toBeDefined()
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Next', description: '' }))).toBe(created(['4', 'Next']))
})

test('a write keeps the tasks another process of the session stored, and drops what it deleted', async ($, on) => {
  const { store } = stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, tasks: [{ subject: 'One' }, { subject: 'Two' }] })
  // The other process created #3, renamed #2 and deleted #1 since this one last wrote.
  store.set('board:sid-1', {
    at: 2,
    lastId: 3,
    deleted: ['1'],
    tasks: [
      { id: '2', subject: 'Two renamed', description: '', status: 'pending', blocks: [], blockedBy: [] },
      { id: '3', subject: 'Theirs', description: '', status: 'pending', blocks: [], blockedBy: [] },
    ],
  })
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Mine', description: '' }))).toBe(created(['4', 'Mine']))
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#2 [pending] Two renamed\n#3 [pending] Theirs\n#4 [pending] Mine')
  // A task this process changes is its own version.
  await $.tool.call({ tool: UPDATE, taskId: '3', status: 'completed' })
  expect((store.get('board:sid-1') as StoredBoard).tasks.find(x => x.id === '3')).toMatchObject({ status: 'completed' })
})

test('a non-interactive start opens nothing; a subagent’s call shares the one list', async ($, on) => {
  const { opened } = stub(on)
  await $.session.start({ ...START, isInteractive: false })
  expect(opened).toEqual([])
  await $.tool.call({ tool: CREATE, subject: 'Main task', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Sub task', description: 'd', agentId: 'a1' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  expect(opened).toEqual(['manage-pane'])

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Sub task' })).toBeDefined()
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.label).toBe('Task 1/2')
})

test('a /resume or /branch clears the old list at once; the new session’s list comes on its next main-loop turn', async ($, on) => {
  const { session } = stub(on, { store: SID2_BOARD })
  instructionStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Old', description: '' })
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Old' })).toBeDefined()
  await ui.unmount()
  await $.session.end({ reason: 'resume', sessionId: 'sid-1', resume: {} as never })
  session.id = 'sid-2'
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Old' })).toBeUndefined()
  await ui.unmount()
  const { agentId: _, ...main } = done('a1')
  await $.turn.complete(main)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Resumed work' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Old' })).toBeUndefined()
})
