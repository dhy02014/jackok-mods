import { expect, test } from 'claude-code/testing'
import { cells } from '../hooks/strings'
import { START, CREATE, UPDATE, LIST, stub, mountPane, said, agentStub, mountRows, done, agentTool, agentCall, spawn, listOf, prompt } from './helpers'

test('a running agent shows under its task: what it is for and only the call it is on', async ($, on) => {
  const clock = agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Some task', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Fix the parser', cwd: `${START.cwd}/.claude/worktrees/fix-parser` })
  await $.tool.call({ tool: 'Bash', command: 'rg -n "x" /home/u/repo/src\nsecond line', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/parse.ts', agentId: 'a1' })
  await clock.advance(72_000)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Some task' })).toBeDefined()
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  // Two cells in under its task, the directory gives way from its start.
  expect(await ui.find({ type: 'Text', text: '◐ explorer Sonnet 5.5:medium  …ktrees/fix-parser' })).toBeDefined()
  // No running clock: the CLI's footer already counts it.
  expect(await ui.find({ type: 'Text', text: '1m12s' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /calls/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^  Fix the parser$/ })).toBeDefined()
  // Only the latest call, a file by its name; no history, no per-tool counts.
  const calls = await ui.findAll({ type: 'Text', text: /^  · \S/ })
  expect(calls.map(c => c.text)).toEqual(['  · Read parse.ts'])
})

test('a command shows by its first line with ~ for home', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Look', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Search' })
  await $.tool.call({ tool: 'Bash', command: 'rg -n "x" /home/u/repo/src\nsecond line', agentId: 'a1' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '  · Bash rg -n "x" ~/repo/src' })).toBeDefined()
})

test('a call in flight is marked, and the next call replaces it', async ($, on) => {
  agentStub(on)
  let midCall: unknown
  on('tool.call', { tool: 'Grep' }, async () => {
    const ui = await mountPane($)
    midCall = await ui.find({ type: 'Text', text: '  ▸ Grep TODO' })
    await ui.unmount()
    return { result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }
  })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Look', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Find' })
  for (const c of ['a', 'b', 'c']) await $.tool.call({ tool: 'Bash', command: c, agentId: 'a1' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', agentId: 'a1' })
  expect(midCall).toBeDefined()

  const ui = await mountPane($)
  const calls = await ui.findAll({ type: 'Text', text: /^  · \S/ })
  expect(calls.map(c => c.text)).toEqual(['  · Grep TODO'])
})

test('a subagent’s task_create is its current call and lands in the one list', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Parent', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Plan' })
  await $.tool.call({ tool: CREATE, subject: 'Sub step', description: 'from a1', agentId: 'a1' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Sub step' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  · manage-pane:task_create from a1' })).toBeDefined()
})

test('an agent no task claims is drawn under Other: running as a block, finished as one dim line', async ($, on) => {
  const clock = agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Some task', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'checker', description: 'Review the diff' })
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Some task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Review the diff' })).toBeDefined()
  await ui.unmount()

  await clock.advance(5_000)
  await $.turn.complete(done('a1'))
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^  └ ✓ checker/ }))?.props.dimColor).toBe(true)
})

test('only the 3 newest finished unclaimed agents are drawn, running ones first; with the [open] filter too', async ($, on) => {
  const clock = agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Done', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  for (const type of ['t1', 't2', 't3', 't4']) {
    await $.agent.spawn({ prompt: 'p', subagentType: type, description: type })
    await clock.advance(1_000)
    await $.turn.complete(done(`a${['t1', 't2', 't3', 't4'].indexOf(type) + 1}`))
  }
  await $.agent.spawn({ prompt: 'p', subagentType: 'live', description: 'Still going' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^  └ ✓ t1/ })).toBeUndefined()
  for (const type of ['t2', 't3', 't4']) expect(await ui.find({ type: 'Text', text: new RegExp(`^  └ ✓ ${type}`) })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a5' })).toBeDefined()
  await ui.press({ key: 'filter-open' })
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a5' })).toBeDefined()
})

test('with every agent claimed there is no Other heading', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, '#1 Build it')
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeUndefined()
})

