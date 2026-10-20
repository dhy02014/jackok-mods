import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cardAge, cardText, freeName, isStale, NEXT_CELLS, parseCard, rootOf, TITLE_CELLS, TOOLS, toolsFor, tooWide } from '../hooks/cards'
import { cells } from '../hooks/cells'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const HOME = '/home/u'
const MAIN = `${HOME}/repo`
const CARDS = `${MAIN}/handoff`
const CLOSED = `${MAIN}/handoff/closed`
const OTHER = `${HOME}/other`
const WORKTREE = `${MAIN}/.claude/worktrees/feat`
// Noon on 2026-10-11, local time: the day every age below is counted to.
const NOW = new Date(2026, 9, 11, 12).getTime()

const WRITE = 'mcp__handoff__card'
const LIST = 'mcp__handoff__list'

const card = (o: { title: string; status?: string; next?: string }) =>
  `---\ntitle: ${o.title}\nstatus: ${o.status ?? 'open'}\nnext: ${o.next ?? `next of ${o.title}`}\n---\n`

// The in-memory map keys every path POSIX-style: a Windows host hands `fs.*` native paths,
// and a POSIX host resolves `C:/...` against the plugin folder, as `<dir>/C:/...`.
// A second drive marker means the mod glued two absolute paths together: fail, never key it.
const norm = (path: string) => {
  if ((path.match(/[A-Za-z]:[\\/]/g) ?? []).length > 1) throw new Error(`doubled path: ${path}`)
  return path.replace(/\\/g, '/').replace(/^(?:.*\/)?[A-Za-z]:(?=\/)/, '')
}
// argv reaches the stub as the mod built it, never resolved against the mod folder.
const argvNorm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')

