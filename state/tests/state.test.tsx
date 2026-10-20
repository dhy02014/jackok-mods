import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const START = { cwd: '/home/u/proj', surface: 'terminal', isInteractive: true } as const

const RESET = new Date(2 * 3600_000 + 10 * 60_000).toISOString()

type StubOptions = {
  tokens?: () => number
  authorized?: boolean
  usageBody?: string
  writes?: { path: string; text: string }[]
  /** Agent definition files by absolute path. */
  files?: Record<string, string>
  runs?: string[][]
  /** The session's cwd; `/home/u/proj` by default. */
  cwd?: string
  /** What `tail` of the transcript prints. */
  tail?: () => string
  /** Environment; `{ HOME: '/home/u' }` by default. */
  env?: Record<string, string>
  /** `$.session.usage()` rejects, as before the session binds. */
  isUsageFailing?: boolean
  /** What `git status` prints. */
  gitStdout?: string
  /** `$.session.id()`; `sid-1` by default. A /clear goes on under another. */
  sessionId?: string
  /** `git` is not installed: every git run rejects as a failed spawn. */
  isGitMissing?: boolean
  /** URLs the mod fetched. */
  fetches?: string[]
  /** Claude Code's `language` setting; unset by default. */
  language?: string
}

// A Windows host hands `fs.*` hooks native paths (`C:\home\u\...`); key the stubs by the POSIX form.
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')

const stub = (on: On, o: StubOptions = {}) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, o.env ?? { HOME: '/home/u' })
  mock.store(on)
  on('session.usage', () => {
    if (o.isUsageFailing === true) throw new Error('not bound')
    return {
      value: {
        startedAt: 0,
        context: { tokens: o.tokens?.() ?? 84_000, window: 200_000, percent: 42 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: RESET }],
        cost: { usd: 1.5 },
      },
    }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: o.cwd ?? '/home/u/proj' }))
  on('session.id', () => ({ value: o.sessionId ?? 'sid-1' }))
  on('session.authorize', () => ({ value: o.authorized === true ? { handle: 'h', kind: 'bearer' as const } : null }))
  on('http.fetch', ($, e) => {
    o.fetches?.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: o.usageBody ?? '{"limits":[]}' } }
  })
  if (o.language !== undefined) on('settings.read', () => ({ value: { language: o.language } }))
  on('fs.exists', ($, e) => ({ value: o.files?.[norm(e.path)] !== undefined }))
  on('fs.read', ($, e) => ({ value: o.files?.[norm(e.path)] ?? '' }))
  on('fs.write', ($, e) => {
    o.writes?.push({ path: norm(e.path), text: e.text })
    return { value: undefined }
  })
  on('command.register', () => ({ value: { name: 'state' } }))
  on('process.run', ($, e) => {
    if (o.isGitMissing === true && e.argv[0] === 'git') return { deny: 'spawn git ENOENT' }
    return {
      value: {
        exitCode: (o.runs?.push([...e.argv]), 0),
        stdout: e.argv[0] === 'tail' ? (o.tail?.() ?? '') : (o.gitStdout ?? '# branch.head main\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b f.ts\n'),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', { tool: 'TaskCreate' }, () => ({
    result: { task: { id: '1', subject: 'Write the HUD' } },
  }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

test('main-loop turns build the last-turn delta', async ($, on) => {
  const readings = [10_000, 40_000, 25_000]
  let tokens = readings[0] ?? 0
  stub(on, { tokens: () => tokens })
  await $.session.start(START)

  const endTurn = (agentId?: string) =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId })

  for (const value of readings) {
    tokens = value
    await endTurn()
  }
  // A subagent's turn adds no point.
  tokens = 190_000
  await endTurn('sub-1')
  tokens = 25_000

  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' ▼-15.0k' })).toBeDefined()
})

