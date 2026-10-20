import { expect, test } from 'claude-code/testing'
import { START, CREATE, UPDATE, LIST, stub, mountPane, agentStub, done, contextOf, AGENT_DONE, spawn, instructionStub, reminder, opening, prompt, rows } from './helpers'

test('a main-loop task call carries the open tasks as context; none once all are completed', async ($, on) => {
  stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  expect(contextOf(await $.tool.call({ tool: CREATE, subject: 'Second', description: 'd' }))).toEqual([
    // No subjects: the model just wrote them and they are in context.
    'Open tasks: #1 [pending], #2 [pending]',
  ])
  expect(
    contextOf(await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'abcdef0123456789' })),
  ).toEqual(['Open tasks: #1 [in_progress] (owner: abcdef01), #2 [pending]'])
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  expect(contextOf(await $.tool.call({ tool: UPDATE, taskId: '2', status: 'completed' }))).toEqual([])
  // The list is its own reminder.
  expect(contextOf(await $.tool.call({ tool: LIST }))).toEqual([])
})

test('a long subject is cut in a hand-back list; a subagent’s task call carries no reminder', async ($, on) => {
  agentStub(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: AGENT_DONE }) as never)
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Plan' } as never)
  await $.tool.call({ tool: CREATE, subject: 'x'.repeat(80), description: 'd' })
  const back = contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Look', subagent_type: 'checker' } as never))
  expect(back.at(-1)).toMatch(new RegExp(`Open tasks: #1 \\[pending\\] ${'x'.repeat(59)}…$`))
  expect(contextOf(await $.tool.call({ tool: CREATE, subject: 'Sub', description: 'd', agentId: 'a1' }))).toEqual([])
  expect(contextOf(await $.tool.call({ tool: UPDATE, taskId: '2', status: 'in_progress', agentId: 'a1' }))).toEqual([])
})

test('a foreground Agent call’s hand-back names the task its agent owns', async ($, on) => {
  stub(on)
  let answer: unknown = AGENT_DONE
  on('tool.call', { tool: 'Agent' }, () => ({ result: answer }) as never)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Delegated', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Mine', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })

  expect(contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: '#2 Do it', subagent_type: 'explorer' } as never))).toEqual([
    'Agent a1 handed back; it owns #1 — reassign, clear owner, or complete it. Open tasks: #1 [in_progress] Delegated (owner: a1), #2 [pending] Mine',
  ])
  // A background launch is not a hand-back.
  answer = { status: 'async_launched', agentId: 'a1', description: 'Do it', prompt: 'p', outputFile: '/o' }
  expect(contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: '#2 Do it', subagent_type: 'explorer' } as never))).toEqual([])
})

test('a background agent’s task notification carries the hand-back reminder; a typed prompt none', async ($, on) => {
  stub(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Delegated', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1b2c3d4e5f60718' })

  const note = '<task-notification>\n<task-id>a1b2c3d4e5f60718</task-id>\n<status>completed</status>\n</task-notification>'
  const r = await $.prompt.submit({ text: note, wait: false, origin: { kind: 'task-notification' } })
  expect(r.text).toBe(note)
  expect(seen.at(-1)).toEqual([
    'Agent a1b2c3d4 handed back; it owns #1 — reassign, clear owner, or complete it. Open tasks: #1 [in_progress] Delegated (owner: a1b2c3d4)',
  ])
  // A notification no owner matches: the open list alone.
  await $.prompt.submit({ text: '<task-notification>bash done</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(seen.at(-1)).toEqual(['Open tasks: #1 [in_progress] Delegated (owner: a1b2c3d4)'])
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(seen.at(-1)).toBeUndefined()
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