// The engine's side: HOME, the session's cwd, git answering per directory, and a file
// system in memory where mkdir and mv (or cmd's) act as they would on disk: mv -n and
// move /-y never replace a file, and neither lands in a folder that does not exist.
const stub = (
  on: On,
  o: {
    files?: Record<string, string>
    cwd?: string
    env?: Record<string, string>
    git?: Record<string, string>
    // Lines `git status --porcelain` prints in MAIN; every other repo is clean.
    dirty?: number
    isGitMissing?: boolean
    // Git before 2.31: rev-parse echoes the unknown --path-format and prints a relative common dir.
    isGitOld?: boolean
    // Paths `git ls-files --error-unmatch` does not know; every other path is tracked.
    untracked?: string[]
    // Files the folder listing leaves out, as one taken between the listing and the write would be.
    unlisted?: string[]
    language?: string
    fail?: 'mkdir' | 'mv' | 'skip'
  } = {},
) => {
  mock.clock(on, { now: NOW })
  mock.env(on, o.env ?? { HOME })
  mock.store(on)
  if (o.language !== undefined) on('settings.read', () => ({ value: { language: o.language } }))
  const files = new Map(Object.entries(o.files ?? {}))
  const dirs = new Set<string>()
  const isDir = (d: string) => dirs.has(d) || [...files.keys(), ...dirs].some(p => p.startsWith(`${d}/`))
  const exists = (p: string) => files.has(p) || isDir(p)
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const runs: string[][] = []
  // A seeded card was last changed at noon of its filename's date; a write changes it now.
  const mtimes = new Map<string, number>()
  const mtimeOf = (p: string) => {
    const m = /\/(\d{4})-(\d{2})-(\d{2})-[^/]*$/.exec(p)
    return mtimes.get(p) ?? (m === null ? NOW : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime())
  }
  const session = { id: 'sid-1', cwd: o.cwd ?? MAIN }
  const git: Record<string, string> = {
    [MAIN]: `${MAIN}/.git\n${MAIN}`,
    [WORKTREE]: `${MAIN}/.git\n${WORKTREE}`,
    ...o.git,
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: session.id }))
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: session.cwd }))
  // What the mod registered, as it was handed over.
  const registered: { name: string; description?: string }[] = []
  on('command.register', ($, e) => {
    registered.push({ name: `/${e.name}`, description: e.description })
    return { value: { command: 'handoff' } }
  })
  on('tool.register', ($, e) => {
    registered.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__handoff__${e.name}` } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.CwdChanged', () => ({}))
  on('fs.write', ($, e) => {
    files.set(norm(e.path), e.text)
    mtimes.set(norm(e.path), NOW)
    return { value: undefined }
  })
  on('fs.read', ($, e) => (files.has(norm(e.path)) ? { value: files.get(norm(e.path))! } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: exists(norm(e.path)) }))
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    if (!isDir(dir)) return { deny: 'ENOENT' }
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const p of [...files.keys(), ...dirs]) {
      if (!p.startsWith(`${dir}/`) || o.unlisted?.includes(p)) continue
      const rest = p.slice(dir.length + 1)
      const name = rest.split('/')[0]!
      kinds.set(name, rest === name && files.has(p) ? 'file' : 'dir')
    }
    return {
      value: [...kinds].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: mtimeOf(`${dir}/${name}`), isLink: false })),
    }
  })
  const done = (exitCode: number, stderr = '') => ({
    value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  const mkdir = (dir: string) => {
    if (o.fail === 'mkdir') return done(1, `mkdir: ${dir}: Permission denied`)
    dirs.add(dir)
    return done(0)
  }
  const move = (from: string, to: string) => {
    if (o.fail === 'mv') return done(1, `mv: rename ${from}: Permission denied`)
    // As mv -n does when a file lands at `to` between the mod's listing and the move.
    if (o.fail === 'skip') return done(0)
    if (!files.has(from) || !isDir(parentOf(to))) return done(1, `mv: ${from}: No such file or directory`)
    // -n: a file already at `to` is kept, and mv still exits 0.
    if (exists(to)) return done(0)
    files.set(to, files.get(from)!)
    mtimes.set(to, mtimeOf(from))
    files.delete(from)
    return done(0)
  }
  // The timeout each mkdir and mv run was given.
  const limits: (number | undefined)[] = []
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv[0] === 'git') {
      if (o.isGitMissing === true) return { deny: 'spawn git ENOENT' }
      const out = git[e.init?.cwd ?? session.cwd]
      if (out === undefined) return done(128, 'fatal: not a git repository')
      const dirty = (e.init?.cwd ?? session.cwd) === MAIN ? (o.dirty ?? 0) : 0
      const top = out.split('\n').at(-1)!
      const stdout =
        argv[1] === 'status'
          ? Array.from({ length: dirty }, (_, i) => ` M f${i}\n`).join('')
          : argv[1] === 'ls-files'
            ? `${argv.at(-1)}\n`
            : o.isGitOld && argv.includes('--path-format=absolute')
              ? `--path-format=absolute\n.git\n${top}\n`
              : argv.length === 3 && argv[2] === '--show-toplevel'
                ? `${top}\n`
                : `${out}\n`
      if (argv[1] === 'ls-files' && o.untracked?.includes(argvNorm(argv.at(-1)!))) {
        return done(1, `error: pathspec '${argv.at(-1)}' did not match any file(s) known to git`)
      }
      return { value: { ...done(0).value, stdout } }
    }
    limits.push(e.init?.timeoutMs)
    if (argv[0] === 'mkdir' && argv[1] === '-p') return mkdir(argv[2]!)
    if (argv[0] === 'mv' && argv[1] === '-n') return move(argv[2]!, argv[3]!)
    if (argv[0] === 'cmd' && argv[3] === 'mkdir') return mkdir(argvNorm(argv[4]!))
    if (argv[0] === 'cmd' && argv[3] === 'move' && argv[4] === '/-y') return move(argvNorm(argv[5]!), argvNorm(argv[6]!))
    return done(1, `${argv[0]}: not stubbed`)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>below</Text>
  })
  return { files, session, runs, limits, dirs, registered }
}

const said = (r: { result?: unknown; text?: string; deny?: string }) => String(r.deny ?? r.text ?? r.result)

// ---- the card format ----

test('a valid card parses, comments and quotes stripped, and writes back the same', () => {
  const text =
    '---\ntitle: "Fix: the band"\nstatus: hold            # open | hold\nnext: Read the types\nsummary: "Half done: the rule"\ndoc: ~/repo/plans/x.md\n---\nBody line\n'
  const c = parseCard('2026-10-01-fix-band.md', text)
  expect(c).toEqual({
    file: '2026-10-01-fix-band.md',
    title: 'Fix: the band',
    status: 'hold',
    next: 'Read the types',
    summary: 'Half done: the rule',
    doc: '~/repo/plans/x.md',
    body: 'Body line',
  })
  expect(parseCard(c!.file, cardText(c!))).toEqual(c)
  expect(cardText(c!)).not.toContain('updated')
})

test('a malformed card is skipped, never thrown', () => {
  expect(parseCard('a.md', 'no frontmatter at all')).toBeUndefined()
  expect(parseCard('a.md', '---\ntitle: x\nnext: y\n')).toBeUndefined() // unclosed
  expect(parseCard('a.md', card({ title: 'x', status: 'done' }))).toBeUndefined()
  expect(parseCard('a.md', '---\ntitle: x\n---\n')).toBeUndefined() // no next
  expect(parseCard('a.md', '---\n: : :\n[[[\n---\n')).toBeUndefined()
})

test('a card missing its optional fields parses with none of them; old `updated` and `workspaces` lines are ignored', () => {
  const c = parseCard('a.md', '---\ntitle: T\nworkspaces: [~/x]\nnext: N\nupdated: 2026-10-01\n---')
  expect(c).toEqual({ file: 'a.md', title: 'T', status: 'open', next: 'N', body: '' })
  // An older card's `on-hold` reads as `hold`, and is written back as `hold`.
  const old = parseCard('b.md', card({ title: 'T', status: 'on-hold' }))
  expect(old?.status).toBe('hold')
  expect(cardText(old!)).toContain('status: hold\n')
})

// ---- the workspace ----

test('a worktree resolves to its main checkout', () => {
  expect(rootOf(`${MAIN}/.git\n${MAIN}\n`)).toBe(MAIN)
  expect(rootOf(`${MAIN}/.git\n${WORKTREE}\n`)).toBe(MAIN)
  // A submodule's common dir is not named .git: its toplevel stands.
  expect(rootOf(`${MAIN}/.git/modules/sub\n${MAIN}/sub\n`)).toBe(`${MAIN}/sub`)
})

// ---- staleness ----

test('the language setting asks for every text field of a card in that language, once, in card', () => {
  const write = toolsFor('korean').find(t => t.name === 'card')!
  expect(write.description).toContain('Write title, next, summary and body in korean')
  expect(JSON.stringify(write.inputSchema)).not.toContain('korean')
  expect(toolsFor('korean').find(t => t.name === 'list')).toEqual(TOOLS[1])
  // Closing a card is `card` with status done; no separate close tool.
  expect(TOOLS.map(t => t.name)).toEqual(['card', 'list'])
  expect(toolsFor(undefined)).toBe(TOOLS)
  expect(toolsFor('  ')).toBe(TOOLS)
})

test('a card’s age counts from its file’s mtime, the filename’s date only when no mtime came; stale past 14 days', () => {
  const c = parseCard('2026-08-01-x.md', card({ title: 'x' }))!
  // Edited at 23:00 on 10-09: two days, not the seventy-one since it was created.
  expect(cardAge({ ...c, mtimeMs: new Date(2026, 9, 9, 23).getTime() }, NOW)).toBe(2)
  expect(cardAge({ ...c, mtimeMs: NOW }, NOW)).toBe(0)
  expect(cardAge(c, NOW)).toBe(71)
  expect(isStale({ ...c, mtimeMs: new Date(2026, 8, 27, 12).getTime() }, NOW)).toBe(false)
  expect(isStale({ ...c, mtimeMs: new Date(2026, 8, 26, 12).getTime() }, NOW)).toBe(true)
})

test('the band: matching cards over what sits below, stale age in yellow, hold dim, [more] shows all, /handoff hides and shows it', async ($, on) => {
  stub(on, {
    files: {
      [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }),
      [`${CARDS}/2026-09-20-b.md`]: card({ title: 'Old' }),
      [`${CARDS}/2026-10-09-c.md`]: card({ title: 'Held', status: 'hold' }),
      [`${CARDS}/2026-10-08-d.md`]: card({ title: 'Fourth' }),
      [`${OTHER}/handoff/2026-10-08-e.md`]: card({ title: 'Elsewhere' }),
      [`${CARDS}/broken.md`]: 'not a card',
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  // Past three cards the last row ends in a button naming the hidden count; the rule gives way to the filter buttons.
  // The rule's label is its fold button; the rule gives way to the filter buttons beside it: 2 cells of gap, then 19 of buttons.
  expect(await ui.find({ type: 'Text', text: ` ${'─'.repeat(60 - 2 - 19 - 11)}` })).toBeDefined()
  // The rule's row holds the title and the three filter buttons, the last card row the expand button;
  // each card's text is a copy button between them.
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([
    'handoff', '[all]', '[open]', '[hold]',
    '#1 Fresh — next of Fresh', '#2 Fourth — next of Fourth', '#3 Old — next of Old', '[more +1]',
  ])
  // Rows are numbered in the order shown: newest open card first.
  expect(await ui.find({ type: 'Text', text: '#1 Fresh — next of Fresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '#2 Fourth — next of Fourth' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '#3 Old — next of Old' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: ' 21 days' }))?.props.color).toBe('yellow')
  // A fresh card's age is yellow too, and singular.
  expect((await ui.find({ type: 'Text', text: ' 1 day' }))?.props.color).toBe('yellow')
  // Each age is followed by the card's status.
  const open = await ui.findAll({ type: 'Text', text: ' [open]' })
  expect(open.map(t => t.props.color)).toEqual(['green', 'green', 'green'])
  expect((await ui.find({ type: 'Text', text: '#1 Fresh — next of Fresh' }))?.props.dimColor).not.toBe(true)
  // On-hold sorts after open, so it is the one past the three shown.
  expect(await ui.find({ type: 'Text', text: /Held/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Elsewhere/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()

  // The last row's [more]/[less] button shows every matching card, and collapses them back.
  await ui.press({ key: 'expand' })
  const all = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect((await all.find({ type: 'Text', text: '#4 Held — next of Held' }))?.props.dimColor).toBe(true)
  // A row spells its status as the filter button does.
  expect((await all.find({ type: 'Text', text: ' [hold]' }))?.props.color).toBe('magenta')
  // Same width in both states, so the button stays under the pointer.
  expect((await all.findAll({ type: 'Button' })).filter(b => !String(b.key).startsWith('copy-')).map(b => b.props.label)).toEqual([
    'handoff', '[all]', '[open]', '[hold]', '[less -1]',
  ])
  expect(await all.find({ type: 'Text', text: /Elsewhere/ })).toBeUndefined()
  await all.press({ key: 'expand' })
  const less = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await less.find({ type: 'Text', text: /Held/ })).toBeUndefined()

  expect(
    await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' }, presentation: {} as never }),
  ).toMatchObject({ text: 'Handoff band hidden.' })
  const hidden = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await hidden.find({ key: 'fold' })).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: /──/ })).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: /Fresh/ })).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: 'below' })).toBeDefined()
  // Run again, the band is back.
  expect(
    await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' }, presentation: {} as never }),
  ).toMatchObject({ text: 'Handoff band shown.' })
  const shown = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect((await shown.find({ key: 'fold' }))?.props.label).toBe('handoff')
})

test('expanded past five cards, [^]/[v] page a five-row window, clamped at the ends; collapsing starts it over', async ($, on) => {
  const files: Record<string, string> = {}
  for (let d = 1; d <= 12; d++) files[`${CARDS}/2026-09-${String(30 - d)}-c${d}.md`] = card({ title: `Card${d}` })
  stub(on, { files })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  // Each card's copy button left out: only the band's controls.
  const labels = async (ui: Awaited<ReturnType<typeof mount>>) =>
    (await ui.findAll({ type: 'Button' })).filter(b => !String(b.key).startsWith('copy-')).map(b => b.props.label)
  const dims = async (ui: Awaited<ReturnType<typeof mount>>) =>
    [await ui.find({ key: 'page-up' }), await ui.find({ key: 'page-down' })].map(b => b?.props.dimColor === true)

  let ui = await mount()
  // Folded: no page buttons, the expand button as before.
  expect((await labels(ui)).slice(4)).toEqual(['[more +9]'])
  await ui.press({ key: 'expand' })

  ui = await mount()
  expect((await labels(ui)).slice(4)).toEqual(['[^]', '[v]', '[less -9]'])
  expect(await ui.find({ type: 'Text', text: '1-5/12 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#5 Card5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#6 / })).toBeUndefined()
  // [^] and [v] end their rows at the right edge: no padding after them (the filters' one-space gaps aside).
  expect(await ui.findAll({ type: 'Text', text: /^ {2,}$/ })).toHaveLength(0)
  // On the first page [^] has nowhere to go.
  expect(await dims(ui)).toEqual([true, false])

  await ui.press({ key: 'page-down' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: '6-10/12 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#6 Card6/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#5 / })).toBeUndefined()
  expect(await dims(ui)).toEqual([false, false])

  // The last page stops at the last five, and [v] dims.
  await ui.press({ key: 'page-down' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: '8-12/12 ' })).toBeDefined()
  expect(await dims(ui)).toEqual([false, true])
  await ui.press({ key: 'page-down' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: '8-12/12 ' })).toBeDefined()

  await ui.press({ key: 'page-up' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: '3-7/12 ' })).toBeDefined()

  // Folding and expanding again starts on the first page.
  await ui.press({ key: 'expand' })
  ui = await mount()
  await ui.press({ key: 'expand' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: '1-5/12 ' })).toBeDefined()
})

test('hold rows are dimmed; with no matching card the band still shows its rule and one dim row', async ($, on) => {
  stub(on, {
    files: { [`${CARDS}/2026-10-09-c.md`]: card({ title: 'Held', status: 'hold' }) },
    cwd: `${HOME}/elsewhere`,
  })
  await $.session.start({ cwd: `${HOME}/elsewhere`, surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  // Shown with nothing to list reads apart from hidden: the rule and filters stay, no card row.
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('handoff')
  expect((await ui.find({ type: 'Text', text: 'No cards.' }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^#\d/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()

  // EnterWorktree moves the cwd: the worktree matches its main checkout's cards. The
  // session's cwd is left stale here, so only the event's new_cwd can find them.
  await $.classic.CwdChanged({ old_cwd: `${HOME}/elsewhere`, new_cwd: WORKTREE })
  ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: '#1 Held — next of Held' }))?.props.dimColor).toBe(true)
})

test('a band drawn over a view never loaded, as a /clear leaves it, loads the cards itself', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  // No session.start and no turn: the state a /clear leaves is the empty one.
  await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '#1 Fresh — next of Fresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No cards.' })).toBeUndefined()
})

test('each filter button sets its filter directly, keeps each card’s number, and /handoff sets it', async ($, on) => {
  stub(on, {
    files: {
      [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }),
      [`${CARDS}/2026-10-09-c.md`]: card({ title: 'Held', status: 'hold' }),
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  // Only the active filter's button is drawn at full strength.
  const active = async () => (await ui.findAll({ type: 'Button' })).filter(b => b.props.dimColor === false).map(b => b.props.label)
  let ui = await mount()
  expect(await ui.find({ type: 'Text', text: '#2 Held — next of Held' })).toBeDefined()
  expect(await active()).toEqual(['[all]'])

  // Hold is one press away, not two.
  await ui.press({ key: 'filter-hold' })
  ui = await mount()
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('handoff: hold')
  expect(await active()).toEqual(['[hold]'])
  // Filtered, the card keeps the number it has among all cards.
  expect(await ui.find({ type: 'Text', text: '#2 Held — next of Held' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fresh/ })).toBeUndefined()

  await ui.press({ key: 'filter-open' })
  ui = await mount()
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('handoff: open')
  expect(await active()).toEqual(['[open]'])
  expect(await ui.find({ type: 'Text', text: '#1 Fresh — next of Fresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Held/ })).toBeUndefined()

  await ui.press({ key: 'filter-all' })
  ui = await mount()
  expect(await active()).toEqual(['[all]'])

  const run = (args: string) => $.command.run({ command: 'handoff', args, origin: { kind: 'composer' }, presentation: {} as never })
  expect(await run('hold')).toMatchObject({ text: 'Handoff band shows hold cards.' })
  ui = await mount()
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('handoff: hold')
  expect(await run('bogus')).toMatchObject({ text: 'Unknown filter "bogus": use open, hold or all.' })
  expect(await run('all')).toMatchObject({ text: 'Handoff band shows every card.' })
})

test('a filter that matches nothing keeps a dim row under the buttons', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'handoff', args: 'hold', origin: { kind: 'composer' }, presentation: {} as never })
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'No hold cards.' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['handoff: hold', '[all]', '[open]', '[hold]'])
})

test('pressing the rule’s title folds the band to its full-width rule, and again brings every row back', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  let ui = await mount()
  await ui.press({ key: 'fold' })
  ui = await mount()
  // Folded: the rule runs the full width, its title the only button; no card row, what sits below stays.
  expect(await ui.find({ type: 'Text', text: ` ${'─'.repeat(60 - 11)}` })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['handoff'])
  expect(await ui.find({ type: 'Text', text: /Fresh/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  await ui.press({ key: 'fold' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: '#1 Fresh — next of Fresh' })).toBeDefined()
})

test('pressing a card row copies the card file’s full path, file name included', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  const copied: string[] = []
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  await ui.press({ key: 'copy-2026-10-10-a.md' })
  expect(copied).toEqual([`${CARDS}/2026-10-10-a.md`])
})

// The user's row #3 under 1.1.2: its age and status went past the terminal's edge.
const LONG_TITLE = '개인 mods → 공개 jackok-mods 전환 마무리'
const LONG_NEXT =
  '사용자가 `! cp ~/.claude/settings.darwin.json ~/.claude/settings.json`로 live 설정을 동기화하면 jackok-mods를 GitHub 소스로 다시 받고 spawn-gate@khko-mods를 설치한 뒤 `/reload-plugins`로 실동작 확인'
const longCard = (file: string, title = LONG_TITLE) => cardText({ file, title, status: 'open', next: LONG_NEXT, body: '' })

test('a long card stays one row: its text is cut by cells so the age and status fit inside bodyColumns', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: longCard('2026-10-10-a.md') } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  for (const columns of [40, 80, 170]) {
    const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } })
    const text = String((await ui.find({ key: 'copy-2026-10-10-a.md' }))?.props.label)
    expect(text.startsWith('#1 ')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(await ui.find({ type: 'Text', text: ' 1 day' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' [open]' })).toBeDefined()
    // Indent, the card text, ` 1 day` and ` [open]`: never past the band's width.
    expect(2 + cells(text) + cells(' 1 day') + cells(' [open]')).toBeLessThanOrEqual(columns)
    expect(2 + cells(text) + cells(' 1 day') + cells(' [open]')).toBeGreaterThan(columns - 2)
    // At 80 and 170 the title stays whole and next gives way; at 40 the title is cut too.
    if (columns >= 80) expect(text.startsWith(`#1 ${LONG_TITLE} — `)).toBe(true)
    else expect(text).not.toContain(' — ')
  }
})

