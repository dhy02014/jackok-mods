import { expect, mock, test } from 'claude-code/testing'
import { START, stub, said, done, instructionStub, reminder, opening, afterRead, reply, MEASURE, mountPrompt, prompt, rows, sizes } from './helpers'

test('each file shows its body size at the right, the newest copy counting, and a total under them', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  await $.session.start(START)
  const big = 'x'.repeat(2048)
  convo.messages = [
    {
      role: 'user',
      content: [
        // A body runs to the next framing line or the reminder's close; Hangul is 3 bytes a syllable.
        { type: 'text', text: `<system-reminder>\nContents of /home/u/.claude/CLAUDE.md:\n\n${big}\n\nContents of /home/u/.claude/rules/k.md:\n\n가나\n</system-reminder>` },
        { type: 'text', text: 'hi' },
      ],
    },
    reply,
    afterRead('/home/u/.claude/rules/style.md'),
    // A later copy of an edited file carries its new body.
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nContents of /home/u/.claude/rules/k.md:\n\n가나다\n</system-reminder>' }] },
  ]
  await $.session.measure(MEASURE)
  const ui = await mountPrompt($)
  expect(await rows(ui)).toEqual(['~/.claude', 'CLAUDE.md', 'rules/k.md', 'rules/style.md'])
  expect(await sizes(ui)).toEqual(['2.0K', '9B', '4B', 'total  2.0K'])
  // A compaction drops the copies; the banked size stays.
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  await $.session.measure(MEASURE)
  expect(await sizes(ui)).toEqual(['4B', '9B', '4B', 'total  17B'])
})

test('a rule whose reminder runs on past it is sized to its file on disk, frontmatter left out', async ($, on) => {
  stub(on, {
    files: {
      '/home/u/.claude/rules/k.md': '---\r\npaths:\r\n  - "*.json"\r\n---\r\n\r\n# K\r\n\r\nkeep\r\n',
      // Edited since it loaded: no longer the copy's opening, so the copy's span counts.
      '/home/u/.claude/rules/e.md': '# E\n\nnew text\n',
    },
  })
  const convo = instructionStub(on)
  await $.session.start(START)
  const tail = '\n\n\n<total_tokens>1 tokens left</total_tokens>\n\nA hook note.'
  convo.messages = [
    afterRead('/home/u/.claude/CLAUDE.md'),
    { role: 'user', content: [{ type: 'text', text: `<system-reminder>\nContents of /home/u/.claude/rules/k.md:\n\n# K\n\nkeep${tail}\n</system-reminder>` }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nContents of /home/u/.claude/rules/e.md:\n\n# E\n\nold\n</system-reminder>' }] },
  ]
  await $.session.measure(MEASURE)
  const ui = await mountPrompt($)
  // `body` (no file to read), `# K\n\nkeep`, `# E\n\nold`.
  expect(await sizes(ui)).toEqual(['4B', '9B', '8B', 'total  21B'])
})

test('each instruction file the model was sent shows under its root, by its path', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  await $.session.start(START)
  convo.messages = [
    opening('/home/u/.claude/CLAUDE.md', '/home/u/proj/CLAUDE.md (project instructions, checked into the codebase)'),
    { role: 'assistant', content: [{ type: 'text', text: reminder('/home/u/said.md') }] },
    afterRead('/home/u/.claude/rules/style.md'),
    // Any depth below a root that holds a loaded file joins that root; a root with none stays apart.
    afterRead('/home/u/proj/a/b/CLAUDE.md'),
    // Past three segments below its root, a path keeps only its last three.
    afterRead('/home/u/proj/a/b/c/d/CLAUDE.md'),
    afterRead('/home/u/lone/x/CLAUDE.md'),
    // A tool's output that quotes the framing outside a reminder is no load.
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Contents of /home/u/quoted.md:\n' }] },
  ]
  await $.session.measure(MEASURE)
  const ui = await mountPrompt($)
  expect((await ui.find({ key: 'pane-tab:prompt' }))?.props.label).toBe('Prompt 6')
  expect(await rows(ui)).toEqual([
    '~/.claude', 'CLAUDE.md', 'rules/style.md',
    '~/proj', 'CLAUDE.md', 'a/b/CLAUDE.md', '…/c/d/CLAUDE.md',
    '~/lone/x', 'CLAUDE.md',
  ])
})

test('a turn that ends recounts the list; a growing conversation banks nothing', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  await $.session.start(START)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  const { agentId: _, ...main } = done('a1')
  await $.turn.complete(main)
  convo.messages = [...convo.messages, reply, afterRead('/home/u/.claude/rules/style.md')]
  await $.turn.complete(main)
  const ui = await mountPrompt($)
  expect(await rows(ui)).toEqual(['~/.claude', 'CLAUDE.md', 'rules/style.md'])
})

