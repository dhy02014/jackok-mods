import { expect, mock, test } from 'claude-code/testing'
import { failureText, HOOK_LIMIT_MS, isOutOfTime, QUEUE_MARGIN_MS, QUEUED_TOO_LONG } from '../hooks/pane'
import { AGENT_HINT } from '../hooks/pane'
import { START, CREATE, UPDATE, LIST, stub, mountPane, agentStub, done, contextOf, AGENT_DONE, spawn, instructionStub, reminder, opening, prompt, rows, said } from './helpers'

test('a main-loop task call carries the open tasks as context; none once all are completed', async ($, on) => {
  stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  expect(contextOf(await $.tool.call({ tool: CREATE, subject: 'Second', description: 'd' }))).toEqual([
    // No subjects: the model just wrote them and they are in context.
    'Open tasks: #1 [pending], #2 [pending]',
    // task_create teaches the #N mark where every tool mode reads it.
    AGENT_HINT,
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

// A background agent's report in auto mode: its SubagentHandback call, then a peer prompt in the envelope.
const peerSetup = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  stub(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  const handback = { deny: undefined as string | undefined }
  on('tool.call', { tool: 'SubagentHandback' }, () => (handback.deny === undefined ? { result: 'ok' } : { deny: handback.deny }) as never)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Second', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1b2c3d4e5f60718' })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'in_progress', owner: 'b9c8d7e6f5a40312' })
  const handBack = (agentId: string) => $.tool.call({ tool: 'SubagentHandback', message: 'r', agentId } as never)
  const peer = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'peer' } as never })
  return { seen, handback, handBack, peer }
}

const OPEN_BOTH = 'Open tasks: #1 [in_progress] First (owner: a1b2c3d4), #2 [in_progress] Second (owner: b9c8d7e6)'

test('a peer prompt after its sender’s SubagentHandback carries the hand-back reminder for that sender alone', async ($, on) => {
  const { seen, handBack, peer } = await peerSetup($, on)
  await handBack('a1b2c3d4e5f60718')
  // The report body names the other owner too: only the envelope's sender handed back.
  const report = '<agent-message from="a1b2c3d4e5f60718">\n  Done; b9c8d7e6f5a40312 still owns #2.\n</agent-message>'
  const r = await peer(report)
  expect(r.text).toBe(report)
  expect(seen.at(-1)).toEqual([`Agent a1b2c3d4 handed back; it owns #1 — reassign, clear owner, or complete it. ${OPEN_BOTH}`])
  // Told once: a second message from the same agent is no hand-back.
  await peer('<agent-message from="a1b2c3d4e5f60718">\n  again\n</agent-message>')
  expect(seen.at(-1)).toBeUndefined()
})

test('a peer prompt with no hand-back before it, a refused hand-back, or another envelope carries nothing', async ($, on) => {
  const { seen, handback, handBack, peer } = await peerSetup($, on)
  // A mid-run SendMessage arrives in the same envelope.
  await peer('<agent-message from="a1b2c3d4e5f60718">\n  progress\n</agent-message>')
  expect(seen.at(-1)).toBeUndefined()
  handback.deny = 'no'
  await handBack('a1b2c3d4e5f60718')
  await peer('<agent-message from="a1b2c3d4e5f60718">\n  report\n</agent-message>')
  expect(seen.at(-1)).toBeUndefined()
  // Another session's message naming an owner, and an envelope not at column zero.
  handback.deny = undefined
  await handBack('b9c8d7e6f5a40312')
  await peer('<cross-session-message from="b9c8d7e6f5a40312">\n  b9c8d7e6f5a40312 done\n</cross-session-message>')
  expect(seen.at(-1)).toBeUndefined()
  await peer(' <agent-message from="b9c8d7e6f5a40312">\n  done\n</agent-message>')
  expect(seen.at(-1)).toBeUndefined()
})

