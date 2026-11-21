import { atom, read, update } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { HandoffCard, HandoffFilter, HandoffView } from '../types'
import { asFilter, bandTree } from './band'
import {
  asStatus,
  cardPath,
  cardText,
  CLOSED_DIR,
  contextText,
  docPlan,
  DIR,
  expandHome,
  findCard,
  freeName,
  freshFile,
  isAbsolute,
  isNoProject,
  isSlug,
  listText,
  oneLine,
  parseCard,
  rootOf,
  slugify,
  slugOf,
  str,
  tildify,
  today,
  toolsFor,
  tooWide,
  withDocLine,
} from './cards'
import { isWindowsPath, mkdirArgv, moveArgv, slashed } from './platform'
import { t } from './strings'
import { cardLines, closedLines, listLines, withText } from './toolrow'

// Work left for a later session is a card in the workspace's handoff/ folder: a local note,
// not committed by default. The mod never edits .gitignore or .git; creating a card in a
// folder git does not ignore says so instead. This mod shows the cards in the band, points
// the model at them once per session, and serves the tools that write, close and list them.
// Closing moves a card (and its doc) into handoff/closed/; nothing is ever deleted. The pure
// half is ./cards and ./band; everything that touches `$` stays in this file.

type Options = { hold_on_exit?: boolean }

// Here rather than in ./cards: a matcher's literal is read off this file's source.
const CARD = 'mcp__handoff__card'
const LIST = 'mcp__handoff__list'

const EMPTY: HandoffView = { root: null, cwd: '', cards: [] }

const view = atom({ plugin: 'handoff', key: 'view' } as const, EMPTY, { shape: 'v2' })
const isHidden = atom({ plugin: 'handoff', key: 'isHidden' } as const, false)
const isFolded = atom({ plugin: 'handoff', key: 'isFolded' } as const, false)
const isExpanded = atom({ plugin: 'handoff', key: 'isExpanded' } as const, false)
const offset = atom({ plugin: 'handoff', key: 'offset' } as const, 0)
const filter = atom({ plugin: 'handoff', key: 'filter' } as const, 'all' as HandoffFilter)
const announcedFor = atom({ plugin: 'handoff', key: 'announcedFor' } as const, null)
const touchedFor = atom({ plugin: 'handoff', key: 'touchedFor' } as const, null)
const warnedFor = atom({ plugin: 'handoff', key: 'warnedFor' } as const, null)
// Each card and list call's result lines, by tool_use_id, as the call left them: a redraw after
// later edits shows what that call did. The newest ROWS_KEPT calls; a session that lost them
// draws the engine's own.
const toolRows = atom({ plugin: 'handoff', key: 'toolRows' } as const, {}, { shape: 'v1' })
const ROWS_KEPT = 200

// Uncommitted changes in the workspace: zero without git or outside a repo. The repo's own
// card folder is left out (`:/` is the whole repo from any subfolder), so cards never count.
const dirtyCount = async ($: EngineInterface) => {
  const cwd = slashed(await $.session.cwd())
  const argv = ['git', '--no-optional-locks', 'status', '--porcelain', '--', ':/', `:(top,exclude)${DIR}/`]
  const git = await $.process.run(argv, { cwd }).catch(() => undefined)
  return git?.exitCode === 0 ? git.stdout.split('\n').filter(l => l.trim() !== '').length : 0
}

// The person's own prompts; a notification, a peer or a schedule is not where a session starts.
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const ignore = () => undefined

const remember = ($: EngineInterface, id: string | undefined, lines: string[]) =>
  id === undefined
    ? undefined
    : update($, toolRows, all => Object.fromEntries(Object.entries({ ...all, [id]: lines }).slice(-ROWS_KEPT))).catch(ignore)

// Windows has no HOME by default: USERPROFILE stands in.
const homeOf = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home === undefined || home === '' ? undefined : slashed(home)
}

// The card folder as the model and the person read it: `~`-prefixed under home.
const shownDir = (root: string, home: string | undefined) => {
  const dir = `${root}/${DIR}`
  return home === undefined ? dir : tildify(dir, home)
}

// The card folder in a tool result: absolute, as `list` gives it, so the model can Read it as given.
const absDir = (root: string) => slashed(`${root}/${DIR}`)