test('an Agent call without #N goes through and its agent is drawn under Other', async ($, on) => {
  agentStub(on)
  const seen = agentTool(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  expect((await agentCall($, 'Review the diff')).deny).toBeUndefined()
  expect(seen.ran).toBe(1)
  await spawn($, 'Review the diff')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
})

test('an owned running agent is drawn under its task once; an unowned one under Other', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Owned work', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Does the owned work' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'checker', description: 'Free agent' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'a1' })

  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect(await ui.findAll({ key: 'pane-agent:a1' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: '  Does the owned work' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: '  · Bash make' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /── agents/ })).toBeUndefined()
})

test('a spawn whose description opens with #N claims task N: owner, in progress, stored', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Second', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#2 Trace the flow' })
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [pending] First\n#2 [in_progress] Second (owner: a1)')
  expect(out.json?.('sid-1', '2')).toMatchObject({ owner: 'a1', status: 'in_progress' })
  // The pane shows the description without the mark, under its task.
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Trace the flow' })).toBeDefined()
})

test('a #N naming no task, a completed one, or no mark at all claims nothing', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Done', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Stale number' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#9 Unknown' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Fix #1 later' })
  expect(said(await $.tool.call({ tool: LIST }))).toBe('No open tasks (1 completed).')
})

test('an owned agent that finished is one dim line under its task, and its task is left as it was', async ($, on) => {
  const clock = agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Owned work', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Does the owned work' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await clock.advance(192_000)
  await $.turn.complete(done('a1'))

  // Completion is the caller's call: the owned agent's end changes neither status nor owner.
  expect(said(await $.tool.call({ tool: LIST }))).toBe('#1 [in_progress] Owned work (owner: a1)')
  const ui = await mountPane($)
  // Who ran, on what model and effort, for how long.
  const line = await ui.find({ type: 'Text', text: '  └ ✓ explorer Sonnet 5.5:medium 3m12s' })
  expect(line?.props.dimColor).toBe(true)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✓ explorer Does the owned work' })).toBeUndefined()
})

test('an Agent call with no mark, or a mark naming no open task, goes through and claims nothing', async ($, on) => {
  agentStub(on)
  const seen = agentTool(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, '#1 Build it')
  for (const description of ['Review the diff', '#9 Review the diff', '#1 Review the diff']) expect((await agentCall($, description)).deny).toBeUndefined()
  expect(seen.ran).toBe(3)
  expect(await listOf($)).toBe('#1 [in_progress] Build (owner: a1)')
})

test('two Agent calls in one message naming the same task both pass; the first claims, both are drawn under it', async ($, on) => {
  const clock = agentStub(on)
  agentTool(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, '#1 First')
  await spawn($, '#1 Second')
  expect(await listOf($)).toContain('#1 [in_progress] Build (owner: a1)')
  let ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeDefined()
  expect(await ui.find({ key: 'pane-owned:a2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  First' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Second' })).toBeDefined()
  await ui.unmount()

  // The second one's finish stays under the task too.
  await clock.advance(5_000)
  await $.turn.complete(done('a2'))
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '  First' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Second' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '  └ ✓ explorer Sonnet 5.5:medium 5s' })).toBeDefined()
})

test('an agent whose #N named a missing or completed task claims nothing and is drawn under Other', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Done', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Late' } as never)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#9 Lost' } as never)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:a1' })).toBeUndefined()
  expect(await ui.find({ key: 'pane-owned:a2' })).toBeUndefined()
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a2' })).toBeDefined()
})

test('a spawn’s claim never takes a task another running agent works', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Review', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Build it' } as never)
  await $.agent.spawn({ prompt: 'p', subagentType: 'checker', description: '#1 Late' } as never)
  expect(String((await $.tool.call({ tool: LIST })).result)).toMatch(/#1 \[in_progress\] Build \(owner: a1\)/)
})

