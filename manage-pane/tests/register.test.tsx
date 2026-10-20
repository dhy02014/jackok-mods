import { expect, mock, test } from 'claude-code/testing'
import { START, HOME, dirOf, CREATE, UPDATE, LIST, stub, mountPane, said, SID2_BOARD, done, instructionStub, reminder, rows } from './helpers'
import type { StoredBoard } from './helpers'

test('the built-in Agent tool’s description gains the #N sentence; another tool’s does not', async ($, on) => {
  stub(on)
  on('tool.describe', ($, e) => ({ description: e.description }))
  await $.session.start(START)
  const agent = await $.tool.describe({ tool: 'Agent', description: 'Launch an agent.' })
  expect(agent.description).toMatch(/^Launch an agent\. Optional: start `description` with `#N `/)
  expect(agent.description.length).toBeLessThan(200)
  expect((await $.tool.describe({ tool: 'Bash', description: 'Run a command.' })).description).toBe('Run a command.')
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
  // once and save a whole tool call per batched update or create.
  expect(specText.join('').length).toBeLessThan(1050)
  // The spec teaches the `#N` claim.
  expect(specText.join('')).toContain('#N')
})

test('create → update → list: the pane, the tool results, the store and the mirror files agree', async ($, on) => {
  const { opened, json, file: fileJson, files, argvs } = stub(on)
  await $.session.start(START)
  expect(opened).toEqual(['manage-pane'])

  expect(said(await $.tool.call({ tool: CREATE, subject: 'Read the types', description: 'd1' }))).toBe(
    'Created #1',
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
  expect(fileJson('sid-1', '3')).toMatchObject({ blocks: ['2'] })
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

  // The CLI's own keys, in its order; no activeForm key when none was given.
  expect(Object.keys(fileJson('sid-1', '1')!)).toEqual(['id', 'subject', 'description', 'status', 'blocks', 'blockedBy'])
  expect(files.get(`${dirOf('sid-1')}/2.json`)).toBe(
    JSON.stringify(
      {
        id: '2',
        subject: 'Write the pane',
        description: '',
        activeForm: 'Writing the pane',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      },
      null,
      2,
    ),
  )
  expect(json('sid-1', '3')).toBeUndefined()
  expect(fileJson('sid-1', '3')).toBeUndefined()
  // The mirror holds what the store holds, task for task.
  for (const id of ['1', '2']) expect(fileJson('sid-1', id)).toMatchObject(json('sid-1', id)!)
  expect(argvs).toContainEqual(['rm', '-f', `${dirOf('sid-1')}/3.json`])
  // Every file landed through a temp file and a rename; none is left behind.
  expect(argvs).toContainEqual(['mv', '-f', `${dirOf('sid-1')}/1.json.tmp`, `${dirOf('sid-1')}/1.json`])
  expect([...files.keys()].filter(p => p.endsWith('.tmp'))).toEqual([])
  expect(files.get(`${dirOf('sid-1')}/.highwatermark`)).toBe('3')
})

test('on Windows the mirror lands under USERPROFILE, written in place, with no mv or rm', async ($, on) => {
  const { files, writes, argvs } = stub(on, { env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\u' } })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'One', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Two', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'deleted' })

  expect(writes.some(p => p.endsWith('C:/Users/u/.claude/tasks/sid-1/1.json'))).toBe(true)
  expect(JSON.parse(files.get('/Users/u/.claude/tasks/sid-1/1.json')!)).toMatchObject({ id: '1', subject: 'One' })
  expect(files.has('/Users/u/.claude/tasks/sid-1/2.json')).toBe(false)
  expect(argvs).toContainEqual(['cmd', '/d', '/c', 'del', '/f', '/q', 'C:\\Users\\u\\.claude\\tasks\\sid-1\\2.json'])
  expect(argvs.filter(a => a[0] === 'mv' || a[0] === 'rm')).toEqual([])
  expect([...files.keys()].filter(p => p.endsWith('.tmp'))).toEqual([])
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
  expect(said(await $.tool.call({ tool: CREATE, subject: 'C', description: '' }))).toBe('Created #3')

  // /clear: the old list goes, and the new session id counts from 1 under its own key.
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: {} as never })
  session.id = 'sid-2'
  expect(said(await $.tool.call({ tool: LIST }))).toBe('No tasks found.')
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Fresh', description: '' }))).toBe(
    'Created #1',
  )
  expect(json('sid-2', '1')).toMatchObject({ subject: 'Fresh' })
  expect(json('sid-1', '3')).toMatchObject({ subject: 'C' })

  // A /resume (no session.start) picks its tasks back up on the next task call and mints past the stored mark.
  session.id = 'sid-old'
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#4 [pending] Left open')
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Next', description: '' }))).toBe(
    'Created #8',
  )
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '4', status: 'completed' }))).toBe('Updated task #4 status')
})

test('a refused mirror write never fails the call; the pane still shows the task', async ($, on) => {
  stub(on, { isWriteRefused: true })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Kept in state', description: '' }))).toBe(
    'Created #1',
  )
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Kept in state' })).toBeDefined()
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
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Saved', description: '' }))).toBe('Created #1')
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
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Next', description: '' }))).toBe('Created #4')
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
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Mine', description: '' }))).toBe('Created #4')
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#2 [pending] Two renamed\n#3 [pending] Theirs\n#4 [pending] Mine')
  // A task this process changes is its own version.
  await $.tool.call({ tool: UPDATE, taskId: '3', status: 'completed' })
  expect((store.get('board:sid-1') as StoredBoard).tasks.find(x => x.id === '3')).toMatchObject({ status: 'completed' })
})

test('the next id clears the ids the built-in TaskCreate left in the directory', async ($, on) => {
  const { files } = stub(on, { files: { [`${dirOf('sid-1')}/5.json`]: '{}', [`${dirOf('sid-1')}/.highwatermark`]: '7' } })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: CREATE, subject: 'After theirs', description: '' }))).toBe('Created #8')
  expect(files.get(`${dirOf('sid-1')}/.highwatermark`)).toBe('8')
})

test('CLAUDE_CODE_TASK_LIST_ID names the directory', async ($, on) => {
  const { files } = stub(on, { env: { HOME, CLAUDE_CODE_TASK_LIST_ID: 'shared-list' }, files: { [`${HOME}/.claude/tasks/shared-list/2.json`]: '{}' } })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Shared', description: '' }))).toBe('Created #3')
  expect(JSON.parse(files.get(`${HOME}/.claude/tasks/shared-list/3.json`)!)).toMatchObject({ id: '3', subject: 'Shared' })
  expect(files.has(`${dirOf('sid-1')}/3.json`)).toBe(false)
})

test('a rename that fails writes the file in place and leaves no temp file', async ($, on) => {
  const { files, argvs } = stub(on, { isMoveRefused: true })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'In place', description: '' })
  expect(JSON.parse(files.get(`${dirOf('sid-1')}/1.json`)!)).toMatchObject({ subject: 'In place' })
  expect(argvs).toContainEqual(['rm', '-f', `${dirOf('sid-1')}/1.json.tmp`])
  expect([...files.keys()].filter(p => p.endsWith('.tmp'))).toEqual([])
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