// A folder (handoff/closed/) is skipped: only the open cards are listed. `names` is every
// entry in handoff/, folders and unreadable files included, so a new card never takes one;
// `unreadable` is each `.md` file that does not read as a card, so `list` can name it.
const loadAll = async ($: EngineInterface, root: string) => {
  const dir = `${root}/${DIR}`
  const cards: HandoffCard[] = []
  const names: string[] = []
  const unreadable: string[] = []
  for (const en of await $.fs.list(dir).catch(() => [])) {
    names.push(en.name)
    if (en.kind === 'dir' || !en.name.endsWith('.md')) continue
    const text = await $.fs.read(`${dir}/${en.name}`).catch(() => undefined)
    const card = text === undefined ? undefined : parseCard(en.name, String(text))
    if (card !== undefined) cards.push({ ...card, mtimeMs: en.mtimeMs })
    else unreadable.push(en.name)
  }
  return { cards, names, unreadable }
}

// cmd's `move /-y` prompts on a collision, and a queued card call waits on the one before it
// (see `serially`): no run outlives this.
const RUN_LIMIT = { timeoutMs: 5000 }

// The workspace is the repo's main checkout, so a git worktree of it reads
// and writes the cards of the checkout it came from, unpushed ones included. Git before
// 2.31 has no --path-format: its toplevel stands, a worktree's own. Without git, or outside
// a repo, the session's directory is the workspace. `isGit`: git resolved the root.
// `isTimedOut`: a git run failed only after RUN_LIMIT, so whether this is a repo is unknown
// and the session's directory may be the wrong workspace; a clock that fails never sets it.
const where = async ($: EngineInterface, cwd?: string) => {
  const at = slashed(cwd ?? (await $.session.cwd()))
  let isTimedOut = false
  const git = async (args: string[]) => {
    const t0 = await $.clock.now().catch(() => undefined)
    const r = await $.process.run(['git', '--no-optional-locks', ...args], { cwd: at, ...RUN_LIMIT }).catch(() => undefined)
    if (r?.exitCode !== 0 && t0 !== undefined) {
      const t1 = await $.clock.now().catch(() => t0)
      if (t1 - t0 >= RUN_LIMIT.timeoutMs) isTimedOut = true
    }
    return r
  }
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
  let root = r?.exitCode === 0 ? rootOf(r.stdout) : undefined
  if (r?.exitCode === 0 && root === undefined) {
    const top = await git(['rev-parse', '--show-toplevel'])
    const line = top?.exitCode === 0 ? top.stdout.trim() : ''
    root = line.split('\n').length === 1 && isAbsolute(line) ? line : undefined
  }
  return { root: root ?? at, cwd: at, isGit: root !== undefined, isTimedOut }
}

const GIT_SLOW = `card: git did not answer within ${RUN_LIMIT.timeoutMs / 1000} s; no card written. Call it again.`

// Only the newest refresh writes the view: an unawaited one (turn.complete) that ends after a
// later one would put older cards back. Each caller still gets the cards it read.
const refresh = async ($: EngineInterface, cwd?: string) => {
  const seq = ++refreshSeq
  const at = await where($, cwd)
  const { cards, unreadable } = await loadAll($, at.root)
  const fresh = { root: at.root, cwd: at.cwd, cards }
  const v = seq === refreshSeq ? await update($, view, () => fresh) : fresh
  return { ...v, unreadable }
}

// The band's own load of a view never loaded, while it runs.
let loading: Promise<unknown> | undefined
let refreshSeq = 0

const failed = () => ({ deny: 'handoff: the tool failed; no card changed.' })

// A session that wrote or closed a card has handled its handoff: no hold on /clear or /exit.
const markTouched = async ($: EngineInterface) => {
  const sid = await $.session.id().catch(() => undefined)
  if (sid !== undefined) await update($, touchedFor, () => sid).catch(ignore)
}