test('the tightest row, the last one with [more +N], is cut so its age, status and button fit', async ($, on) => {
  const files: Record<string, string> = {}
  for (const n of [1, 2, 3, 4]) files[`${CARDS}/2026-10-02-c${n}.md`] = longCard(`2026-10-02-c${n}.md`)
  stub(on, { files })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  for (const columns of [80, 170]) {
    const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } })
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('copy-')).map(b => String(b.props.label))
    expect(rows).toHaveLength(3)
    expect(await ui.findAll({ type: 'Text', text: ' 9 days' })).toHaveLength(3)
    expect(await ui.find({ key: 'expand' })).toBeDefined()
    // Indent, text, age, status, then one cell and `[more +1]`.
    expect(2 + cells(rows[2]!) + cells(' 9 days') + cells(' [open]') + 1 + cells('[more +1]')).toBeLessThanOrEqual(columns)
    expect(2 + cells(rows[0]!) + cells(' 9 days') + cells(' [open]')).toBeLessThanOrEqual(columns)
    expect(cells(rows[2]!)).toBeLessThan(cells(rows[0]!))
  }
})

test('on a narrow band the title is cut so the rule row stays bodyColumns wide', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'handoff', args: 'hold', origin: { kind: 'composer' }, presentation: {} as never })
  let ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 35 } })
  // 35 - 2 gap - 19 filters = 14 cells: `── ` + a 10-cell title + ` `.
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('handoff: h')
  expect(await ui.find({ type: 'Text', text: ' ' })).toBeDefined()
  await ui.press({ key: 'fold' })
  // Folded, the rule takes every cell: 8 = `── ` + a 4-cell title + ` `.
  ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 8 } })
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('hand')
})

