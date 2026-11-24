import { expect, mock, test } from 'claude-code/testing'
import { failureText, HOOK_LIMIT_MS, isOutOfTime, QUEUE_MARGIN_MS, QUEUED_TOO_LONG, rowsBelow, ruleParts, treeRows } from '../hooks/pane'
import { START, CREATE, UPDATE, LIST, PANE_PROPS, stub, mountPane, contextOf, AGENT_DONE, instructionStub, opening, rows, said } from './helpers'

test('no task call, Agent result or report prompt carries a task reminder: the pane is the list', async ($, on) => {
  stub(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: AGENT_DONE }) as never)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  await $.session.start(START)
  expect(contextOf(await $.tool.call({ tool: CREATE, tasks: [{ subject: 'First' }, { subject: 'Second' }] }))).toEqual([])
  expect(contextOf(await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' }))).toEqual([])
  expect(contextOf(await $.tool.call({ tool: LIST }))).toEqual([])
  expect(contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Do it', subagent_type: 'explorer' } as never))).toEqual([])
  const note = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>'
  expect((await $.prompt.submit({ text: note, wait: false, origin: { kind: 'task-notification' } })).text).toBe(note)
  await $.prompt.submit({ text: '<agent-message from="a1">\n  r\n</agent-message>', wait: false, origin: { kind: 'peer' } as never })
  expect(seen).toEqual([undefined, undefined])
})

test('a queued task call runs only with more than the margin left; an engine with no budget always runs it', () => {
  expect(isOutOfTime(undefined)).toBe(false)
  expect(isOutOfTime({})).toBe(false)
  expect(isOutOfTime({ budget: { remainingMs: QUEUE_MARGIN_MS + 1 } })).toBe(false)
  expect(isOutOfTime({ budget: { remainingMs: QUEUE_MARGIN_MS } })).toBe(true)
  expect(isOutOfTime({ budget: { remainingMs: 0 } })).toBe(true)
  expect(isOutOfTime({ signal: { aborted: true }, budget: { remainingMs: 9000 } })).toBe(true)
})

test('a task call timed out before its body began is told to call again; any other failure is the generic one', () => {
  const generic = 'manage-pane: the task tool failed; the list is unchanged.'
  expect(failureText('timeout', 'tu1', new Set())).toBe(QUEUED_TOO_LONG)
  expect(QUEUED_TOO_LONG).toMatch(/Call it again\.$/)
  // Its body had begun: it may have written.
  expect(failureText('timeout', 'tu1', new Set(['tu1']))).toBe(generic)
  // No id to tell whether it began.
  expect(failureText('timeout', undefined, new Set())).toBe(generic)
  expect(failureText('throw', 'tu1', new Set())).toBe(generic)
  expect(failureText(undefined, 'tu1', new Set())).toBe(generic)
})

test('a task run that never settles holds later task calls for at most a hook’s limit', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const hang = { isOn: false }
  stub(on, { stallWrites: hang })
  await $.session.start(START)
  hang.isOn = true
  void $.tool.call({ tool: CREATE, subject: 'Stuck' })
  await new Promise(r => setTimeout(r, 0))
  hang.isOn = false
  const later = $.tool.call({ tool: CREATE, subject: 'Later' })
  let isDone = false
  void Promise.resolve(later).then(() => (isDone = true))
  await new Promise(r => setTimeout(r, 0))
  expect(isDone).toBe(false)
  await clock.advance(HOOK_LIMIT_MS)
  expect(JSON.parse(said(await later)).created[0].subject).toBe('Later')
})

test('the limit counts from a run’s turn: a call queued behind a run released late waits that run’s full limit', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const hang = { isOn: false }
  stub(on, { stallWrites: hang })
  await $.session.start(START)
  hang.isOn = true
  void $.tool.call({ tool: CREATE, subject: 'Stuck' })
  await new Promise(r => setTimeout(r, 0))
  // Queued at once, its turn comes only when the first run's limit lets the queue go.
  void $.tool.call({ tool: CREATE, subject: 'Second' })
  await new Promise(r => setTimeout(r, 0))
  const third = $.tool.call({ tool: CREATE, subject: 'Third' })
  let isDone = false
  void Promise.resolve(third).then(() => (isDone = true))
  await clock.advance(HOOK_LIMIT_MS)
  hang.isOn = false
  await new Promise(r => setTimeout(r, 0))
  // The second run began at the limit and still runs: the third waits for its own limit.
  expect(isDone).toBe(false)
  await clock.advance(HOOK_LIMIT_MS)
  expect(JSON.parse(said(await third)).created[0].subject).toBe('Third')
})