test('an agent’s directory follows its effort: the last two segments, cut before the name is', async ($, on) => {
  agentStub(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'a4', description: 'Call', prompt: 'p', outputFile: '/o' } }) as never)
  const heads = async (ui: { findAll: (q: { type: 'Text'; text: RegExp }) => Promise<{ text: string }[]> }) =>
    (await ui.findAll({ type: 'Text', text: /^◐ / })).map(t => t.text)
  await $.session.start(START)
  for (const s of ['One', 'Two', 'Three', 'Four']) await $.tool.call({ tool: CREATE, subject: s, description: 'd' })
  // The session's directory is shown too, home as `~`.
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Here' } as never)
  let ui = await mountPane($)
  expect(await heads(ui)).toContain('◐ explorer Sonnet 5.5:medium  ~/proj')
  expect(await ui.find({ type: 'Text', text: /^  Here$/ })).toBeDefined()
  await ui.unmount()

  await $.agent.spawn({ prompt: 'p', subagentType: 'checker', description: '#2 Far', cwd: '/a/b/c/dddddddddddd' } as never)
  ui = await mountPane($)
  expect(await heads(ui)).toContain('◐ checker Sonnet 5.5:high  c/dddddddddddd')
  await ui.unmount()
  // Under its task the block is 2 cells in: 42 columns leave the directory 13 cells, cut
  // from its start; 30 leave it none.
  ui = await mountRows($, 30, 42)
  expect(await heads(ui)).toContain('◐ checker Sonnet 5.5:high  …dddddddddddd')
  await ui.unmount()
  ui = await mountRows($, 30, 30)
  expect(await heads(ui)).toContain('◐ checker Sonnet 5.5:high')
  await ui.unmount()

  // An isolated agent, by its definition or by the call: its worktree is on no event.
  await $.agent.spawn({ prompt: 'p', subagentType: 'isolated', description: '#3 Def' } as never)
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: '#4 Call', subagent_type: 'explorer', isolation: 'worktree', tool_use_id: 'tu-4' } as never)
  // In a session the spawn runs inside that call; here it follows it, under the same tool_use_id.
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#4 Call', tool_use_id: 'tu-4' } as never)
  ui = await mountRows($, 40)
  expect(await heads(ui)).toContain('◐ isolated Sonnet 5.5  worktree')
  expect(await heads(ui)).toContain('◐ explorer Sonnet 5.5:medium  worktree')
})

test('on Windows the definition is read under USERPROFILE and paths read with `/` and `~`', async ($, on) => {
  agentStub(on, {}, {
    env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\u' },
    files: { '/Users/u/.claude/agents/explorer.md': '---\nname: explorer\neffort: medium\n---\nbody\n' },
  })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Win', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Here', cwd: 'C:\\Users\\u\\proj' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\Users\\u\\repo\\parse.ts', agentId: 'a1' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^◐ explorer Sonnet 5\.5:medium {2}~\/proj$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  · Read parse.ts' })).toBeDefined()
})

test('a resumed agent runs again under its new task; the completed task keeps its frozen run', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  const clock = agentStub(on, out)
  on('session.send', () => ({ isDelivered: true as const }))
  const json = (id: string) => out.json?.('sid-1', id)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'First', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: 'Work' } as never)
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await clock.advance(274_000)
  await $.turn.complete(done('a1'))
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  expect(json('1')).toMatchObject({
    owner: 'a1',
    ownerRun: { type: 'explorer', ms: 274_000, model: 'claude-sonnet-5-5', effort: 'medium' },
  })

  await $.tool.call({ tool: CREATE, subject: 'Second', description: 'd' })
  await $.tool.call({ tool: UPDATE, taskId: '2', status: 'in_progress', owner: 'a1' })
  await $.session.send({ to: 'a1', text: 'next one' } as never)
  // The send alone marks the new run, before the agent makes a call.
  let ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'a1' } as never)
  ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  · Bash make' })).toBeDefined()
  // The completed task keeps its frozen run while the agent runs again under the next.
  expect(await ui.find({ type: 'Text', text: '  └ ✓ explorer Sonnet 5.5:medium 4m34s' })).toBeDefined()
  await ui.unmount()

  await clock.advance(5_000)
  await $.turn.complete(done('a1'))
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '  └ ✓ explorer Sonnet 5.5:medium 5s' })).toBeDefined()
  expect(json('1')).toMatchObject({ ownerRun: { type: 'explorer', ms: 274_000 } })
})

test('a resume fires agent.spawn without resetting the row or claiming again', async ($, on) => {
  const clock = agentStub(on)
  on('session.send', () => ({ isDelivered: true as const }))
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Work', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Fix the parser' } as never)
  await clock.advance(3_000)
  await $.turn.complete(done('a1'))
  await $.session.send({ to: 'a1', text: 'next' } as never)
  await $.agent.spawn({ prompt: 'next', subagentType: 'explorer', description: '', resume: true } as never)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  // A fresh row would carry the resume's empty description.
  expect(await ui.find({ type: 'Text', text: /^  Fix the parser$/ })).toBeDefined()
})