// ---- the tools ----

// Closing only ever moves: every command the mod runs is git, mkdir or mv.
const onlyMoves = (runs: string[][]) =>
  runs.every(argv => argv[0] === 'git' || argv[0] === 'mkdir' || argv[0] === 'mv' || argv[0] === 'cmd')

test('widths count terminal cells: Hangul is 2, so the caps hold 20 Hangul in a title and 30 in next', () => {
  expect(cells('abc')).toBe(3)
  expect(cells('가나다')).toBe(6)
  expect(cells('#1 개인 mods')).toBe(12)
  expect(tooWide('title', '가'.repeat(TITLE_CELLS / 2))).toBeUndefined()
  expect(tooWide('title', '가'.repeat(TITLE_CELLS / 2 + 1))).toBe(
    `card: title is ${TITLE_CELLS + 2} cells wide; the limit is ${TITLE_CELLS} (a Hangul or CJK character is 2). Write it shorter.`,
  )
  expect(tooWide('next', 'x'.repeat(NEXT_CELLS))).toBeUndefined()
  expect(tooWide('next', '나'.repeat(NEXT_CELLS / 2 + 1))).toContain(`next is ${NEXT_CELLS + 2} cells wide; the limit is ${NEXT_CELLS}`)
  // The spec names both caps.
  const spec = JSON.stringify(TOOLS[0].inputSchema)
  expect(spec).toContain(`at most ${TITLE_CELLS} cells`)
  expect(spec).toContain(`at most ${NEXT_CELLS} cells`)
})

test('an over-long title or next is denied on create and update, naming the field, its width and the limit; nothing is written', async ($, on) => {
  const { files } = stub(on)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, title: LONG_TITLE + ' 정리', next: 'Run the tests' }))).toBe(
    `card: title is ${cells(LONG_TITLE + ' 정리')} cells wide; the limit is ${TITLE_CELLS} (a Hangul or CJK character is 2). Write it shorter.`,
  )
  expect(said(await $.tool.call({ tool: WRITE, title: 'Short', next: LONG_NEXT }))).toContain(
    `card: next is ${cells(LONG_NEXT)} cells wide; the limit is ${NEXT_CELLS}`,
  )
  expect([...files.keys()].filter(p => p.startsWith(`${CARDS}/`))).toEqual([])

  expect(said(await $.tool.call({ tool: WRITE, title: 'Short', next: 'Run the tests' }))).toBe('Created ~/repo/handoff/2026-10-11-short.md')
  const before = files.get(`${CARDS}/2026-10-11-short.md`)
  expect(said(await $.tool.call({ tool: WRITE, slug: 'short', next: LONG_NEXT }))).toContain('card: next is')
  expect(said(await $.tool.call({ tool: WRITE, slug: 'short', title: '가'.repeat(21) }))).toContain('card: title is 42 cells wide')
  expect(files.get(`${CARDS}/2026-10-11-short.md`)).toBe(before)
})

test('a card already wider than the caps still lists, draws, and takes an update that leaves its text alone', async ($, on) => {
  const file = '2026-10-10-long.md'
  const { files } = stub(on, { files: { [`${CARDS}/${file}`]: longCard(file) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: LIST }))).toBe(`[open] ${LONG_TITLE} — ${CARDS}/${file}`)
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(String((await ui.find({ key: `copy-${file}` }))?.props.label)).toMatch(/^#1 개인 mods/)
  // Fields left out, or repeated as the card has them, are not new text: no cap applies.
  expect(said(await $.tool.call({ tool: WRITE, slug: 'long', status: 'hold' }))).toBe(`Updated ~/repo/handoff/${file}`)
  expect(said(await $.tool.call({ tool: WRITE, slug: 'long', title: LONG_TITLE, next: LONG_NEXT, summary: 'x' }))).toBe(
    `Updated ~/repo/handoff/${file}`,
  )
  expect(parseCard(file, files.get(`${CARDS}/${file}`)!)).toMatchObject({ next: LONG_NEXT, status: 'hold', summary: 'x' })
  // New text for that field is held to the cap.
  expect(said(await $.tool.call({ tool: WRITE, slug: 'long', next: `${LONG_NEXT} 추가` }))).toContain('card: next is')
})

test('write → update → list → close: the card on disk and the tool results agree', async ($, on) => {
  const { files, session, runs } = stub(on, { cwd: WORKTREE })
  await $.session.start({ cwd: WORKTREE, surface: 'terminal', isInteractive: true })

  expect(said(await $.tool.call({ tool: WRITE, title: 'Port the band', next: 'Write the tests', body: '## State\nhalf done' }))).toBe(
    'Created ~/repo/handoff/2026-10-11-port-the-band.md',
  )
  const path = `${CARDS}/2026-10-11-port-the-band.md`
  // From a worktree the card lands in the main checkout's handoff/.
  expect(parseCard('2026-10-11-port-the-band.md', files.get(path)!)).toMatchObject({
    status: 'open',
    body: '## State\nhalf done',
  })
  expect(files.get(path)).not.toContain('workspaces')
  // A second card of the same title gets a slug of its own rather than overwriting.
  expect(said(await $.tool.call({ tool: WRITE, title: 'Port the band', next: 'x' }))).toBe(
    'Created ~/repo/handoff/2026-10-11-port-the-band-2.md',
  )

  expect(
    said(
      await $.tool.call({
        tool: WRITE,
        slug: 'port-the-band',
        next: 'Run the tests',
        summary: 'Rule done,\nrows left',
        status: 'hold',
        doc: `${MAIN}/plans/x.md`,
      }),
    ),
  ).toBe('Updated ~/repo/handoff/2026-10-11-port-the-band.md')
  expect(parseCard('f', files.get(path)!)).toMatchObject({
    title: 'Port the band',
    next: 'Run the tests',
    summary: 'Rule done, rows left',
    status: 'hold',
    doc: '~/repo/plans/x.md',
    body: '## State\nhalf done',
  })

  // One line per card: status, title and the absolute path the model can Read, then the doc;
  // no summary, next or age, and never a `~` path.
  const listed = said(await $.tool.call({ tool: LIST }))
  expect(listed).toBe(
    `[open] Port the band — ${CARDS}/2026-10-11-port-the-band-2.md\n` +
      `[hold] Port the band — ${CARDS}/2026-10-11-port-the-band.md (doc: ${MAIN}/plans/x.md)`,
  )
  expect(listed).not.toContain('~')
  // "" clears the summary.
  await $.tool.call({ tool: WRITE, slug: 'port-the-band', summary: '' })
  expect(parseCard('f', files.get(path)!)?.summary).toBeUndefined()

  const before = files.get(path)
  // done moves the card as it is: the other fields of the call are ignored. Its doc was never written.
  expect(said(await $.tool.call({ tool: WRITE, slug: '2026-10-11-port-the-band.md', status: 'done', next: 'ignored' }))).toBe(
    'Closed ~/repo/handoff/2026-10-11-port-the-band.md into ~/repo/handoff/closed/2026-10-11-port-the-band.md\n' +
      'Left its doc ~/repo/plans/x.md in place: not found.',
  )
  expect(files.has(path)).toBe(false)
  expect(files.get(`${CLOSED}/2026-10-11-port-the-band.md`)).toBe(before)
  expect(said(await $.tool.call({ tool: WRITE, slug: 'port-the-band', status: 'done' }))).toMatch(/No handoff card "port-the-band"/)
  await $.tool.call({ tool: WRITE, slug: 'port-the-band-2', status: 'done' })
  // The closed/ folder is not a card, and neither is anything in it.
  expect(said(await $.tool.call({ tool: LIST }))).toBe('No handoff cards for this workspace.')
  // No .gitignore is touched, nothing is removed.
  expect(files.has(`${MAIN}/.gitignore`)).toBe(false)
  expect(onlyMoves(runs)).toBe(true)
  expect(runs.some(argv => argv[0] === 'cmd')).toBe(false)

  // Another repo's cards are never this workspace's.
  files.set(`${OTHER}/handoff/2026-10-01-other.md`, card({ title: 'Other' }))
  expect(said(await $.tool.call({ tool: LIST }))).toBe('No handoff cards for this workspace.')
  // Outside a repo the session's directory is the workspace.
  session.cwd = `${HOME}/elsewhere`
  expect(said(await $.tool.call({ tool: LIST }))).toBe('No handoff cards for this workspace.')
  expect(said(await $.tool.call({ tool: WRITE, title: 't', next: 'n' }))).toBe('Created ~/elsewhere/handoff/2026-10-11-t.md')
  expect(files.has(`${HOME}/elsewhere/handoff/2026-10-11-t.md`)).toBe(true)
})