const runFailure = (r: CommandRunResult | undefined) =>
  r === undefined ? 'could not run' : (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.exitCode}`

const exists = ($: EngineInterface, path: string) => $.fs.exists(path).catch(() => false)

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'

const UNSAFE_FOR_CMD = 'the path holds a character cmd would run as a command'

// Moves one file into `dir`, creating the folder when missing, under a name no file there
// has yet. Never replaces or deletes anything: on any failure the file stays where it was.
// `$.fs` has no mkdir or rename, so both are OS commands (mkdir and mv, or cmd's on Windows).
const moveInto = async ($: EngineInterface, from: string, dir: string): Promise<{ to: string } | { left: string }> => {
  if (!(await exists($, dir))) {
    const argv = mkdirArgv(dir)
    if (argv === undefined) return { left: UNSAFE_FOR_CMD }
    const made = await $.process.run(argv, RUN_LIMIT).catch(() => undefined)
    if (!(await exists($, dir))) return { left: `could not create the folder: ${runFailure(made)}` }
  }
  const taken = new Set((await $.fs.list(dir).catch(() => [])).map(en => en.name))
  const to = `${dir}/${freeName(baseName(from), taken)}`
  const argv = moveArgv(from, to)
  if (argv === undefined) return { left: UNSAFE_FOR_CMD }
  const mv = await $.process.run(argv, RUN_LIMIT).catch(() => undefined)
  if (mv?.exitCode === 0 && (await exists($, to)) && !(await exists($, from))) return { to }
  // mv -n exits 0 when it skips a file that appeared at `to` meanwhile.
  return { left: `move failed: ${mv?.exitCode === 0 ? 'the file did not arrive' : runFailure(mv)}` }
}

// The closed card's doc, per docPlan, then the checks that need `$`: a file rather than a
// folder, and one git tracks in this repo (which also refuses a path through a symlinked
// folder); without git nothing vouches for it, so it stays. One line for the result, or none
// when the card has no doc. The card has already moved to `closedAt`, so a failure here is
// reported, never a deny. Once the doc has moved, the closed copy's `doc:` line names its
// new path: an edit of that copy, the only write closing makes.
const retireDoc = async (
  $: EngineInterface,
  at: { root: string; isGit: boolean },
  home: string | undefined,
  card: HandoffCard,
  all: readonly HandoffCard[],
  closedAt: string,
) => {
  const { root } = at
  const plan = docPlan(card, all, root, home)
  if (plan === undefined) return undefined
  const shown = (p: string) => (home === undefined ? p : tildify(p, home))
  const left = (why: string) => `Left its doc ${shown(plan.from)} in place: ${why}.`
  if (plan.left !== undefined) return left(plan.left)
  if (!(await exists($, plan.from))) return left('not found')
  const entry = (await $.fs.list(parentOf(plan.from)).catch(() => undefined))?.find(en => en.name === baseName(plan.from))
  if (entry === undefined) return left('its folder could not be listed')
  if (entry.kind === 'dir') return left('it is a folder')
  if (!at.isGit) return left('no git repo here to confirm it is tracked')
  const tracked = await $.process.run(['git', '--no-optional-locks', 'ls-files', '--error-unmatch', '--', plan.from], { cwd: root, ...RUN_LIMIT }).catch(() => undefined)
  if (tracked?.exitCode !== 0) return left('git does not track it in this repo')
  const moved = await moveInto($, plan.from, `${root}/${CLOSED_DIR}`)
  if ('left' in moved) return left(moved.left)
  const line = `Moved its doc ${shown(plan.from)} to ${shown(moved.to)}`
  const text = await $.fs.read(closedAt).catch(() => undefined)
  const edited = text === undefined ? undefined : withDocLine(String(text), shown(moved.to))
  const isWritten = edited !== undefined && (await $.fs.write(closedAt, edited).then(() => true, () => false))
  return isWritten ? line : `${line}\nThe closed card ${shown(closedAt)} still names its old doc path: its doc: line could not be edited.`
}

// A mod tool is answered ahead of the permission check and does not prompt, so `card` asks
// for the verdict itself: a `deny` from the rules or a tool.check hook refuses a write; an
// `ask` verdict proceeds. Fails open: a check the engine cannot answer refuses nothing.
const refusal = async ($: EngineInterface, input: Record<string, unknown>) => {
  const verdict = await $.tool.check({ tool: CARD, input }).catch(() => undefined)
  if (verdict?.decision !== 'deny') return undefined
  return `card: a permission rule or hook denies this tool${verdict.reason ? ` (${verdict.reason})` : ''}; no card changed.`
}

// Card calls run one at a time: a script's concurrent calls would otherwise list the folder
// together and pick, then write, the same new file. A queued call's wait counts against its
// hook's time limit, so the body checks what is left before it starts.
const HOOK_LIMIT_MS = 10_000
const QUEUE_MARGIN_MS = 1000
const QUEUED = 'card: earlier card calls took too long, so this one did not run; no card changed. Call it again.'
// The tool_use_ids whose body has begun: a call the engine timed out before its body began
// is answered QUEUED, one that began (or carries no id) the generic `failed`, since it may
// already have written.
const begun = new Set<string>()
// Card paths whose write has not settled: a call the bound let past a stuck write must not
// write the same file, which the late write would then replace.
const writing = new Set<string>()
// A later call waits on a run for at most a hook's limit, so one `$.fs` call that never
// settles cannot hold every later call; a non-interactive session starts no timer.
let isInteractive = true
let cardQueue: Promise<unknown> = Promise.resolve()
// The bound starts when a call's turn comes, so a slow call that is not stuck keeps the queue
// for its full limit and never overlaps the next one.
// `late()` turns true once the bound let the queue past this run: a run that resumes after it
// must not write, since a later call may already have written the same card.
const serially = <T,>($: EngineInterface, run: (late: () => boolean) => Promise<T>): Promise<T> => {
  let timer: { cancel: () => void } | undefined
  let isLate = false
  let release: () => void = ignore
  const stalled = new Promise<void>(resolve => (release = () => { isLate = true; resolve() }))
  const turn = cardQueue.then(() => {
    if (isInteractive) {
      try {
        timer = $.clock.after(HOOK_LIMIT_MS, release)
      } catch {
        // No clock: the queue waits on the run alone.
      }
    }
    return run(() => isLate)
  })
  const settled = turn.then(
    () => timer?.cancel(),
    () => timer?.cancel(),
  )
  cardQueue = Promise.race([settled, stalled]).catch(ignore)
  return turn
}

// The line a folder's first card gains when git would list the card folder as untracked:
// said once, and never for a repo whose cards are already there (tracked or not).
const unignoredNote = async ($: EngineInterface, root: string, path: string, dir: string) => {
  const r = await $.process
    .run(['git', '--no-optional-locks', 'check-ignore', '-q', '--', path], { cwd: root, ...RUN_LIMIT })
    .catch(() => undefined)
  return r?.exitCode === 1
    ? `${dir}/ is not git-ignored, so git status lists the cards. Tell the user they can add /${DIR}/ to .gitignore or .git/info/exclude to keep them local; do not edit either file unless asked.`
    : undefined
}

// card with `status: done`: the card moves into handoff/closed/, and its doc beside it when
// retireDoc allows.
const retire = async ($: EngineInterface, slug: unknown, toolUseId: string | undefined, isLate: () => boolean = () => false) => {
  const key = str(slug)
  if (key === undefined) return { deny: 'card: status done needs slug, the card to close.' }
  const home = await homeOf($)
  const shown = (p: string) => (home === undefined ? p : tildify(p, home))
  const at = await where($)
  if (at.isTimedOut) return { deny: GIT_SLOW }
  const { root } = at
  const { cards: all } = await loadAll($, root)
  const card = findCard(all, key)
  if (card === undefined) return { deny: `No handoff card "${key}" in ${shownDir(root, home)}/.` }
  const from = `${root}/${DIR}/${card.file}`
  // A write to this card still pending would land after the move and bring it back open.
  if (isLate() || writing.has(from)) return { deny: QUEUED }
  const moved = await moveInto($, from, `${root}/${CLOSED_DIR}`)
  if ('left' in moved) return { deny: `card: left ${shown(from)} in place: ${moved.left}` }
  const docLine = await retireDoc($, at, home, card, all, moved.to).catch(() => 'Left its doc in place: the move could not run.')
  await refresh($).catch(ignore)
  await markTouched($)
  await remember($, toolUseId, closedLines(card.title, t.rowClosed))
  const closed = `Closed ${cardPath(absDir(root), card)} into ${slashed(moved.to)}`
  return { result: docLine === undefined ? closed : `${closed}\n${docLine}` }
}

// /clear and /exit end the conversation: with `hold_on_exit` on, uncommitted changes and no
// card written or closed this session hold the command once; the same command again goes through.
const holdIfLeft = async ($: EngineInterface, e: CommandRunInput, next: (e: CommandRunInput) => Promise<CommandRunResult>) => {
  if (!USER_ORIGINS.has(e.origin.kind)) return next(e)
  const sid = await $.session.id().catch(() => undefined)
  if (sid === undefined || (await read($, touchedFor)) === sid || (await read($, warnedFor)) === sid) return next(e)
  const dirty = await dirtyCount($).catch(() => 0)
  if (dirty === 0) return next(e)
  await update($, warnedFor, () => sid)
  return { text: t.leftover(dirty, `/${e.command}`) }
}

// A new filter or a fold starts the expanded window back at the top.
const setFilter = async ($: EngineInterface, f: HandoffFilter) => {
  await update($, offset, () => 0)
  return update($, filter, () => f)
}

const toggleExpand = async ($: EngineInterface) => {
  await update($, offset, () => 0)
  return update($, isExpanded, v => !v)
}

const isPath = (s: string) => s === '~' || s.startsWith('~/') || s.startsWith('/') || isWindowsPath(s)

export const register: Register = (on, options) => {
  const holdOnExit = (options as Options | undefined)?.hold_on_exit === true

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive !== false
    const { language } = await $.settings.read().catch(() => ({ language: undefined }))
    await $.command.register({ name: 'handoff', description: t.commandDescription }).catch(ignore)
    for (const tool of toolsFor(language)) await $.tool.register(tool).catch(ignore)
    const started = await next(e)
    await refresh($, e.cwd).catch(ignore)
    return started
  })

  // EnterWorktree, ExitWorktree and a `cd` the session follows all land here.
  on('classic.CwdChanged', async ($, e, next) => {
    const done = await next(e)
    await refresh($, e.new_cwd).catch(ignore)
    return done
  }).catch(($, e, next) => next(e))

  // Another session may have written or closed a card meanwhile. Left running after the
  // turn ends: its git probe never holds the turn, and its view write redraws the band.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void refresh($).catch(ignore)
    return done
  })

  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (e.reason === 'clear') await update($, announcedFor, () => null)
    return done
  })

  // Once per session, on its first prompt: where the cards are, never what they say,
  // since a card may be stale. The prompt's text is left as typed.
  on('prompt.submit', async ($, e, next) => {
    if (!USER_ORIGINS.has(e.origin.kind)) return next(e)
    const sid = await $.session.id().catch(() => undefined)
    if (sid === undefined || (await read($, announcedFor)) === sid) return next(e)
    await update($, announcedFor, () => sid)
    const { root, cards } = await refresh($)
    const line = root === null ? undefined : contextText(shownDir(root, await homeOf($)), cards, await $.clock.now())
    return next(line === undefined ? e : { ...e, context: [...(e.context ?? []), line] })
  }).catch(($, e, next) => next(e))

  if (holdOnExit) {
    on('command.run', { command: 'clear' }, holdIfLeft).catch(($, e, next) => next(e))
    on('command.run', { command: 'exit' }, holdIfLeft).catch(($, e, next) => next(e))
  }

  // `/handoff` hides or shows the whole band; `/handoff open|hold|all` sets the filter and shows it.
  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg !== '') {
      const f = asFilter(arg)
      if (f === undefined) return { text: t.unknownFilter(arg) }
      await setFilter($, f)
      await update($, isHidden, () => false)
      return { text: t.bandFilter(f) }
    }
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? t.bandHidden : t.bandShown }
  })

  // ---- the tools ----

  on('tool.call', { tool: CARD }, async ($, e, next) => {
    const startedAt = await $.clock.now().catch(() => undefined)
    return serially($, async late => {
      // Timed out (or about to) while queued: the engine answers such a call with `failed`, so
      // nothing may be written now. The clock check also covers an engine with no budget.
      const waited = startedAt === undefined ? 0 : (await $.clock.now()) - startedAt
      const limit = (next?.budget?.ms ?? HOOK_LIMIT_MS) - QUEUE_MARGIN_MS
      if (next?.signal?.aborted === true || (next?.budget?.remainingMs ?? 1) <= 0 || waited >= limit) {
        return { deny: QUEUED }
      }
      if (e.tool_use_id !== undefined) begun.add(e.tool_use_id)
      const FIELDS = ['title', 'next', 'summary', 'status', 'body', 'doc', 'slug'] as const
      for (const k of FIELDS) {
        if (e[k] !== undefined && typeof e[k] !== 'string') return { deny: `card: ${k} must be a string.` }
      }
      const refused = await refusal($, Object.fromEntries(FIELDS.filter(k => e[k] !== undefined).map(k => [k, e[k]])))
      if (refused !== undefined) return { deny: refused }
      if (e.status === 'done') return retire($, e.slug, e.tool_use_id, () => late() || next?.signal?.aborted === true)
      if (e.status !== undefined && asStatus(e.status) === undefined) {
        return { deny: `Unknown status "${String(e.status)}": use open, hold or done.` }
      }
      if (typeof e.doc === 'string' && e.doc.trim() !== '' && !isPath(e.doc.trim())) {
        return { deny: 'card: doc must be a ~-prefixed (or absolute) path.' }
      }
      const home = await homeOf($)
      if (home === undefined) return { deny: 'handoff: HOME/USERPROFILE is unset; no card written.' }
      const { root, isGit, isTimedOut } = await where($)
      if (isTimedOut) return { deny: GIT_SLOW }
      const doc = typeof e.doc === 'string' ? (e.doc.trim() === '' ? null : tildify(expandHome(e.doc.trim(), home), home)) : undefined
      const body = typeof e.body === 'string' ? e.body.trim() : undefined
      const summary = typeof e.summary === 'string' ? oneLine(e.summary) : undefined
      const { cards: all, names, unreadable } = await loadAll($, root)
      const key = str(e.slug)
      const date = today(await $.clock.now())
      const found = key === undefined ? undefined : findCard(all, key)
      // Only new text is held to the caps: an update that leaves a field out, or repeats what
      // the card already says, never fails on a card written before them.
      for (const k of ['title', 'next'] as const) {
        const v = str(e[k])
        const why = v === undefined || v === found?.[k] ? undefined : tooWide(k, v)
        if (why !== undefined) return { deny: why }
      }
      let card: HandoffCard
      if (found !== undefined) {
        const { doc: oldDoc, summary: oldSummary, ...rest } = found
        const keptDoc = doc === undefined ? oldDoc : (doc ?? undefined)
        const keptSummary = summary === undefined ? oldSummary : summary || undefined
        card = {
          ...rest,
          title: str(e.title) ?? found.title,
          next: str(e.next) ?? found.next,
          status: asStatus(e.status) ?? found.status,
          ...(keptSummary !== undefined ? { summary: keptSummary } : {}),
          ...(keptDoc !== undefined ? { doc: keptDoc } : {}),
          body: body ?? found.body,
        }
      } else {
        if (!isGit && isNoProject(root, home)) {
          return { deny: `card: ${tildify(root, home)} is the home folder or a filesystem root, not a project; start the session in a project folder to write a card.` }
        }
        const title = str(e.title)
        const nextStep = str(e.next)
        if (title === undefined || nextStep === undefined) {
          const none = key !== undefined ? `No card "${key}" to update; ` : ''
          return { deny: `${none}card needs a title and next to create a card.` }
        }
        if (key !== undefined && !isSlug(slugOf(key))) {
          return { deny: `card: "${key}" is no slug (lowercase letters, digits and dashes).` }
        }
        const file = key !== undefined ? `${date}-${slugOf(key)}.md` : freshFile(date, slugify(title), all, names)
        if (key !== undefined) {
          // The file the key names, or would name, is there but no card reads from it: never written over.
          const low = (s: string) => s.toLowerCase()
          const broken = unreadable.find(n => [low(key), low(`${key}.md`), low(file)].includes(low(n)) || slugOf(n) === slugOf(key))
          if (broken !== undefined) {
            return { deny: `card: ${shownDir(root, home)}/${broken} exists but is not a readable card; fix or rename it.` }
          }
          if (names.some(n => low(n) === low(file))) {
            return { deny: `card: ${shownDir(root, home)}/${file} already exists; update it by its own slug.` }
          }
        }
        card = {
          file,
          title,
          status: asStatus(e.status) ?? 'open',
          next: nextStep,
          ...(summary ? { summary } : {}),
          ...(doc !== undefined && doc !== null ? { doc } : {}),
          body: body ?? '',
        }
      }
      // Written in place: `$.fs.write` creates the folder, and a card is small. A new card never
      // replaces a file the listing missed (written meanwhile, or a listing that failed).
      const path = `${root}/${DIR}/${card.file}`
      if (found === undefined && (await exists($, path))) {
        return { deny: `card: ${cardPath(shownDir(root, home), card)} already exists; no card written.` }
      }
      // Checked and claimed in one synchronous step: no await between the check and the add.
      if (late() || next?.signal?.aborted === true || writing.has(path)) return { deny: QUEUED }
      writing.add(path)
      try {
        await $.fs.write(path, cardText(card))
      } finally {
        writing.delete(path)
      }
      const note = found === undefined && isGit && names.length === 0 ? await unignoredNote($, root, path, shownDir(root, home)) : undefined
      await refresh($).catch(ignore)
      await markTouched($)
      await remember($, e.tool_use_id, cardLines(card, found !== undefined ? t.rowUpdated : t.rowCreated))
      // A slug another card shares would reach whichever card lists first: name this one by its file.
      const slug = slugOf(card.file)
      const handle = all.some(c => c.file !== card.file && slugOf(c.file) === slug) ? card.file.replace(/\.md$/, '') : slug
      const done = `${found !== undefined ? 'Updated' : 'Created'} ${cardPath(absDir(root), card)}\nslug: ${handle}`
      return { result: note === undefined ? done : `${done}\n${note}` }
    }).finally(() => {
      if (e.tool_use_id !== undefined) begun.delete(e.tool_use_id)
    })
  }).catch(($, e, next) => (next?.error?.kind === 'timeout' && e.tool_use_id !== undefined && !begun.has(e.tool_use_id) ? { deny: QUEUED } : failed()))

  on('tool.call', { tool: LIST }, async ($, e) => {
    const { root, cards, unreadable } = await refresh($)
    await remember($, e.tool_use_id, listLines(cards, unreadable, { none: t.noCards, unreadable: t.rowUnreadable }))
    return { result: listText(slashed(`${root}/${DIR}`), cards, await homeOf($), unreadable) }
  }).catch(failed)

  // The card call's row keeps the engine's header, spinner and error colours with no input in
  // it: the result line below names the card and what the call did, so the fields are noise.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) =>
    next(e.props.tool === CARD ? { ...e, props: { ...e.props, input: {} } } : e),
  )

  // The result block under a card or list row reads one card per line, `● title (new)`, from the
  // lines the call left behind. An errored result, another tool, or a call with no lines kept
  // (after /clear or a resume) is drawn as it came.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isErrored || (e.props.tool !== CARD && e.props.tool !== LIST)) return next(e)
    const lines = (await read($, toolRows))[e.props.tool_use_id]
    const output = lines === undefined ? undefined : withText(e.props.output, lines.join('\n'))
    return next(output === undefined ? e : { ...e, props: { ...e.props, output } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // What other mods draw in the band stays below this one's rows.
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, isHidden))) return below
    // A view never loaded (cwd '') is the state a /clear leaves, with no session.start after
    // it: load it unawaited, once at a time, and its write draws the band again.
    const current = await read($, view)
    if (current.cwd === '' && loading === undefined) {
      loading = refresh($)
        .catch(ignore)
        .finally(() => (loading = undefined))
    }
    // No cards still draws the rule and one dim row, so a shown band is told from a hidden one.
    const cards = current.cards
    return bandTree(
      $.ui.resolve(e),
      {
        cards,
        columns: e.props.bodyColumns,
        now: await $.clock.now(),
        isExpanded: await read($, isExpanded),
        offset: await read($, offset),
        filter: asFilter(String(await read($, filter))) ?? 'all',
        isFolded: await read($, isFolded),
        onToggleFold: () => update($, isFolded, v => !v),
        onToggleExpand: () => toggleExpand($),
        onSetOffset: (n: number) => update($, offset, () => n),
        onSetFilter: (f: HandoffFilter) => setFilter($, f),
        text: t,
        onCopyCard: async (file: string, surface?: RenderSurface) => {
          const { root } = await read($, view)
          const path = `${root ?? (await $.session.cwd())}/${DIR}/${file}`
          const r = await $.ui.copy({ text: path, surface })
          $.ui.toast(r.isCopied ? t.copied(path) : t.copyFailed(String(r.reason)))
        },
      },
      below,
    )
  })
}