test('a compaction shortens the conversation: what it dropped stays listed', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  await $.session.start(START)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md', '/home/u/.claude/memory/c/MEMORY.md'), reply, afterRead('/home/u/.claude/rules/style.md')]
  await $.session.measure(MEASURE)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  await $.session.measure(MEASURE)
  // Scanning the same window again banks nothing more.
  await $.session.measure(MEASURE)
  const ui = await mountPrompt($)
  expect(await rows(ui)).toEqual(['~/.claude', 'CLAUDE.md', 'memory/c/MEMORY.md', 'rules/style.md'])
  // Each tab's digit is its place in order; the Task tab's filter belongs to it alone.
  expect((await ui.find({ key: 'pane-tab:task' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'pane-tab:prompt' }))?.props.hotkey).toBe('2')
  expect(await ui.find({ key: 'filter-all' })).toBeUndefined()
})

test('a load mid-conversation counts what the conversation holds, once however often it loads', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  await $.session.start(START)
  await $.session.start(START)
  const ui = await mountPrompt($)
  expect(await rows(ui)).toEqual(['~/.claude', 'CLAUDE.md'])
})

test('a /clear empties the instruction list, its bank and its last scan', async ($, on) => {
  stub(on)
  const convo = instructionStub(on)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md'), reply, afterRead('/home/u/.claude/rules/style.md')]
  await $.session.start(START)
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  await $.session.measure(MEASURE)
  await $.session.end({ reason: 'clear' } as never)
  convo.messages = []
  const ui = await mountPrompt($)
  expect(await rows(ui)).toEqual([])
  convo.messages = [opening('/home/u/.claude/CLAUDE.md')]
  await $.session.measure(MEASURE)
  expect(await rows(ui)).toEqual(['~/.claude', 'CLAUDE.md'])
})

test('main-loop calls that end before the scan share one, a REPL call and its script’s calls included', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  stub(on)
  const seen = { scans: 0 }
  on('session.messages', () => {
    seen.scans++
    return { value: [] } as never
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  // As the engine runs it: the REPL call returns at dispatch, before its script's calls run.
  on('tool.call', { tool: 'REPL' }, () => ({ result: 'dispatched' }) as never)
  const settle = () => new Promise(r => setTimeout(r, 0))
  const bash = async () => {
    for (const command of ['a', 'b', 'c']) await $.tool.call({ tool: 'Bash', command })
  }
  await $.session.start(START)
  await clock.advance(1)
  await settle()
  const base = seen.scans
  await bash()
  await clock.advance(1)
  await settle()
  expect(seen.scans - base).toBe(1)
  await $.tool.call({ tool: 'REPL', code: 'x' } as never)
  await bash()
  await clock.advance(1)
  await settle()
  expect(seen.scans - base).toBe(2)
  // A call after the scan ran queues the next.
  await bash()
  await clock.advance(1)
  await settle()
  expect(seen.scans - base).toBe(3)
})

// A refused timer does not throw: its callback just never runs. That a fired one scans is the test above.
test('a scan timer the engine refuses stops no later scan: a call a second on queues another', async ($, on) => {
  stub(on)
  const clock = { now: 0, scanTimers: 0 }
  on('clock.now', () => ({ value: clock.now }))
  on('clock.after', (_, e) => {
    if (e.ms === 1) clock.scanTimers++
    return { deny: 'refused' } as never
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.session.start(START)
  const base = clock.scanTimers
  await $.tool.call({ tool: 'Bash', command: 'a' })
  expect(clock.scanTimers - base).toBe(1)
  // Within the second the lost scan still counts as queued; past it, a call queues afresh.
  clock.now = 999
  await $.tool.call({ tool: 'Bash', command: 'b' })
  expect(clock.scanTimers - base).toBe(1)
  clock.now = 1000
  await $.tool.call({ tool: 'Bash', command: 'c' })
  expect(clock.scanTimers - base).toBe(2)
})