test('closing creates handoff/closed/ once, when it is missing, and moves the card into it', async ($, on) => {
  const { files, runs } = stub(on, {
    files: { [`${CARDS}/2026-10-01-a.md`]: card({ title: 'A' }), [`${CARDS}/2026-10-02-b.md`]: card({ title: 'B' }) },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: WRITE, slug: 'a', status: 'done' })
  expect(files.has(`${CLOSED}/2026-10-01-a.md`)).toBe(true)
  const mkdirs = () => runs.filter(argv => argv[0] === 'mkdir')
  expect(mkdirs()).toEqual([['mkdir', '-p', CLOSED]])
  expect(runs.filter(argv => argv[0] === 'mv')).toEqual([['mv', '-n', `${CARDS}/2026-10-01-a.md`, `${CLOSED}/2026-10-01-a.md`]])
  await $.tool.call({ tool: WRITE, slug: 'b', status: 'done' })
  expect(files.has(`${CLOSED}/2026-10-02-b.md`)).toBe(true)
  expect(mkdirs()).toHaveLength(1)
})

test('a card or doc whose name is taken in closed/ moves under the next free -2, -3 name; both files are kept', async ($, on) => {
  const withDoc = (title: string, doc: string) => card({ title }).replace('---\n', `---\ndoc: ${doc}\n`)
  const { files } = stub(on, {
    files: {
      [`${CARDS}/2026-10-01-moved.md`]: withDoc('Moved', '~/repo/plans/mine.md'),
      [`${MAIN}/plans/mine.md`]: 'MINE',
      [`${CLOSED}/2026-10-01-moved.md`]: 'OLD CARD',
      [`${CLOSED}/mine.md`]: 'OLD DOC',
      [`${CLOSED}/mine-2.md`]: 'OLDER DOC',
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'moved', status: 'done' }))).toBe(
    'Closed ~/repo/handoff/2026-10-01-moved.md into ~/repo/handoff/closed/2026-10-01-moved-2.md\n' +
      'Moved its doc ~/repo/plans/mine.md to ~/repo/handoff/closed/mine-3.md',
  )
  expect(files.get(`${CLOSED}/2026-10-01-moved.md`)).toBe('OLD CARD')
  expect(parseCard('f', files.get(`${CLOSED}/2026-10-01-moved-2.md`)!)?.title).toBe('Moved')
  expect(files.get(`${CLOSED}/mine.md`)).toBe('OLD DOC')
  expect(files.get(`${CLOSED}/mine-2.md`)).toBe('OLDER DOC')
  expect(files.get(`${CLOSED}/mine-3.md`)).toBe('MINE')
  expect(parseCard('f', files.get(`${CLOSED}/2026-10-01-moved-2.md`)!)?.doc).toBe('~/repo/handoff/closed/mine-3.md')
  expect(files.has(`${MAIN}/plans/mine.md`)).toBe(false)
})

test('freeName keeps the name when free, else numbers the stem before its extension', () => {
  expect(freeName('a.md', new Set())).toBe('a.md')
  expect(freeName('a.md', new Set(['a.md', 'a-2.md']))).toBe('a-3.md')
  expect(freeName('notes', new Set(['notes']))).toBe('notes-2')
  expect(freeName('.env', new Set(['.env']))).toBe('.env-2')
})

test('a move or mkdir that fails leaves the card where it was and says why', async ($, on) => {
  const { files } = stub(on, { fail: 'mv', files: { [`${CARDS}/2026-10-01-a.md`]: card({ title: 'A' }) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'a', status: 'done' }))).toBe(
    `card: left ~/repo/handoff/2026-10-01-a.md in place: move failed: mv: rename ${CARDS}/2026-10-01-a.md: Permission denied`,
  )
  expect(files.get(`${CARDS}/2026-10-01-a.md`)).toBe(card({ title: 'A' }))
  expect([...files.keys()].some(p => p.startsWith(`${CLOSED}/`))).toBe(false)
  // Still open, so still listed.
  expect(said(await $.tool.call({ tool: LIST }))).toBe(`[open] A — ${CARDS}/2026-10-01-a.md`)
})

test('an mv that exits 0 without moving is caught by the check after it', async ($, on) => {
  const { files } = stub(on, { fail: 'skip', files: { [`${CARDS}/2026-10-01-a.md`]: card({ title: 'A' }) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'a', status: 'done' }))).toBe(
    'card: left ~/repo/handoff/2026-10-01-a.md in place: move failed: the file did not arrive',
  )
  expect(files.has(`${CARDS}/2026-10-01-a.md`)).toBe(true)
})

test('a folder that cannot be created leaves the card in place', async ($, on) => {
  const { files, runs } = stub(on, { fail: 'mkdir', files: { [`${CARDS}/2026-10-01-a.md`]: card({ title: 'A' }) } })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'a', status: 'done' }))).toBe(
    `card: left ~/repo/handoff/2026-10-01-a.md in place: could not create the folder: mkdir: ${CLOSED}: Permission denied`,
  )
  expect(files.has(`${CARDS}/2026-10-01-a.md`)).toBe(true)
  expect(runs.some(argv => argv[0] === 'mv')).toBe(false)
})

