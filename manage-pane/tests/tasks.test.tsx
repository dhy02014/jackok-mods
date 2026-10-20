import { expect, mock, test } from 'claude-code/testing'
import { START, CREATE, UPDATE, LIST, stub, mountPane, said, agentStub, mountRows, done, spawn, opening, prompt, rows } from './helpers'

test('task_update’s description tells of the `#N` claim', async ($, on) => {
  const { specText } = stub(on)
  await $.session.start(START)
  expect(specText[1]).toContain('An Agent description opening `#N ` claims task N itself')
  expect(specText.join('').length).toBeLessThan(1050)
})

test('with a language set, task_create and task_update ask for subject and activeForm in it; task_list does not',async ($, on) => {
  const { specText } = stub(on, { language: 'Korean' })
  await $.session.start(START)
  const asked = ' Write subject and activeForm in Korean.'
  expect([specText[0]!.includes(asked), specText[1]!.includes(asked), specText[2]!.includes(asked)]).toEqual([true, true, false])
  expect(specText.join('').length).toBeLessThan(1150)
})

test('with no language set, no tool spec names a language', async ($, on) => {
  const { specText } = stub(on)
  await $.session.start(START)
  expect(specText.join('')).not.toContain('Write subject and activeForm')
})

test('task_create takes several tasks as `tasks`: numbered in order, all or nothing', async ($, on) => {
  const { json } = stub(on)
  await $.session.start(START)
  expect(
    said(
      await $.tool.call({
        tool: CREATE,
        tasks: [
          { subject: 'Read', description: 'd1', status: 'in_progress', activeForm: 'Reading' },
          { subject: 'Write', description: 'd2' },
        ],
      }),
    ),
  ).toBe('Created #1, #2')
  expect(json('sid-1', '1')).toMatchObject({ subject: 'Read', status: 'in_progress', activeForm: 'Reading' })
  expect(json('sid-1', '2')).toMatchObject({ subject: 'Write', status: 'pending' })
  // One bad entry refuses the whole call: no id is spent.
  expect(
    said(await $.tool.call({ tool: CREATE, tasks: [{ subject: 'Ok', description: 'd' }, { description: 'No subject' }] })),
  ).toBe('task_create needs a non-empty subject in every task.')
  expect(said(await $.tool.call({ tool: CREATE, tasks: [] }))).toBe('task_create needs a subject, or a non-empty tasks list.')
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Next', description: 'd3' }))).toBe(
    'Created #3',
  )
  // description is optional: a task without one is written with "".
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Bare' }))).toBe('Created #4')
  expect(json('sid-1', '4')).toMatchObject({ subject: 'Bare', description: '' })
})

test('an unknown id is a tool error that changes nothing', async ($, on) => {
  const { storeSets: writes } = stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Only', description: '' })
  const before = writes.length
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '9', status: 'completed' }))).toMatch(/Task #9 not found/)
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', addBlockedBy: ['5'] }))).toMatch(/Task #5 not found/)
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', status: 'done' }))).toMatch(/Unknown status/)
  // A batch is all or nothing: one unknown id leaves the good entries unapplied too.
  expect(
    said(await $.tool.call({ tool: UPDATE, updates: [{ taskId: '1', status: 'completed' }, { taskId: '9', status: 'completed' }] })),
  ).toMatch(/Task #9 not found/)
  expect(said(await $.tool.call({ tool: UPDATE, updates: [{ status: 'completed' }] }))).toMatch(/needs a taskId/)
  expect(said(await $.tool.call({ tool: UPDATE, updates: [] }))).toMatch(/non-empty updates/)
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [pending] Only')
  expect(writes.length).toBe(before)
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [pending] Only')
})

test('a stored task whose id is not decimal is not read back', async ($, on) => {
  stub(on, {
    store: {
      'board:sid-1': {
        at: 1,
        lastId: 0,
        tasks: [
          { id: 'abc', subject: 'Bad', description: '', status: 'pending', blocks: [], blockedBy: [] },
          { id: '2', subject: 'Good', description: '', status: 'pending', blocks: [], blockedBy: [] },
        ],
      },
    },
  })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#2 [pending] Good')
  expect(said(await $.tool.call({ tool: CREATE, subject: 'Next', description: '' }))).toBe('Created #3')
})

test('an in-progress mark blinks while a task is in progress and rests once none is', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Work', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress' })

  const markDim = async () => {
    const ui = await mountPane($)
    // The mark's own Text: the yellow one, not the row that holds it.
    const mark = (await ui.findAll({ type: 'Text', text: '◐ ' })).find(t => t.props.color === 'yellow')
    await ui.unmount()
    return mark?.props.dimColor === true
  }
  expect(await markDim()).toBe(false)
  await clock.advance(500)
  expect(await markDim()).toBe(true)
  await clock.advance(500)
  expect(await markDim()).toBe(false)

  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '◐ ' })).toBeUndefined()
})