test('a call from a finished agent is a resume too', async ($, on) => {
  const clock = agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Work', description: 'd' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description: '#1 Work' } as never)
  await clock.advance(3_000)
  await $.turn.complete(done('a1'))
  await $.tool.call({ tool: 'Bash', command: 'again', agentId: 'a1' } as never)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  · Bash again' })).toBeDefined()
})

test('a /resume or /branch ends the session: the agents it ran are not drawn under Other', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', subagentType: 'checker', description: 'Review the diff' })
  await $.turn.complete(done('a1'))
  await $.session.end({ reason: 'resume', sessionId: 'sid-1', resume: {} as never })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /checker/ })).toBeUndefined()
})

test('a running agent whose only task is completed with its frozen run is drawn under Other', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, 'Build it')
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'in_progress', owner: 'a1' })
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  // a1 still runs (a resume by SendMessage looks the same) and holds only the frozen run.
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
})

test('an agent whose claimed task was deleted is drawn under Other', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, '#1 Build it')
  expect(await listOf($)).toContain('(owner: a1)')
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'deleted' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:a1' })).toBeDefined()
})

test('Other at the 44-column dock: a long type and a directory leave no row wider than 44 cells', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', subagentType: 'a-very-long-subagent-type-name', description: 'x'.repeat(80), cwd: '/a/b/c/dddddddddddd' } as never)
  const ui = await mountRows($, 40, 44)
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  // The head row is what this layout cuts to fit; the description row is truncated by the renderer.
  const heads = (await ui.findAll({ type: 'Text', text: /^◐ a-very/ })).map(t => String(t.text))
  expect(heads).toHaveLength(1)
  expect(cells(heads[0]!)).toBeLessThanOrEqual(44)
})

test('an owner given as the 8-character id an Agent result shows is stored as the full id and draws the running block', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out, { agentId: () => 'abc2ea9c-1111-2222-3333-444455556666' })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, 'Build it')
  await $.tool.call({ tool: UPDATE, taskId: '1', owner: 'abc2ea9c' })
  expect(out.json?.('sid-1', '1')).toMatchObject({ owner: 'abc2ea9c-1111-2222-3333-444455556666' })
  const ui = await mountPane($)
  expect(await ui.find({ key: 'pane-owned:abc2ea9c-1111-2222-3333-444455556666' })).toBeDefined()
  expect(await ui.find({ key: 'pane-agent:abc2ea9c-1111-2222-3333-444455556666' })).toBeDefined()
  // A value matching no agent stays as given.
  await $.tool.call({ tool: UPDATE, taskId: '1', owner: 'zzzzzzzz' })
  expect(out.json?.('sid-1', '1')).toMatchObject({ owner: 'zzzzzzzz' })
})

test('an agent that claimed task N by #N and still runs when N completes is drawn once, under Other', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, '#1 Build it')
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.findAll({ key: 'pane-agent:a1' })).toHaveLength(1)
})

test('the same under the [open] filter, which hides the completed task', async ($, on) => {
  agentStub(on)
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await spawn($, '#1 Build it')
  await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
  const ui = await mountPane($)
  await ui.press({ key: 'filter-open' })
  expect(await ui.find({ type: 'Text', text: 'Other' })).toBeDefined()
  expect(await ui.findAll({ key: 'pane-agent:a1' })).toHaveLength(1)
})

test('an owner prefix that matches several agents is refused and changes nothing', async ($, on) => {
  const out: Parameters<typeof agentStub>[1] = {}
  agentStub(on, out, { agentId: n => `abc2ea9c-${n}` })
  await $.session.start(START)
  await $.tool.call({ tool: CREATE, subject: 'Build', description: 'd' })
  await $.tool.call({ tool: CREATE, subject: 'Other', description: 'd' })
  await spawn($, 'One')
  await spawn($, 'Two')
  const r = await $.tool.call({ tool: UPDATE, updates: [{ taskId: '2', subject: 'Renamed' }, { taskId: '1', owner: 'abc2ea9c' }] })
  expect(r.deny).toBe('owner "abc2ea9c" matches 2 agents; give more of the id.')
  expect(await listOf($)).not.toContain('Renamed')
  expect(await listOf($)).not.toContain('owner')
})