test('done moves the doc into closed/ only from inside the repo and when no open card still names it', async ($, on) => {
  const withDoc = (title: string, doc: string) => card({ title }).replace('---\n', `---\ndoc: ${doc}\n`)
  const PLAN = `${MAIN}/plans`
  const { files } = stub(on, {
    files: {
      [`${CARDS}/2026-10-01-moved.md`]: withDoc('Moved', '~/repo/plans/mine.md'),
      [`${PLAN}/mine.md`]: 'MINE',
      [`${PLAN}/sibling.md`]: 'SIBLING',
      [`${CARDS}/2026-10-02-outside.md`]: withDoc('Outside', '~/elsewhere/notes.md'),
      [`${HOME}/elsewhere/notes.md`]: 'NOTES',
      [`${CARDS}/2026-10-03-shared-a.md`]: withDoc('Shared A', `${PLAN}/shared.md`),
      [`${CARDS}/2026-10-04-shared-b.md`]: withDoc('Shared B', '~/repo/plans/shared.md'),
      [`${PLAN}/shared.md`]: 'SHARED',
      [`${CARDS}/2026-10-05-gone.md`]: withDoc('Gone', '~/repo/plans/gone.md'),
      [`${CARDS}/2026-10-06-again.md`]: withDoc('Again', '~/repo/handoff/closed/old.md'),
      [`${CLOSED}/old.md`]: 'OLD',
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const close = async (slug: string) => said(await $.tool.call({ tool: WRITE, slug, status: 'done' }))

  // Only the file moves; its folder and siblings stay.
  expect(await close('moved')).toBe(
    'Closed ~/repo/handoff/2026-10-01-moved.md into ~/repo/handoff/closed/2026-10-01-moved.md\n' +
      'Moved its doc ~/repo/plans/mine.md to ~/repo/handoff/closed/mine.md',
  )
  expect(files.has(`${PLAN}/mine.md`)).toBe(false)
  expect(files.get(`${CLOSED}/mine.md`)).toBe('MINE')
  expect(files.get(`${PLAN}/sibling.md`)).toBe('SIBLING')

  expect(await close('outside')).toBe(
    'Closed ~/repo/handoff/2026-10-02-outside.md into ~/repo/handoff/closed/2026-10-02-outside.md\n' +
      'Left its doc ~/elsewhere/notes.md in place: outside this repo.',
  )
  expect(files.get(`${HOME}/elsewhere/notes.md`)).toBe('NOTES')

  // One card names the doc absolute, the other with `~`: the same file, kept for the open one.
  expect(await close('shared-a')).toBe(
    'Closed ~/repo/handoff/2026-10-03-shared-a.md into ~/repo/handoff/closed/2026-10-03-shared-a.md\n' +
      'Left its doc ~/repo/plans/shared.md in place: card 2026-10-04-shared-b.md still names it.',
  )
  expect(files.get(`${PLAN}/shared.md`)).toBe('SHARED')
  // The last card naming it takes it along.
  expect(await close('shared-b')).toMatch(/\nMoved its doc ~\/repo\/plans\/shared\.md to ~\/repo\/handoff\/closed\/shared\.md$/)
  expect(files.get(`${CLOSED}/shared.md`)).toBe('SHARED')

  expect(await close('gone')).toBe(
    'Closed ~/repo/handoff/2026-10-05-gone.md into ~/repo/handoff/closed/2026-10-05-gone.md\n' +
      'Left its doc ~/repo/plans/gone.md in place: not found.',
  )
  expect(await close('again')).toMatch(/\nLeft its doc ~\/repo\/handoff\/closed\/old\.md in place: it is inside handoff\/\.$/)
  expect(files.get(`${CLOSED}/old.md`)).toBe('OLD')
})

test('a doc moves only as a tracked file outside handoff/ that no open card overlaps; anything else stays', async ($, on) => {
  const withDoc = (title: string, doc: string) => card({ title }).replace('---\n', `---\ndoc: ${doc}\n`)
  const PLAN = `${MAIN}/plans`
  const { files, runs } = stub(on, {
    untracked: [`${PLAN}/untracked.md`],
    files: {
      [`${CARDS}/2026-10-01-dots.md`]: withDoc('Dots', '~/repo/plans/../plans/x.md'),
      [`${PLAN}/x.md`]: 'X',
      [`${CARDS}/2026-10-02-card.md`]: withDoc('Card', '~/repo/handoff/2026-10-03-target.md'),
      [`${CARDS}/2026-10-03-target.md`]: card({ title: 'Target' }),
      [`${CARDS}/2026-10-04-untracked.md`]: withDoc('Untracked', '~/repo/plans/untracked.md'),
      [`${PLAN}/untracked.md`]: 'UNTRACKED',
      [`${CARDS}/2026-10-05-inner.md`]: withDoc('Inner', '~/repo/notes/a.md'),
      [`${CARDS}/2026-10-06-outer.md`]: withDoc('Outer', '~/repo/notes'),
      [`${MAIN}/notes/a.md`]: 'A',
      [`${MAIN}/notes/b.md`]: 'B',
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const docLine = async (slug: string) => said(await $.tool.call({ tool: WRITE, slug, status: 'done' })).split('\n')[1]
  expect(await docLine('dots')).toBe('Left its doc ~/repo/plans/../plans/x.md in place: the path has a . or .. segment.')
  // Another card is no doc to retire: anything under handoff/ stays.
  expect(await docLine('card')).toBe('Left its doc ~/repo/handoff/2026-10-03-target.md in place: it is inside handoff/.')
  expect(files.get(`${CARDS}/2026-10-03-target.md`)).toBe(card({ title: 'Target' }))
  expect(await docLine('untracked')).toBe('Left its doc ~/repo/plans/untracked.md in place: git does not track it in this repo.')
  // An open card naming the folder that holds the doc keeps it, as one naming the doc itself would.
  expect(await docLine('inner')).toBe('Left its doc ~/repo/notes/a.md in place: card 2026-10-06-outer.md names ~/repo/notes, which overlaps it.')
  // A folder is never moved, even when no other card names it.
  expect(await docLine('outer')).toBe('Left its doc ~/repo/notes in place: it is a folder.')
  for (const [p, text] of [[`${PLAN}/x.md`, 'X'], [`${PLAN}/untracked.md`, 'UNTRACKED'], [`${MAIN}/notes/a.md`, 'A'], [`${MAIN}/notes/b.md`, 'B']]) {
    expect(files.get(p!)).toBe(text)
  }
  // Only the five cards moved.
  expect(runs.filter(argv => argv[0] === 'mv').map(argv => argv[2])).toEqual(
    ['01-dots', '02-card', '04-untracked', '05-inner', '06-outer'].map(s => `${CARDS}/2026-10-${s}.md`),
  )
})

test('a closed card whose doc moved names the doc’s new path; a doc: line it cannot edit is said, the copy untouched', async ($, on) => {
  const twoDocs = card({ title: 'Two' }).replace('---\n', '---\ndoc: ~/repo/plans/old.md\ndoc: ~/repo/plans/two.md\n')
  const { files } = stub(on, {
    files: {
      [`${CARDS}/2026-10-01-one.md`]: card({ title: 'One' }).replace('---\n', '---\ndoc: ~/repo/plans/one.md\n') + 'Body\n',
      [`${MAIN}/plans/one.md`]: 'ONE',
      [`${CARDS}/2026-10-02-two.md`]: twoDocs,
      [`${MAIN}/plans/two.md`]: 'TWO',
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'one', status: 'done' }))).toBe(
    'Closed ~/repo/handoff/2026-10-01-one.md into ~/repo/handoff/closed/2026-10-01-one.md\n' +
      'Moved its doc ~/repo/plans/one.md to ~/repo/handoff/closed/one.md',
  )
  // Only the doc: line changed.
  expect(files.get(`${CLOSED}/2026-10-01-one.md`)).toBe(card({ title: 'One' }).replace('---\n', '---\ndoc: ~/repo/handoff/closed/one.md\n') + 'Body\n')
  expect(said(await $.tool.call({ tool: WRITE, slug: 'two', status: 'done' }))).toBe(
    'Closed ~/repo/handoff/2026-10-02-two.md into ~/repo/handoff/closed/2026-10-02-two.md\n' +
      'Moved its doc ~/repo/plans/two.md to ~/repo/handoff/closed/two.md\n' +
      'The closed card ~/repo/handoff/closed/2026-10-02-two.md still names its old doc path: its doc: line could not be edited.',
  )
  expect(files.get(`${CLOSED}/2026-10-02-two.md`)).toBe(twoDocs)
  expect(files.get(`${CLOSED}/two.md`)).toBe('TWO')
})

test('a doc whose name differs only in case from one in closed/ takes the next free name; every mkdir and mv run has a timeout', async ($, on) => {
  const { files, limits } = stub(on, {
    files: {
      [`${CARDS}/2026-10-01-a.md`]: card({ title: 'A' }).replace('---\n', '---\ndoc: ~/repo/plans/Plan.md\n'),
      [`${MAIN}/plans/Plan.md`]: 'NEW',
      [`${CLOSED}/plan.md`]: 'OLD',
    },
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'a', status: 'done' }))).toMatch(/\nMoved its doc ~\/repo\/plans\/Plan\.md to ~\/repo\/handoff\/closed\/Plan-2\.md$/)
  expect(files.get(`${CLOSED}/plan.md`)).toBe('OLD')
  expect(files.get(`${CLOSED}/Plan-2.md`)).toBe('NEW')
  expect(freeName('Plan.md', new Set(['plan.md', 'PLAN-2.md']))).toBe('Plan-3.md')
  expect(limits.length).toBeGreaterThan(0)
  expect(limits.every(ms => ms === 5000)).toBe(true)
})

test('create never writes over a file in handoff/: an unreadable one is skipped, named by list, and refused by key', async ($, on) => {
  const BROKEN = `${CARDS}/2026-10-11-port.md`
  const { files } = stub(on, {
    files: { [BROKEN]: 'not a card', [`${CARDS}/2026-10-11-hidden.md`]: card({ title: 'Hidden' }) },
    unlisted: [`${CARDS}/2026-10-11-hidden.md`],
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, title: 'Port', next: 'n' }))).toBe('Created ~/repo/handoff/2026-10-11-port-2.md')
  expect(files.get(BROKEN)).toBe('not a card')
  // `port` names the unreadable file, by slug or by filename: refused, never created over it.
  for (const slug of ['port', '2026-10-11-port.md']) {
    expect(said(await $.tool.call({ tool: WRITE, slug, title: 'Port', next: 'n' }))).toBe(
      'card: ~/repo/handoff/2026-10-11-port.md exists but is not a readable card; fix or rename it.',
    )
  }
  expect(said(await $.tool.call({ tool: WRITE, slug: 'port-2', next: 'm' }))).toBe('Updated ~/repo/handoff/2026-10-11-port-2.md')
  expect(files.get(BROKEN)).toBe('not a card')
  expect(said(await $.tool.call({ tool: LIST }))).toBe(`[open] Port — ${CARDS}/2026-10-11-port-2.md\n[unreadable] ${BROKEN}`)
  // A file the listing missed is still not written over.
  expect(said(await $.tool.call({ tool: WRITE, title: 'Hidden', next: 'n' }))).toBe(
    'card: ~/repo/handoff/2026-10-11-hidden.md already exists; no card written.',
  )
  expect(files.get(`${CARDS}/2026-10-11-hidden.md`)).toBe(card({ title: 'Hidden' }))
})

test('git before 2.31 echoes --path-format: rootOf refuses it and the toplevel stands', async ($, on) => {
  expect(rootOf(`--path-format=absolute\n.git\n${MAIN}\n`)).toBeUndefined()
  expect(rootOf(`.git\n${MAIN}\n`)).toBeUndefined()
  expect(rootOf('C:/r/.git\nC:/r\n')).toBe('C:/r')
  const { files, runs } = stub(on, { cwd: WORKTREE, isGitOld: true })
  await $.session.start({ cwd: WORKTREE, surface: 'terminal', isInteractive: true })
  // The worktree's own toplevel, not a folder named after the echoed flag.
  expect(said(await $.tool.call({ tool: WRITE, title: 'Old', next: 'n' }))).toBe('Created ~/repo/.claude/worktrees/feat/handoff/2026-10-11-old.md')
  expect(files.has(`${WORKTREE}/handoff/2026-10-11-old.md`)).toBe(true)
  expect(runs).toContainEqual(['git', 'rev-parse', '--show-toplevel'])
})

test('a language setting leaves the mod’s own text English; only the card spec asks for that language', { options: { hold_on_exit: true } }, async ($, on) => {
  const { registered } = stub(on, { dirty: 1, language: 'korean', files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  on('command.run', () => ({ text: 'core' }))
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(registered).toEqual([
    { name: '/handoff', description: 'Show or hide the handoff band; open|hold|all sets its filter' },
    { name: 'card', description: toolsFor('korean')[0]!.description },
    { name: 'list', description: TOOLS[1]!.description },
  ])
  expect(registered[1]!.description).toContain('Write title, next, summary and body in korean')
  let ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' 1 day' })).toBeDefined()
  const run = (command: string, args = '') => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: {} as never })
  expect((await run('handoff', 'hold')).text).toBe('Handoff band shows hold cards.')
  ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'No hold cards.' })).toBeDefined()
  expect((await run('exit')).text).toBe(
    '1 uncommitted change is left. If the work goes on later, ask Claude to write a handoff card. To go ahead anyway, enter /exit again.',
  )
})