test('band shows context, model, cwd, git, limits and cost, and leaves tasks to the engine', async ($, on) => {
  stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the HUD', description: 'd' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'state', surface, ...BAND })
    // A labelled rule as wide as the band sets it apart from what sits above; its title is the fold button.
    expect(await ui.find({ type: 'Text', text: ` ${'─'.repeat(120 - 9)}` })).toBeDefined()
    expect((await ui.find({ key: 'fold' }))?.props.label).toBe('state')
    // The band's lines, piece by piece.
    expect(await ui.find({ type: 'Text', text: 'Context ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' (84.00k)' })).toBeDefined()
    // No forecast label beside the fill: the percent says it.
    expect(await ui.find({ type: 'Text', text: /Cloudy|Clear|Showers|Storm|Compact soon/ })).toBeUndefined()
    // No turn has run: ▲ never stands in with the whole context.
    expect(await ui.find({ type: 'Text', text: /▲/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '~/proj' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'main* ↑2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sid-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Session ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' (2h 10m)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '×1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Write the HUD/ })).toBeUndefined()
    // The rule stays flush left; every row under it sits indented.
    const band = await ui.drawn()
    expect(band.type === 'Box' ? band.children.slice(0, 2) : undefined).toMatchObject([
      { type: 'Box' },
      { type: 'Box', props: { paddingLeft: 2 } },
    ])

    // The fold toggle leads the tools line; the id stands bare, without an `id ` label.
    // Document order: the rule's title, the id ending the first row, the toggle opening the tools row.
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['fold', 'copy-cwd', 'copy-id', 'toggle'])
    expect(await ui.find({ type: 'Text', text: 'id ' })).toBeUndefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /Write the HUD/ })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})

test('the band draws at start even when usage cannot be read yet', async ($, on) => {
  stub(on, { isUsageFailing: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('state')
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/proj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'sid-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '42%' })).toBeUndefined()
})

test('on Windows the band reads USERPROFILE for the cwd label', async ($, on) => {
  stub(on, { env: { USERPROFILE: 'C:\\Users\\u' }, cwd: 'C:\\Users\\u\\work\\proj' })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '…\\work\\proj' })).toBeDefined()
})

test('the band writes no file and runs nothing but git, through measurements and minute ticks', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const runs: string[][] = []
  const clock = stub(on, { writes, runs })
  await $.session.start(START)
  await $.session.measure({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [],
    changed: ['context'],
  })
  await clock.advance(60_000)
  await clock.advance(60_000)
  expect(writes).toEqual([])
  expect(runs.length).toBeGreaterThan(0)
  expect(runs.every(r => r[0] === 'git')).toBe(true)
})

test('without git on the machine the band still draws, with no git part', async ($, on) => {
  stub(on, { isGitMissing: true })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/proj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /main/ })).toBeUndefined()
})

test('git status with CRLF line ends still parses', async ($, on) => {
  stub(on, { gitStdout: '# branch.head main\r\n# branch.ab +2 -0\r\n1 .M N... 100644 100644 100644 a b f.ts\r\n' })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'main* ↑2' })).toBeDefined()
})

test('subagents show as an agents tally line by type and model; their live rows and calls stay off the band', async ($, on) => {
  stub(on, {
    files: { '/home/u/.claude/agents/explorer.md': '---\nname: explorer\neffort: high\n---\nbody\n' },
  })
  let next = 0
  on('agent.spawn', () => ({ model: next++ === 0 ? 'claude-sonnet-5-5' : 'claude-sonnet-5-4', agentId: `a${next}` }))
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer' })
  await $.agent.spawn({ prompt: 'p', subagentType: 'explorer' })
  // No definition file: no effort, so the model stands alone.
  await $.agent.spawn({ prompt: 'p', subagentType: 'checker' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  // A long command is kept whole; only the terminal's edge cuts it.
  const long = `grep -n x ${'dir/'.repeat(12)}f.ts`
  await $.tool.call({ tool: 'Bash', command: long, agentId: 'a1' })

  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  // One entry per type; a second model of the same type is named apart inside it.
  expect(await ui.find({ type: 'Text', text: /^explorer \(Sonnet 5\.5:high x1, Sonnet 5\.4:high x1\) \| checker \(Sonnet 5\.4 x1\)$/ })).toBeDefined()
  // A subagent's calls reach neither a live row nor the main tool tally here.
  expect(await ui.find({ type: 'Text', text: /Locate the file/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: `: ${long} ×2` })).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /^✓ $/ })).toHaveLength(0)

  // Its own toggle folds the line to each type's run count and opens it again.
  expect((await ui.find({ key: 'toggle-agents' }))?.props.label).toBe('[-]')
  await ui.press({ key: 'toggle-agents' })
  expect(await ui.find({ type: 'Text', text: /^explorer x2 \| checker x1$/ })).toBeDefined()
  expect((await ui.find({ key: 'toggle-agents' }))?.props.label).toBe('[+]')
  await ui.press({ key: 'toggle-agents' })
  expect(await ui.find({ type: 'Text', text: /^explorer \(Sonnet 5\.5:high x1/ })).toBeDefined()
})

