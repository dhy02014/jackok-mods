import { expect, mock, test } from 'claude-code/testing'
import { START, HOME, CREATE, UPDATE, LIST, stub, mountPane, said, created, SID2_BOARD, done, instructionStub, reminder, rows, agentStub, spawn, step, report, listOf, AGENT_DONE } from './helpers'
import type { StoredBoard } from './helpers'

// ---- a subagent's task, driven by the engine's events alone ----

test('an Agent dispatch with no #N gets a task of its own: in progress, owned by the agent, stored, drawn under it', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out)
  await $.session.start(START)
  await spawn($, '  Review the diff  ')
  expect(await listOf($)).toBe('#1 [in_progress] Review the diff (owner: a1)')
  expect(out.json?.('sid-1', '1')).toMatchObject({ subject: 'Review the diff', status: 'in_progress', owner: 'a1' })
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeUndefined()
})

test('dispatches and a task_create fired side by side each get their own id; no write is lost', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out)
  await $.session.start(START)
  await Promise.all([spawn($, 'Alpha'), spawn($, 'Beta'), $.tool.call({ tool: CREATE, subject: 'Inline' })])
  const list = await listOf($)
  expect(list.split('\n')).toHaveLength(3)
  expect(list).toMatch(/\[in_progress\] Alpha \(owner: a\d\)/)
  expect(list).toMatch(/\[in_progress\] Beta \(owner: a\d\)/)
  expect(list).toMatch(/\[pending\] Inline$/m)
  expect(new Set(['1', '2', '3'].map(id => out.json?.('sid-1', id)?.subject))).toEqual(new Set(['Alpha', 'Beta', 'Inline']))
})

test('a completed report completes the agent’s task with its run frozen; a failed or stopped one leaves it open', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  const clock = agentStub(on, out)
  await $.session.start(START)
  await spawn($, 'Works')
  await spawn($, 'Fails')
  await spawn($, 'Stopped')
  await step($, 'a1', 'medium')
  await clock.advance(5_000)
  await report($, 'a1')
  await report($, 'a2', 'failed')
  await report($, 'a3', 'stopped')
  expect(await listOf($)).toBe('#2 [in_progress] Fails (owner: a2)\n#3 [in_progress] Stopped (owner: a3)\n(1 completed, not listed)')
  expect(out.json?.('sid-1', '1')).toMatchObject({ status: 'completed', ownerRun: { type: 'explorer', ms: 5_000, effort: 'medium' } })
})

test('a foreground Agent result that completed completes the task too; a background launch waits for its report', async ($, on) => {
  agentStub(on)
  let answer: unknown = AGENT_DONE
  on('tool.call', { tool: 'Agent' }, () => ({ result: answer }) as never)
  await $.session.start(START)
  await spawn($, 'Foreground')
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Foreground', subagent_type: 'explorer' } as never)
  expect(await listOf($)).toBe('No open tasks (1 completed).')
  await spawn($, 'Background')
  answer = { status: 'async_launched', agentId: 'a2', description: 'Background', prompt: 'p', outputFile: '/o' }
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Background', subagent_type: 'explorer' } as never)
  expect(await listOf($)).toBe('#2 [in_progress] Background (owner: a2)\n(1 completed, not listed)')
  await report($, 'a2')
  expect(await listOf($)).toBe('No open tasks (2 completed).')
})