test('native Windows: USERPROFILE for home, cmd for mkdir and move, the card and doc closed into handoff\\closed', async ($, on) => {
  const cwd = 'C:\\Users\\u\\repo'
  const { files, runs } = stub(on, {
    cwd,
    env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\u' },
    git: { 'C:/Users/u/repo': 'C:/Users/u/repo/.git\nC:/Users/u/repo' },
    files: { '/Users/u/repo/plans/plan.md': 'PLAN' },
  })
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, title: 'Port', next: 'Test it', doc: 'C:\\Users\\u\\repo\\plans\\plan.md' }))).toBe(
    'Created ~/repo/handoff/2026-10-11-port.md',
  )
  expect(files.has('/Users/u/repo/handoff/2026-10-11-port.md')).toBe(true)
  expect(said(await $.tool.call({ tool: LIST }))).toBe(
    '[open] Port — C:/Users/u/repo/handoff/2026-10-11-port.md (doc: C:/Users/u/repo/plans/plan.md)',
  )
  expect(said(await $.tool.call({ tool: WRITE, slug: 'port', status: 'done' }))).toBe(
    'Closed ~/repo/handoff/2026-10-11-port.md into ~/repo/handoff/closed/2026-10-11-port.md\n' +
      'Moved its doc ~/repo/plans/plan.md to ~/repo/handoff/closed/plan.md',
  )
  expect(files.has('/Users/u/repo/handoff/2026-10-11-port.md')).toBe(false)
  expect(files.has('/Users/u/repo/handoff/closed/2026-10-11-port.md')).toBe(true)
  expect(files.has('/Users/u/repo/plans/plan.md')).toBe(false)
  expect(files.get('/Users/u/repo/handoff/closed/plan.md')).toBe('PLAN')
  expect(parseCard('f', files.get('/Users/u/repo/handoff/closed/2026-10-11-port.md')!)?.doc).toBe('~/repo/handoff/closed/plan.md')
  expect(runs.filter(argv => argv[0] === 'cmd').map(argv => argv[3])).toEqual(['mkdir', 'move', 'move'])
  expect(runs.some(argv => argv[0] === 'mv' || argv[0] === 'mkdir')).toBe(false)
})

test('without git the session directory is the workspace: cards in <cwd>/handoff, closed into <cwd>/handoff/closed', { options: { hold_on_exit: true } }, async ($, on) => {
  const PLAIN = `${HOME}/plain`
  const { files } = stub(on, { cwd: PLAIN, isGitMissing: true, dirty: 3, files: { [`${PLAIN}/handoff/2026-10-10-seen.md`]: card({ title: 'Seen' }) } })
  on('command.run', () => ({ text: 'core' }))
  await $.session.start({ cwd: PLAIN, surface: 'terminal', isInteractive: true })
  // No git, so no uncommitted changes to count: /clear is never held.
  expect((await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' }, presentation: {} as never })).text).toBe('core')
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '#1 Seen — next of Seen' })).toBeDefined()

  expect(said(await $.tool.call({ tool: WRITE, title: 'No git', next: 'n' }))).toBe('Created ~/plain/handoff/2026-10-11-no-git.md')
  expect(said(await $.tool.call({ tool: LIST }))).toBe(
    `[open] No git — ${PLAIN}/handoff/2026-10-11-no-git.md\n[open] Seen — ${PLAIN}/handoff/2026-10-10-seen.md`,
  )
  expect(said(await $.tool.call({ tool: WRITE, slug: 'no-git', status: 'done' }))).toBe(
    'Closed ~/plain/handoff/2026-10-11-no-git.md into ~/plain/handoff/closed/2026-10-11-no-git.md',
  )
  expect(files.has(`${PLAIN}/handoff/closed/2026-10-11-no-git.md`)).toBe(true)
  // Nothing vouches for a doc without git: it stays.
  files.set(`${PLAIN}/notes.md`, 'NOTES')
  await $.tool.call({ tool: WRITE, title: 'With doc', next: 'n', doc: '~/plain/notes.md' })
  expect(said(await $.tool.call({ tool: WRITE, slug: 'with-doc', status: 'done' }))).toBe(
    'Closed ~/plain/handoff/2026-10-11-with-doc.md into ~/plain/handoff/closed/2026-10-11-with-doc.md\n' +
      'Left its doc ~/plain/notes.md in place: no git repo here to confirm it is tracked.',
  )
  expect(files.get(`${PLAIN}/notes.md`)).toBe('NOTES')
})