test('with per_model_limits off, no request is made and only the engine’s limits show', async ($, on) => {
  const fetches: string[] = []
  const clock = stub(on, {
    authorized: true,
    fetches,
    usageBody: JSON.stringify({ limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 3, scope: { model: { display_name: 'Fable' } } }] }),
  })
  await $.session.start(START)
  await clock.settle()
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(fetches).toEqual([])
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Session ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Fable ' })).toBeUndefined()
})

test('with per_model_limits on, per-model weekly limits come from the OAuth usage endpoint', { options: { per_model_limits: true } }, async ($, on) => {
  const fetches: string[] = []
  const clock = stub(on, {
    authorized: true,
    fetches,
    usageBody: JSON.stringify({
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 23, scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 3, scope: { model: { display_name: 'Fable' } } },
        // A repeated scope collapses to one entry; an out-of-range figure is clamped.
        { kind: 'weekly_scoped', group: 'weekly', percent: 140, scope: { model: { display_name: 'Opus' } } },
      ],
    }),
  })
  await $.session.start(START)
  // The start hook does not wait on the network.
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Fable ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '100%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '23%' })).toBeUndefined()
  expect(fetches).toEqual(['https://api.anthropic.com/api/oauth/usage'])
})

test('git-touching tool calls return without waiting on git, and a burst runs it once', async ($, on) => {
  const runs: string[][] = []
  const clock = stub(on, { runs })
  await $.session.start(START)
  await clock.settle()
  const before = runs.length
  await $.tool.call({ tool: 'Bash', command: 'touch a' })
  await $.tool.call({ tool: 'Bash', command: 'touch b' })
  await $.tool.call({ tool: 'Bash', command: 'touch c' })
  expect(runs.length).toBe(before)
  await clock.advance(1)
  await clock.settle()
  const after = runs.slice(before)
  expect(after).toEqual([['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch']])
})

test('a Korean language setting still yields English band labels and toasts', async ($, on) => {
  const toasts: string[] = []
  stub(on, { language: 'ko' })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Context ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Session ' })).toBeDefined()
  await $.session.measure({
    context: { tokens: 170_000, window: 200_000, percent: 85 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 82, resetsAt: RESET },
      { kind: 'spend_limit', percentUsed: 90 },
    ],
    changed: ['rateLimits', 'context'],
  })
  expect(toasts).toEqual(['5h 82% used (resets in 2h 10m)', 'spend 90% used', 'ctx 85% used'])
})

test('a measurement past 80% toasts once', async ($, on) => {
  const toasts: string[] = []
  stub(on)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(START)

  const measure = (percent: number) =>
    $.session.measure({
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: RESET }],
      cost: { usd: 1.5 },
      changed: ['rateLimits'],
    })
  await measure(82)
  await measure(83)
  // A dip under 95 but not under 80 does not re-arm the 80 toast.
  await measure(79.5 + 0.5)
  expect(toasts).toEqual(['5h 82% used (resets in 2h 10m)'])
})