test('task_create with status in_progress starts the task in one call; any other status is refused', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Now', description: 'd', status: 'in_progress' })
  const list = await $.tool.call({ tool: LIST })
  expect(String(list.result)).toContain('in_progress')
  const ui = await mountPane($)
  expect((await ui.findAll({ type: 'Text', text: '◐ ' })).some(t => t.props.color === 'yellow')).toBe(true)
  await ui.unmount()
  await clock.advance(500)

  const bad = await $.tool.call({ tool: CREATE, subject: 'Bad', description: 'd', status: 'completed' })
  expect(bad.deny).toContain('pending or in_progress')
})

test('task_update sets and clears an owner, in the list text, the store and the mirror', async ($, on) => {
  const { json, file: fileJson } = stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Delegated', description: 'd' })
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a7' }))).toBe(
    'Updated task #1 status, owner',
  )
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [in_progress] Delegated (owner: a7)')
  expect(Object.keys(fileJson('sid-1', '1')!)).toEqual(['id', 'subject', 'description', 'status', 'owner', 'blocks', 'blockedBy'])
  expect(json('sid-1', '1')).toMatchObject({ owner: 'a7' })
  expect(fileJson('sid-1', '1')).toMatchObject({ owner: 'a7' })
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', owner: 'a7' }))).toBe('Updated task #1 (no changes)')

  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', owner: '' }))).toBe('Updated task #1 owner')
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [in_progress] Delegated')
  expect(json('sid-1', '1')!.owner).toBeUndefined()
  expect(said(await $.tool.call({ tool: UPDATE, taskId: '1', owner: '' }))).toBe('Updated task #1 (no changes)')
})

test('an owner in the store is read back on resume', async ($, on) => {
  stub(on, {
    store: {
      'board:sid-1': {
        at: 1,
        lastId: 1,
        tasks: [{ id: '1', subject: 'Kept', description: '', status: 'in_progress', owner: 'abcdef0123456789', blocks: [], blockedBy: [] }],
      },
    },
  })
  await $.session.start(START)
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [in_progress] Kept (owner: abcdef0123456789)')
  // An owner this load never saw spawn: its short id alone.
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '  └ abcdef01' })).toBeDefined()
})

test('with the language set to Korean, the pane still reads in English and shows Hangul subjects', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out, { language: 'ko-KR' })
  await $.session.start(START)
  expect(out.titles).toEqual(['Manage'])
  let ui = await mountPane($)
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.label).toBe('Task')
  expect((await ui.find({ key: 'pane-tab:prompt' }))?.props.label).toBe('Prompt 0')
  expect(await ui.find({ type: 'Text', text: 'No tasks yet.' })).toBeDefined()
  await ui.press({ key: 'pane-tab:prompt' })
  expect(await ui.find({ type: 'Text', text: 'None loaded yet.' })).toBeDefined()
  await ui.press({ key: 'pane-tab:task' })
  await ui.unmount()

  await $.tool.call({ tool: CREATE, tasks: [{ subject: '첫 번째' }, { subject: '두 번째' }, { subject: '격리' }] })
  await $.tool.call({ tool: UPDATE, updates: [{ taskId: '1', status: 'completed' }, { taskId: '2', addBlockedBy: ['3'] }] })
  await $.agent.spawn({ prompt: 'p', subagentType: 'isolated', description: '#3 Def' } as never)
  ui = await mountPane($)
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.label).toBe('Task 1/3')
  expect((await ui.find({ key: 'filter-all' }))?.props.label).toBe('[all]')
  expect((await ui.find({ key: 'filter-open' }))?.props.label).toBe('[open]')
  expect(await ui.find({ type: 'Text', text: '두 번째' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' (blocked by #3)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ isolated Sonnet 5.5  worktree' })).toBeDefined()
  await ui.unmount()
  // 30 columns leave the label 5 cells: `…` and the last four letters. The Hangul cut is in the `cells`/`tailFit` test.
  ui = await mountRows($, 30, 30)
  expect(await ui.find({ type: 'Text', text: '◐ isolated Sonnet 5.5  …tree' })).toBeDefined()
})

test('the pane is drawn whole: no box is sized to the rows, so a long list scrolls', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Owned work', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Owned' } as never)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.height !== undefined || b.props.overflow !== undefined)).toEqual([])
})

// The harness has no `ui.scroll` implementation, so the follow itself is checked live; here,
// that every task is drawn under the key it scrolls to, its owner's rows inside it.
test('each task is one keyed element a scroll can bring into view', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  for (let i = 1; i <= 12; i++) await $.tool.call({ tool: CREATE, subject: `Step ${i}`, description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#12 Last one' })
  const ui = await mountRows($, 5)
  for (let i = 1; i <= 12; i++) expect(await ui.find({ key: `pane-task:${i}` })).toBeDefined()
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
})
