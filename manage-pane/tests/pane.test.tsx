import { expect, mock, test } from 'claude-code/testing'
import { failureText, HOOK_LIMIT_MS, isOutOfTime, QUEUE_MARGIN_MS, QUEUED_TOO_LONG } from '../hooks/pane'
import { START, CREATE, UPDATE, LIST, stub, mountPane, agentStub, done, contextOf, AGENT_DONE, spawn, instructionStub, reminder, opening, prompt, rows, said } from './helpers'

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

// Code mode's REPL as the engine runs it: the script's tool calls go through tool.call while
// the REPL call itself is still running.
const replTool = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const repl = { script: async (): Promise<unknown> => undefined }
  on('tool.call', { tool: 'REPL' }, async () => {
    const denied = await repl.script()
    return (typeof denied === 'string' ? { deny: denied } : { result: 'done' }) as never
  })
  return repl
}

test('a REPL script’s task calls keep their reminders; the script’s result also carries one current list', async ($, on) => {
  stub(on)
  const repl = replTool(on)
  await $.session.start(START)
  const inner: (readonly string[])[] = []
  repl.script = async () => {
    const made = await Promise.all([$.tool.call({ tool: CREATE, subject: 'One' }), $.tool.call({ tool: CREATE, subject: 'Two' })])
    inner.push(...made.map(contextOf))
    inner.push(contextOf(await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress' })))
    return undefined
  }
  expect(contextOf(await $.tool.call({ tool: 'REPL', code: 'x' } as never))).toEqual(['Open tasks: #1 [in_progress], #2 [pending]'])
  // Kept per call too: a REPL result's context may not reach the model.
  expect(inner).toEqual([
    ['Open tasks: #1 [pending]'],
    ['Open tasks: #1 [pending], #2 [pending]'],
    ['Open tasks: #1 [in_progress], #2 [pending]'],
  ])
  // A script that makes no task call carries none.
  repl.script = async () => $.tool.call({ tool: LIST }).then(() => undefined)
  expect(contextOf(await $.tool.call({ tool: 'REPL', code: 'x' } as never))).toEqual([])
  // Once a script ends, refused or thrown, a direct call carries its own reminder again.
  repl.script = async () => 'refused'
  await $.tool.call({ tool: 'REPL', code: 'x' } as never)
  repl.script = async () => {
    throw new Error('boom')
  }
  await Promise.resolve($.tool.call({ tool: 'REPL', code: 'x' } as never)).catch(() => undefined)
  expect(contextOf(await $.tool.call({ tool: UPDATE, taskId: '2', status: 'in_progress' }))).toEqual([
    'Open tasks: #1 [in_progress], #2 [in_progress]',
  ])
})

test('with no REPL call around them, task calls keep their per-call reminders', async ($, on) => {
  stub(on)
  replTool(on)
  await $.session.start(START)
  const made = await Promise.all([$.tool.call({ tool: CREATE, subject: 'One' }), $.tool.call({ tool: CREATE, subject: 'Two' })])
  expect(made.map(contextOf).every(c => c.length === 1 && c[0]!.startsWith('Open tasks: #1 [pending]'))).toBe(true)
})

test('an Agent hand-back inside a REPL script is told on its own result and again on the script’s', async ($, on) => {
  stub(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: AGENT_DONE }) as never)
  const repl = replTool(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Delegated' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  let inner: readonly string[] = ['unset']
  repl.script = async () => {
    inner = contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Do it', subagent_type: 'explorer' } as never))
    return undefined
  }
  const handed = 'Agent a1 handed back; it owns #1 — reassign, clear owner, or complete it. Open tasks: #1 [in_progress] Delegated (owner: a1)'
  expect(contextOf(await $.tool.call({ tool: 'REPL', code: 'x' } as never))).toEqual([handed])
  expect(inner).toEqual([handed])
})

test('a Poll result naming an open task’s owner carries the hand-back reminder; one naming none, nothing', async ($, on) => {
  stub(on)
  let polled: unknown = { status: 'completed', task_id: 'a1b2c3d4e5f60718', output: 'report' }
  on('tool.call', { tool: 'Poll' }, () => ({ result: polled }) as never)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Delegated' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1b2c3d4e5f60718' })
  expect(contextOf(await $.tool.call({ tool: 'Poll' } as never))).toEqual([
    'Agent a1b2c3d4 handed back; it owns #1 — reassign, clear owner, or complete it. Open tasks: #1 [in_progress] Delegated (owner: a1b2c3d4)',
  ])
  // Every status that says the work ended counts.
  for (const status of ['failed', 'killed', 'stopped']) {
    polled = { status, task_id: 'a1b2c3d4e5f60718' }
    expect(contextOf(await $.tool.call({ tool: 'Poll' } as never))).toHaveLength(1)
  }
  polled = { status: 'running', task_id: 'b9' }
  expect(contextOf(await $.tool.call({ tool: 'Poll' } as never))).toEqual([])
  // Still running, not started, an unknown status, or a shape with no status (a plain string): no note.
  for (const p of ['running', 'pending', 'done?'].map(status => ({ status, task_id: 'a1b2c3d4e5f60718' })) as unknown[]) {
    polled = p
    expect(contextOf(await $.tool.call({ tool: 'Poll' } as never))).toEqual([])
  }
  polled = 'agent a1b2c3d4e5f60718 finished'
  expect(contextOf(await $.tool.call({ tool: 'Poll' } as never))).toEqual([])
})

test('a REPL script that throws after a task call leaves nothing held for the next script', async ($, on) => {
  stub(on)
  const repl = replTool(on)
  await $.session.start(START)
  repl.script = async () => {
    await $.tool.call({ tool: CREATE, subject: 'One' })
    throw new Error('boom')
  }
  await Promise.resolve($.tool.call({ tool: 'REPL', code: 'x' } as never)).catch(() => undefined)
  repl.script = async () => undefined
  expect(contextOf(await $.tool.call({ tool: 'REPL', code: 'x' } as never))).toEqual([])
})

test('a script that throws while another runs leaves the other’s held reminder in place', async ($, on) => {
  stub(on)
  const gate: { open?: () => void } = {}
  on('tool.call', { tool: 'REPL' }, async (_, e) => {
    if ((e as { code?: string }).code === 'long') {
      await $.tool.call({ tool: CREATE, subject: 'One' })
      await new Promise<void>(r => (gate.open = r))
      return { result: 'done' } as never
    }
    throw new Error('boom')
  })
  await $.session.start(START)
  const long = $.tool.call({ tool: 'REPL', code: 'long' } as never)
  while (gate.open === undefined) await new Promise(r => setTimeout(r, 0))
  await Promise.resolve($.tool.call({ tool: 'REPL', code: 'short' } as never)).catch(() => undefined)
  gate.open()
  expect(contextOf(await long)).toEqual(['Open tasks: #1 [pending]'])
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