test('a failed pull at start still arms the minute timer', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  let failing = true
  let pulled = 0
  on('session.usage', () => {
    if (failing) throw new Error('usage unavailable')
    pulled++
    return { value: { startedAt: 0, context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [] } }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/u' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.authorize', () => ({ value: null }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { name: 'state' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  failing = false
  // The start retries cover the first ten seconds; the minute tick pulls after that.
  await clock.advance(30_000)
  const before = pulled
  await clock.advance(60_000)
  expect(pulled).toBeGreaterThan(before)
})

test('a /clear drops the old conversation from the band', async ($, on) => {
  stub(on)
  on('session.end', () => ({ sessionId: 'sid-1' }))
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: {} as never })
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '×1' })).toBeUndefined()
})

test('after a /clear the band pulls git for the new session itself, with no turn and no session.start', async ($, on) => {
  const o: StubOptions = {}
  const clock = stub(on, o)
  on('session.end', () => ({ sessionId: 'sid-1' }))
  await $.session.start(START)
  let ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'main* ↑2' })).toBeDefined()

  o.sessionId = 'sid-2'
  o.gitStdout = '# branch.head feat\n'
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: {} as never })
  await clock.advance(10)
  await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  await clock.advance(10)
  ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'feat' })).toBeDefined()
})

test('the band starts shown and expanded; /state hides all of it, then shows it again', async ($, on) => {
  stub(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'copy-id' })).toBeDefined()
  expect(await $.command.run({ command: 'state' })).toMatchObject({ text: 'State band hidden.' })
  const hidden = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await hidden.find({ type: 'Button' })).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: /\S/ })).toBeUndefined()
  expect(await $.command.run({ command: 'state' })).toMatchObject({ text: 'State band shown.' })
  const shown = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await shown.find({ key: 'copy-id' })).toBeDefined()
})

test('pressing the rule’s title folds the band to its rule, and again brings every row back', async ($, on) => {
  stub(on)
  await $.session.start(START)
  const mount = () => $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  let ui = await mount()
  await ui.press({ key: 'fold' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: ` ${'─'.repeat(120 - 9)}` })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['state'])
  expect(await ui.find({ type: 'Text', text: 'Context ' })).toBeUndefined()
  await ui.press({ key: 'fold' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: 'Context ' })).toBeDefined()
})

test('pressing the session id copies it to the clipboard', async ($, on) => {
  stub(on)
  const copied: string[] = []
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('[-]')
  await ui.press({ key: 'copy-id' })
  expect(copied).toEqual(['sid-1'])
})

test('pressing the cwd copies its full path, not the shortened label', async ($, on) => {
  stub(on)
  const copied: string[] = []
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  await ui.press({ key: 'copy-cwd' })
  expect(copied).toEqual([START.cwd])
})

test('the main loop effort comes from the model request', async ($, on) => {
  stub(on)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await $.session.start(START)
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  // Joined to the model as the agents line joins a subagent's: `Opus 5.5:xhigh`.
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5:xhigh' })).toBeDefined()})

test('advisor calls tally like a tool and toast, naming no model', async ($, on) => {
  const toasts: string[] = []
  const timeouts: (number | undefined)[] = []
  stub(on)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    timeouts.push(e.timeoutMs)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: [{ id: 's1', name: 'advisor', input: {}, startedAt: 1000, endedAt: 9200 }],
      stopReason: 'end_turn' as const,
      usage: null,
    }
  })
  await $.session.start(START)
  for (const agentId of [undefined, 'a1']) {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
      // drain
    }
  }
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'advisor ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '×1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' +1 sub' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fable/i })).toBeUndefined()
  // Stamped with the call's local time, held for the engine's 60 s cap rather than the default 4 s.
  expect(toasts).toHaveLength(2)
  expect(toasts[0]).toMatch(/^advisor consulted · 8\.2s · \d\d:\d\d$/)
  expect(toasts[1]).toMatch(/^advisor consulted \(subagent\) · 8\.2s · \d\d:\d\d$/)
  expect(timeouts).toEqual([60_000, 60_000])
  // The toast is the only notice: the band draws no row to press.
  expect(await ui.find({ key: 'ack-advisor' })).toBeUndefined()
})