// A peer prompt submitted while the SubagentHandback call is still running is its report too.
test('a peer prompt that arrives before the SubagentHandback call returns still carries the note', async ($, on) => {
  stub(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  const gate: { open?: () => void } = {}
  on('tool.call', { tool: 'SubagentHandback' }, async () => {
    await new Promise<void>(r => (gate.open = r))
    return { result: 'ok' } as never
  })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1b2c3d4e5f60718' })
  const call = $.tool.call({ tool: 'SubagentHandback', message: 'r', agentId: 'a1b2c3d4e5f60718' } as never)
  while (gate.open === undefined) await new Promise(r => setTimeout(r, 0))
  await $.prompt.submit({ text: '<agent-message from="a1b2c3d4e5f60718">\n  r\n</agent-message>', wait: false, origin: { kind: 'peer' } as never })
  expect(seen.at(-1)).toEqual([
    'Agent a1b2c3d4 handed back; it owns #1 — reassign, clear owner, or complete it. Open tasks: #1 [in_progress] First (owner: a1b2c3d4)',
  ])
  gate.open()
  await call
})

test('a task notification naming a handing-back agent leaves no hand-back for a later peer prompt', async ($, on) => {
  const { seen, handBack, peer } = await peerSetup($, on)
  await handBack('a1b2c3d4e5f60718')
  await $.prompt.submit({ text: '<task-notification>\n<task-id>a1b2c3d4e5f60718</task-id>\n</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(seen.at(-1)).toHaveLength(1)
  await peer('<agent-message from="a1b2c3d4e5f60718">\n  r\n</agent-message>')
  expect(seen.at(-1)).toBeUndefined()
})

// Subagents spawned here (a1, a2, ...), each able to hand back and be messaged.
const agentSetup = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  agentStub(on)
  on('session.send', () => ({ isDelivered: true as const }))
  on('tool.call', { tool: 'SubagentHandback' }, () => ({ result: 'ok' }) as never)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  const handBack = (agentId: string) => $.tool.call({ tool: 'SubagentHandback', message: 'r', agentId } as never)
  const peer = (from: string) => $.prompt.submit({ text: `<agent-message from="${from}">\n  r\n</agent-message>`, wait: false, origin: { kind: 'peer' } as never })
  // A foreground Agent call: what its subagent does before the call resolves, then AGENT_DONE (agent a1).
  const fg = { run: async () => {} }
  on('tool.call', { tool: 'Agent' }, async () => {
    await fg.run()
    return { result: AGENT_DONE } as never
  })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Delegated', description: 'd' })
  return { seen, handBack, peer, fg }
}

const A1_NOTE = 'Agent a1 handed back; it owns #1 — reassign, clear owner, or complete it. Open tasks: #1 [in_progress] Delegated (owner: a1)'

test('a hand-back whose peer prompt never came is forgotten once its agent is resumed', async ($, on) => {
  const { seen, handBack, peer } = await agentSetup($, on)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Work' } as never)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await handBack('a1')
  await $.turn.complete(done('a1'))
  await $.session.send({ to: 'a1', text: 'next' } as never)
  // The resumed run's progress message.
  await peer('a1')
  expect(seen.at(-1)).toBeUndefined()
})

test('a hand-back whose peer prompt never came is forgotten at /clear', async ($, on) => {
  const { seen, handBack, peer } = await agentSetup($, on)
  await handBack('a1')
  await $.session.end({ reason: 'clear' } as never)
  await $.tool.call({ tool: CREATE, subject: 'Delegated', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await peer('a1')
  expect(seen.at(-1)).toBeUndefined()
})

test('a named agent’s envelope sender is mapped to its id', async ($, on) => {
  const { seen, handBack, peer } = await agentSetup($, on)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Work', name: 'scout' } as never)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await handBack('a1')
  await peer('scout')
  expect(seen.at(-1)).toEqual([A1_NOTE])
})

test('a hand-back is forgotten when its agent is resumed by name, with no send seen', async ($, on) => {
  const { seen, handBack, peer } = await agentSetup($, on)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Work', name: 'scout' } as never)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await handBack('a1')
  await $.agent.spawn({ prompt: 'next', subagentType: 'explorer', description: '', resume: { agentId: 'a1' } } as never)
  await peer('scout')
  expect(seen.at(-1)).toBeUndefined()
})

test('a SubagentHandback call that errors leaves no hand-back for a peer prompt', async ($, on) => {
  stub(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  on('tool.call', { tool: 'SubagentHandback' }, () => ({ result: 'x', isError: true }) as never)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1b2c3d4e5f60718' })
  await $.tool.call({ tool: 'SubagentHandback', message: 'r', agentId: 'a1b2c3d4e5f60718' } as never)
  await $.prompt.submit({ text: '<agent-message from="a1b2c3d4e5f60718">\n  r\n</agent-message>', wait: false, origin: { kind: 'peer' } as never })
  expect(seen.at(-1)).toBeUndefined()
})

test('a foreground hand-back with no peer prompt is told once, on the Agent result', async ($, on) => {
  const { seen, handBack, peer, fg } = await agentSetup($, on)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  fg.run = async () => {
    await handBack('a1')
  }
  expect(contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Do it', subagent_type: 'explorer' } as never))).toEqual([A1_NOTE])
  await peer('a1')
  expect(seen.at(-1)).toBeUndefined()
})

test('a foreground hand-back whose peer prompt comes before the Agent result is told once, on the peer prompt', async ($, on) => {
  const { seen, handBack, peer, fg } = await agentSetup($, on)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  fg.run = async () => {
    await handBack('a1')
    await peer('a1')
  }
  expect(contextOf(await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'Do it', subagent_type: 'explorer' } as never))).toEqual([])
  expect(seen.at(-1)).toEqual([A1_NOTE])
})

// The REPL stub runs its script inside the call, while the engine returns at dispatch and runs
// the script after; the nesting here only shows that no REPL hook alters the calls inside.
const replTool = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const repl = { script: async (): Promise<unknown> => undefined }
  on('tool.call', { tool: 'REPL' }, async () => {
    const denied = await repl.script()
    return (typeof denied === 'string' ? { deny: denied } : { result: 'done' }) as never
  })
  return repl
}

test('a REPL script’s task calls keep their reminders; the script’s result carries nothing extra', async ($, on) => {
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
  expect(contextOf(await $.tool.call({ tool: 'REPL', code: 'x' } as never))).toEqual([])
  expect(inner).toEqual([
    ['Open tasks: #1 [pending]', AGENT_HINT],
    ['Open tasks: #1 [pending], #2 [pending]', AGENT_HINT],
    ['Open tasks: #1 [in_progress], #2 [pending]'],
  ])
  expect(contextOf(await $.tool.call({ tool: UPDATE, taskId: '2', status: 'in_progress' }))).toEqual([
    'Open tasks: #1 [in_progress], #2 [in_progress]',
  ])
})

test('parallel task calls each carry their own reminder', async ($, on) => {
  stub(on)
  await $.session.start(START)
  const made = await Promise.all([$.tool.call({ tool: CREATE, subject: 'One' }), $.tool.call({ tool: CREATE, subject: 'Two' })])
  expect(made.map(contextOf).every(c => c.length === 2 && c[0]!.startsWith('Open tasks: #1 [pending]') && c[1] === AGENT_HINT)).toBe(true)
})

test('an Agent hand-back inside a REPL script is told on its own result only', async ($, on) => {
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
  expect(contextOf(await $.tool.call({ tool: 'REPL', code: 'x' } as never))).toEqual([])
  expect(inner).toEqual([handed])
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