test('bad input is denied with the reason, and nothing is written', async ($, on) => {
  const { files } = stub(on)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  expect(said(await $.tool.call({ tool: WRITE, title: 'Only a title' }))).toMatch(/needs a title and next/)
  expect(said(await $.tool.call({ tool: WRITE, title: 't', next: 'n', status: 'done' }))).toMatch(/status done needs slug/)
  expect(said(await $.tool.call({ tool: WRITE, title: 't', next: 'n', status: 'on-hold' }))).toMatch(/use open, hold or done/)
  expect(said(await $.tool.call({ tool: WRITE, title: 't', next: 'n', doc: 'relative/x.md' }))).toMatch(/doc must be/)
  expect(said(await $.tool.call({ tool: WRITE, title: 't', next: 'n', slug: 'Bad Slug' }))).toMatch(/is no slug/)
  expect(said(await $.tool.call({ tool: WRITE, slug: 'missing', next: 'n' }))).toMatch(/No card "missing" to update/)
  expect(said(await $.tool.call({ tool: WRITE, status: 'done' }))).toMatch(/status done needs slug/)
  expect(files.size).toBe(0)
})

// ---- the model's pointer ----

test('the first user prompt carries pointers only — no next, STALE past 14 days — once per session', async ($, on) => {
  stub(on, {
    files: {
      [`${CARDS}/2026-09-26-old.md`]: card({ title: 'Old work', next: 'SECRET-NEXT-STEP' }),
      [`${CARDS}/2026-10-10-new.md`]: `${card({ title: 'New work', next: 'ANOTHER-NEXT' })}BODY-TEXT\n`,
    },
  })
  const seen: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', ($, e) => {
    seen.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: '<task-notification>x</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(seen.at(-1)?.context).toBeUndefined()

  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(seen.at(-1)?.text).toBe('hello')
  const line = seen.at(-1)?.context?.[0] ?? ''
  expect(line).toBe(
    'Handoff cards exist for this workspace (pointers only — do not read or act on them unless the user asks to resume that work): ' +
      '~/repo/handoff/2026-10-10-new.md "New work" [open, updated 1d ago]; ' +
      '~/repo/handoff/2026-09-26-old.md "Old work" [open, updated 15d ago, STALE — verify current state before acting]',
  )
  expect(line).not.toMatch(/SECRET-NEXT-STEP|ANOTHER-NEXT|BODY-TEXT/)

  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  expect(seen.at(-1)?.context).toBeUndefined()

  // A /clear starts a new conversation, which gets the pointer once more.
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: {} as never })
  await $.prompt.submit({ text: 'fresh', wait: false, origin: { kind: 'composer' } })
  expect(seen.at(-1)?.context?.[0]).toMatch(/^Handoff cards exist/)
})

// ---- the hold on /clear and /exit ----

test('with hold_on_exit off (the default) /clear and /exit go straight through, uncommitted changes or not', async ($, on) => {
  stub(on, { dirty: 2 })
  let ran = 0
  on('command.run', () => {
    ran++
    return { text: 'core' }
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: {} as never })
  expect((await run('clear')).text).toBe('core')
  expect((await run('exit')).text).toBe('core')
  expect(ran).toBe(2)
})

test('with hold_on_exit on, /clear with uncommitted changes and no card is held once, then goes through', { options: { hold_on_exit: true } }, async ($, on) => {
  stub(on, { dirty: 2 })
  let ran = 0
  on('command.run', () => {
    ran++
    return { text: 'core' }
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: {} as never })
  const held = await run('clear')
  expect(held.text).toBe(
    '2 uncommitted changes are left. If the work goes on later, ask Claude to write a handoff card. To go ahead anyway, enter /clear again.',
  )
  expect(ran).toBe(0)
  expect((await run('clear')).text).toBe('core')
  expect(ran).toBe(1)
})

test('with hold_on_exit on, a clean tree or a session that wrote a card is not held', { options: { hold_on_exit: true } }, async ($, on) => {
  const { session } = stub(on, { dirty: 2, git: { [`${HOME}/clean`]: `${HOME}/clean/.git\n${HOME}/clean` } })
  on('command.run', () => ({ text: 'core' }))
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: {} as never })
  await $.tool.call({ tool: WRITE, title: 'Left', next: 'do it' })
  expect((await run('exit')).text).toBe('core')
  // A new session in a repo with no uncommitted changes.
  session.id = 'sid-2'
  session.cwd = `${HOME}/clean`
  expect((await run('clear')).text).toBe('core')
})

test('the model-facing specs stay small, language suffix included, and name no workflow', () => {
  const spec = toolsFor('korean').map(t => t.description + JSON.stringify(t.inputSchema)).join('')
  expect(spec.length).toBeLessThan(1800)
  // Character classes keep this guard out of a plain-text grep for the same words.
  expect(spec).not.toMatch(/worktree|ff[-]only|_unuse[d]|docs\/handoff/)
})

test('card and list results read one card per line, mark first, as the call left them; the model keeps its text', async ($, on) => {
  stub(on, { files: { [`${CARDS}/2026-10-10-a.md`]: card({ title: 'Fresh' }) } })
  const seen: unknown[] = []
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    seen.push(e.props.output)
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  const result = async (tool: string, id: string, output: unknown, isErrored = false) => {
    const props = { tool_use_id: id, tool, output, isErrored }
    const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', component: 'ToolResult', requestId: id, props } as never)
    await ui.unmount()
    return seen[seen.length - 1]
  }
  const made = await $.tool.call({ tool: WRITE, tool_use_id: 'w1', title: '새 카드', next: '다음 단계', status: 'hold' } as never)
  expect(said(made)).toBe('Created ~/repo/handoff/2026-10-11-handoff.md')
  expect(await result(WRITE, 'w1', 'Created …')).toBe('◌ 새 카드 (new)\n→ 다음 단계')
  // The shape the output came in is kept.
  expect(await result(WRITE, 'w1', [{ type: 'text', text: 'x' }])).toEqual([{ type: 'text', text: '◌ 새 카드 (new)\n→ 다음 단계' }])
  await $.tool.call({ tool: WRITE, tool_use_id: 'w2', slug: 'a', next: 'Go on', status: 'open' } as never)
  expect(await result(WRITE, 'w2', 'Updated …')).toBe('● Fresh (updated)\n→ Go on')
  await $.tool.call({ tool: LIST, tool_use_id: 'l1' } as never)
  expect(await result(LIST, 'l1', '[open] …')).toBe('● Fresh\n◌ 새 카드')
  await $.tool.call({ tool: WRITE, tool_use_id: 'w3', slug: 'a', status: 'done' } as never)
  expect(await result(WRITE, 'w3', 'Closed …')).toBe('✓ Fresh (closed)')
  // A later edit does not change what an earlier call showed.
  expect(await result(WRITE, 'w2', 'Updated …')).toBe('● Fresh (updated)\n→ Go on')
  // Errored, another tool, or a call with no lines kept: drawn as it came.
  expect(await result(WRITE, 'w1', 'boom', true)).toBe('boom')
  expect(await result('Bash', 'w1', 'ls')).toBe('ls')
  expect(await result(WRITE, 'unknown', 'as is')).toBe('as is')
})