test('a live advisor call takes the tool row, its mark blinking', async ($, on) => {
  const clock = stub(on)
  let release = () => {}
  const held = new Promise<void>(r => (release = r))
  on('turn.step', async function* ($, e) {
    await held
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await $.session.start(START)
  const row = (agentId: string | undefined, uuid: string, block: Record<string, unknown>) =>
    $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid,
      ...(agentId !== undefined ? { agentId } : {}),
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'x' }, block] },
    })
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  const dot = () => ui.find({ type: 'Text', text: '  ◐ ', props: { color: 'yellow' } })
  const gap = () => ui.find({ type: 'Text', text: '    ', props: { color: 'yellow' } })
  const label = () => ui.find({ type: 'Text', text: 'advisor', props: { color: 'cyan' } })
  expect(await dot()).toBeUndefined()
  expect(await label()).toBeUndefined()

  await row(undefined, 'r1', { type: 'server_tool_use', id: 's1', name: 'advisor', input: {} })
  expect(await dot()).toBeDefined()
  expect(await label()).toBeDefined()
  // It blinks: off, then on again, holding its cells.
  await clock.advance(500)
  expect(await dot()).toBeUndefined()
  expect(await gap()).toBeDefined()
  await clock.advance(500)
  expect(await dot()).toBeDefined()

  // Another call's result, or another server tool, leaves it.
  await row(undefined, 'r2', { type: 'advisor_tool_result', tool_use_id: 's0', content: {} })
  await row(undefined, 'r3', { type: 'server_tool_use', id: 'w1', name: 'web_search', input: {} })
  expect(await dot()).toBeDefined()
  await row(undefined, 'r4', { type: 'advisor_tool_result', tool_use_id: 's1', content: {} })
  expect(await dot()).toBeUndefined()
  expect(await gap()).toBeUndefined()
  await clock.advance(1500)
  expect(await dot()).toBeUndefined()

  // A step that ends with no result row clears its loop's call.
  await row('a1', 'r5', { type: 'server_tool_use', id: 's2', name: 'advisor', input: {} })
  expect(await dot()).toBeDefined()
  const drain = (async () => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })) {
      // drain
    }
  })()
  release()
  await drain
  expect(await dot()).toBeUndefined()
})

test('the cwd shows at most its last two segments', async ($, on) => {
  stub(on, { cwd: '/home/u/dir/sandbox/app/.claude/worktrees/feature-x' })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '…/worktrees/feature-x' })).toBeDefined()
})

test('▲ sums the latest user turn’s main-loop requests, cache reads and subagents left out', async ($, on) => {
  stub(on)
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'claude-opus-5-5', input_tokens: 1_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 90_000, output_tokens: 110 },
    }
  })
  const step = async (turnId: string, index: number, agentId?: string) => {
    for await (const _ of $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
      // drain
    }
  }
  await $.session.start(START)
  // An earlier turn's figure does not carry into the next.
  await $.turn.start({ text: 'first', turnId: 't1' })
  await step('t1', 0)
  await $.turn.start({ text: 'second', turnId: 't2' })
  await step('t2', 0)
  await step('t2', 1)
  // A subagent's own turn starting does not reset the user turn's figure.
  await $.turn.start({ text: 'sub', turnId: 't3', agentId: 'a1' } as never)
  await step('t2', 0, 'a1')
  const ui = await $.ui.mount({ plugin: 'state', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' ▲+22.22k' })).toBeDefined()
})

test('rate-limit failures, compactions and warm model switches toast', async ($, on) => {
  const toasts: string[] = []
  stub(on)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('classic.StopFailure', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  const kept = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
  on('session.compact', () => ({ messages: kept, tokensBefore: 150_000, tokensAfter: 30_000 }))
  await $.session.start(START)

  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.session.compact({ trigger: 'auto', messages: kept })
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 84_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0.42,
  } as never)

  expect(toasts).toContain('Request failed: usage limit reached')
  expect(toasts).toContain('Context compacted: 150.0k → 30.0k')
  expect(toasts).toContain('Model switched Opus 5.5 → Sonnet 5.5: cache rewrite about $0.42')
})