test('a resume reopens the agent’s completed task, thawing its run, and the next report completes it again', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out)
  on('session.send', () => ({ isDelivered: true as const }))
  await $.session.start(START)
  await spawn($, 'Work')
  await report($, 'a1')
  await $.turn.complete(done('a1'))
  expect(out.json?.('sid-1', '1')).toMatchObject({ status: 'completed', ownerRun: { type: 'explorer' } })
  // By SendMessage.
  await $.session.send({ to: 'a1', text: 'more' } as never)
  expect(await listOf($)).toBe('#1 [in_progress] Work (owner: a1)')
  expect(out.json?.('sid-1', '1')).not.toHaveProperty('ownerRun')
  let ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  await ui.unmount()
  await report($, 'a1')
  expect(await listOf($)).toBe('No open tasks (1 completed).')
  // By the resume's spawn alone, and by a call from the finished agent.
  await $.agent.spawn({ prompt: 'again', subagentType: 'explorer', description: '', resume: { agentId: 'a1' } } as never)
  expect(await listOf($)).toBe('#1 [in_progress] Work (owner: a1)')
  await report($, 'a1')
  await $.turn.complete(done('a1'))
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'a1' } as never)
  expect(await listOf($)).toBe('#1 [in_progress] Work (owner: a1)')
  // No new task was made for any resume.
  ui = await mountPane($)
  expect((await ui.findAll({ type: 'Text', text: /^#\d+ $/ })).map(t => t.text)).toEqual(['#1 '])
})

test('a #N dispatch still claims the pre-made task and makes none of its own; its report completes it', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, tasks: [{ subject: 'Plan' }, { subject: 'Build' }] })
  await spawn($, '#2 Build it')
  expect(await listOf($)).toBe('#1 [pending] Plan\n#2 [in_progress] Build (owner: a1)')
  await report($, 'a1')
  expect(await listOf($)).toBe('#1 [pending] Plan\n(1 completed, not listed)')
})

test('a workflow agent() or a teammate gets no task of its own: neither reports, so it would never close', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Flow step', workflow: { runId: 'wf_1', agentIndex: 1 } } as never)
  await $.agent.spawn({ prompt: 'p', subagentType: 'teammate', description: 'Mate', isTeammate: true } as never)
  expect(await listOf($)).toBe('No tasks found.')
  // Both still show as agents, under Other.
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a2' })).toBeDefined()
})

test('a workflow agent() or a teammate whose description names #N never claims it; it is drawn under the task', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, tasks: [{ subject: 'Plan' }, { subject: 'Build' }] })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Flow step', workflow: { runId: 'wf_1', agentIndex: 1 } } as never)
  await $.agent.spawn({ prompt: 'p', subagentType: 'teammate', description: '#2 Mate', isTeammate: true } as never)
  expect(await listOf($)).toBe('#1 [pending] Plan\n#2 [pending] Build')
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect(await ui.find({ key: 'pane-owned:a2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeUndefined()
})

test('a retry closes the task: the first agent on #N failed, a fresh one claims #N and completes', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build' })
  await spawn($, '#1 First try')
  await report($, 'a1', 'failed')
  // Even before a1's turn.complete: its report ended the run, so the claim goes through.
  await spawn($, '#1 Retry')
  expect(await listOf($)).toBe('#1 [in_progress] Build (owner: a2)')
  await report($, 'a2')
  expect(await listOf($)).toBe('No open tasks (1 completed).')
})

test('a #N task two agents work completes at the last one’s completed report, whoever owns it', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build' })
  await spawn($, '#1 First')
  await spawn($, '#1 Second')
  // The owner's report alone leaves it open: a2 still works it.
  await report($, 'a1')
  expect(await listOf($)).toBe('#1 [in_progress] Build (owner: a1)')
  await report($, 'a2')
  expect(await listOf($)).toBe('No open tasks (1 completed).')
})

test('a #N task stays open when the other agent on it failed; the non-owner’s report completes it once the owner completed', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, tasks: [{ subject: 'A' }, { subject: 'B' }] })
  await spawn($, '#1 First')
  await spawn($, '#1 Second')
  await report($, 'a1', 'failed')
  await report($, 'a2')
  expect(await listOf($)).toContain('#1 [in_progress] A (owner: a1)')
  await spawn($, '#2 Third')
  await spawn($, '#2 Fourth')
  await report($, 'a3')
  await report($, 'a4')
  expect(await listOf($)).toBe('#1 [in_progress] A (owner: a1)\n(1 completed, not listed)')
})