test('the top row switches between the Task and Prompt tabs; task changes keep the picked tab', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Only task', description: 'd' })
  const ui = await mountPane($)
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'pane-tab:prompt' }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Only task' })).toBeDefined()
  expect(await rows(ui)).toEqual([])
  await ui.press({ key: 'pane-tab:prompt' })
  expect((await ui.find({ key: 'pane-tab:prompt' }))?.props.dimColor).toBe(false)
  expect(await ui.find({ type: 'Text', text: 'Only task' })).toBeUndefined()
  expect(await rows(ui)).toEqual(['~/.claude', 'CLAUDE.md'])
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  await $.tool.call({ tool: CREATE, subject: 'Next list', description: 'd' })
  expect((await ui.find({ key: 'pane-tab:prompt' }))?.props.dimColor).toBe(false)
  expect(await ui.find({ type: 'Text', text: 'Next list' })).toBeUndefined()
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.label).toBe('Task 1/2')
  await ui.press({ key: 'pane-tab:task' })
  expect(await ui.find({ type: 'Text', text: 'Next list' })).toBeDefined()
})

test('rows are counted as the terminal stacks them: column Boxes add, row Boxes take the tallest', () => {
  const text = { type: 'Text', children: ['a'] }
  const col = (...c: unknown[]) => ({ type: 'Box', props: { flexDirection: 'column' }, children: c })
  const row = (...c: unknown[]) => ({ type: 'Box', children: c })
  expect(treeRows(col(text, text, row(text, col(text, text))))).toBe(4)
  expect(treeRows(col(text, [text, [text]], undefined, false, ''))).toBe(3)
  expect(treeRows({ type: 'Box', props: { flexDirection: 'column', marginTop: 1 }, children: [text] })).toBe(2)
  expect(treeRows({ type: 'Box', props: { display: 'none' }, children: [text] })).toBe(0)
  expect(rowsBelow(12, { offset: 0, bodyRows: 5 })).toBe(7)
  expect(rowsBelow(12, { offset: 7, bodyRows: 5 })).toBe(0)
  expect(rowsBelow(3, { offset: 0, bodyRows: 30 })).toBe(0)
})

test('the header rule stays its full width with or without the count, and drops the count when too narrow', () => {
  for (const below of [0, 7, 120]) {
    const r = ruleParts(44, below)
    expect((r.head + r.label + r.tail).length).toBe(44)
  }
  expect(ruleParts(44, 7).label).toBe(' 7 more below ')
  expect(ruleParts(10, 7)).toEqual({ head: '─'.repeat(10), label: '', tail: '' })
})

test('a task list taller than the pane says how many rows lie below; one that fits says nothing', async ($, on) => {
  stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, tasks: Array.from({ length: 10 }, (_, i) => ({ subject: `Task ${i + 1}` })) })
  const mount = (scroll: { offset: number; bodyRows: number }) =>
    $.ui.mount({ plugin: 'manage-pane', surface: 'terminal', component: 'Pane', requestId: 'manage-pane', props: { ...PANE_PROPS, scroll } })
  // Header and rule, then ten task rows: twelve, five in view.
  const short = await mount({ offset: 0, bodyRows: 5 })
  expect(await short.find({ type: 'Text', text: ' 7 more below ' })).toBeDefined()
  await short.unmount()
  const tall = await mount({ offset: 0, bodyRows: 30 })
  expect(await tall.find({ type: 'Text', text: /more below/ })).toBeUndefined()
  await tall.unmount()
  const atEnd = await mount({ offset: 7, bodyRows: 5 })
  expect(await atEnd.find({ type: 'Text', text: /more below/ })).toBeUndefined()
})