test('a failed or stopped report is not overridden by the foreground Agent result that follows it', async ($, on) => {
  agentStub(on)
  let answer: { agentId: string } = { ...AGENT_DONE }
  on('tool.call', { tool: 'Agent' }, () => ({ result: answer }) as never)
  await $.session.start(START)
  await spawn($, 'Fails')
  await report($, 'a1', 'failed')
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Fails', subagent_type: 'explorer' } as never)
  await spawn($, 'Stops')
  await report($, 'a2', 'stopped')
  answer = { ...AGENT_DONE, agentId: 'a2' }
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Stops', subagent_type: 'explorer' } as never)
  expect(await listOf($)).toBe('#1 [in_progress] Fails (owner: a1)\n#2 [in_progress] Stops (owner: a2)')
})

test('a SendMessage to a named agent reopens its task; after /clear the name resumes nothing', async ($, on) => {
  agentStub(on)
  on('session.send', () => ({ isDelivered: true as const }))
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Scout ahead', name: 'scout' } as never)
  await report($, 'a1')
  await $.turn.complete(done('a1'))
  expect(await listOf($)).toBe('No open tasks (1 completed).')
  await $.session.send({ to: 'scout', text: 'more' } as never)
  expect(await listOf($)).toBe('#1 [in_progress] Scout ahead (owner: a1)')
  await report($, 'a1')
  await $.turn.complete(done('a1'))
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: {} as never })
  await $.session.send({ to: 'scout', text: 'again' } as never)
  // The stub keeps the id across /clear, so the stored list comes back: still completed, not reopened.
  expect(await listOf($)).toBe('No open tasks (1 completed).')
})

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
    // Deferred: the pane shows the list; the model needs it only after a compaction.
    { name: 'task_list', isDeferred: true, required: undefined },
  ])
  // Descriptions plus schemas stay small: `updates` and `tasks` cost ~100 characters each
  // once and save a whole tool call per batched update or create; the result's JSON shape ~45;
  // the line that Agent dispatches are tracked automatically ~90.
  expect(specText.join('').length).toBeLessThan(1170)
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

test('a non-interactive session opens no pane, at start or at a list’s first task; a subagent’s call shares the one list', async ($, on) => {
  const { opened } = stub(on)
  await $.session.start({ ...START, isInteractive: false })
  expect(opened).toEqual([])
  await $.tool.call({ tool: CREATE, subject: 'Main task', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Sub task', description: 'd', agentId: 'a1' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  expect(opened).toEqual([])

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

// Every timer the mod asks for, by kind and delay; each request is refused, which the mod outlives.
const timers = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const asked: string[] = []
  on('clock.after', (_, e) => {
    asked.push(`after ${e.ms}`)
    throw new Error('recorded')
  })
  on('clock.every', (_, e) => {
    asked.push(`every ${e.ms}`)
    throw new Error('recorded')
  })
  return asked
}

test('a non-interactive session starts no timer: no queue limit, blink, scroll, scan or prune timer', async ($, on) => {
  stub(on)
  const asked = timers(on)
  await $.session.start({ ...START, isInteractive: false })
  await $.tool.call({ tool: CREATE, subject: 'Live', description: 'd', status: 'in_progress' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  await $.tool.call({ tool: LIST })
  expect(asked).toEqual([])
})

test('an interactive session’s task call waits in the queue under a 10 s timer and an in-progress task blinks', async ($, on) => {
  stub(on)
  const asked = timers(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Live', description: 'd', status: 'in_progress' })
  expect(asked).toContain('after 10000')
  expect(asked).toContain('every 500')
})

test('a stopped or failed run is drawn ended at its report, with no turn end of its own', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await spawn($, 'Stopped')
  await spawn($, 'Fails')
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  await report($, 'a1', 'stopped')
  await report($, 'a2', 'failed')
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeUndefined()
  expect(await ui.find({ key: 'pane-agent:a2' })).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /^  └ ✗ explorer/ })).toHaveLength(2)
})

test('a TaskStop that went through ends the agent it names, by id or name; a refused one leaves it running', async ($, on) => {
  agentStub(on)
  let isRefused = true
  on('tool.call', { tool: 'TaskStop' }, () => (isRefused ? { deny: 'no such task' } : { result: 'stopped' }) as never)
  await $.session.start(START)
  await spawn($, 'Background')
  const ui = await mountPane($)
  await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  isRefused = false
  await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeUndefined()
})
