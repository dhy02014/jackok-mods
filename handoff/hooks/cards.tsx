import type { HandoffCard, HandoffStatus } from '../types'
import { cells } from './cells'
import { isUnder, slashed } from './platform'

// The cards' pure half: the tool specs, the card format, workspace matching and ages;
// the band's tree is in ./band. Every hook and every `$` call is in ./register.tsx (the
// engine follows `$` into no imported file).

// Both relative to the workspace root: the repo's main checkout, also from a worktree, or
// the session's directory outside git. A closed card, and its retired doc, go into CLOSED_DIR.
export const DIR = 'handoff'
export const CLOSED_DIR = 'handoff/closed'
export const STALE_DAYS = 14
export const BAND_MAX = 3
// Expanded, the band shows this many rows at most; its [^]/[v] buttons page the window.
export const BAND_WINDOW = 5

// A card's status mark, in the band and in the tool rows; a closed card reads `✓` there.
export const MARK: Record<HandoffStatus, string> = { open: '●', hold: '◌' }
export const CLOSED_MARK = '✓'

// The window's first row, kept inside a list of `total` rows.
export const windowStart = (offset: number, total: number) => Math.max(0, Math.min(offset, total - BAND_WINDOW))

// A band row is `#N title — next  N days [hold]`: these caps keep it near 120 cells, one line
// in a common terminal. Only a write is held to them; a card already on disk is never refused.
export const TITLE_CELLS = 40
export const NEXT_CELLS = 60

// The deny reason for a `title` or `next` wider than its cap; undefined when it fits.
export const tooWide = (field: 'title' | 'next', value: string) => {
  const limit = field === 'title' ? TITLE_CELLS : NEXT_CELLS
  const width = cells(oneLine(value))
  return width <= limit ? undefined : `card: ${field} is ${width} cells wide; the limit is ${limit} (a Hangul or CJK character is 2). Write it shorter.`
}

export const TOOLS = [
  {
    name: 'card',
    isDeferred: false,
    description:
      'Create, update or close a handoff card (work left for a later session) in this repo\'s handoff/ folder (the session\'s directory outside git). Call it when work remains at session end, or when the user asks for a handoff; give `title` and `next` (both required) to create, `slug` to update, `slug` with `status: done` to close. A long body may live in a doc referenced by `doc` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `The work, in at most ${TITLE_CELLS} cells (Hangul/CJK count 2).` },
        next: { type: 'string', description: `The very next step in at most ${NEXT_CELLS} cells.` },
        summary: { type: 'string', description: 'One line of key points: what is done, what is left, why; "" clears it.' },
        status: {
          type: 'string',
          enum: ['open', 'hold', 'done'],
          description:
            'open: a later session can start `next` with no one\'s input. hold: `next` waits on a user decision or an outside event — name what it waits on in `next`. done: all the card\'s work is finished; needs `slug`, ignores other fields, moves the card into handoff/closed/, off the band, with its doc when that is in this repo and no other card names it; nothing is deleted (a finished step is an edit, not done). Default open.',
        },
        body: { type: 'string', description: 'Markdown, in order: current state (done, uncommitted), decisions and why, next steps in order, gotchas that cost time, how to verify.' },
        doc: { type: 'string', description: '~-prefixed path of a detailed doc; "" clears it.' },
        slug: { type: 'string', description: 'Card to update, by slug or filename; omit to create one.' },
      },
    },
  },
  {
    name: 'list',
    isDeferred: false,
    description: 'List this workspace\'s handoff cards, one line each: status, title, absolute path.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

// A card is a doc the person reads, so every text field of it is written in the
// settings' `language`, said once in the tool's description. No language set: the specs as they are.
export const toolsFor = (language: unknown) => {
  const lang = typeof language === 'string' && language.trim() !== '' ? language.trim() : undefined
  if (lang === undefined) return TOOLS
  const inLang = ` Write title, next, summary and body in ${lang} (the user's \`language\` setting); code identifiers stay as they are.`
  return TOOLS.map(t => (t.name !== 'card' ? t : { ...t, description: t.description + inLang }))
}

export const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

export const asStatus = (v: unknown): HandoffStatus | undefined => (v === 'open' || v === 'hold' ? v : undefined)

// One line: a frontmatter value never spans two.
export const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim()

// ---- paths: stored with `~`, compared expanded ----

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

export const expandHome = (p: string, home: string) =>
  trimSlash(p === '~' ? home : p.startsWith('~/') ? `${home}${p.slice(1)}` : p)

export const tildify = (p: string, home: string) => {
  const q = slashed(p)
  return isUnder(q, home) ? `~${q.slice(home.length)}` : q
}

export const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

// `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`: the common
// dir's parent is the main checkout, also from a worktree; a common dir not named
// `.git` (a submodule's) falls back to the toplevel. So does a bare repo's worktree, whose
// cards then live in that worktree: accepted. Git before 2.31 echoes the unknown flag and
// prints a relative common dir, so anything but two absolute lines is undefined.
export const rootOf = (out: string): string | undefined => {
  const lines = out.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (lines.length !== 2 || !lines.every(isAbsolute)) return undefined
  const [common, top] = lines as [string, string]
  return common.endsWith('/.git') ? common.slice(0, -'/.git'.length) || '/' : top
}

// A doc path as stored, absolute; undefined for a `~` path with no home to expand it.
const docAt = (doc: string, home: string | undefined) =>
  home !== undefined ? slashed(expandHome(doc, home)) : doc.startsWith('~') ? undefined : slashed(doc)

const samePath = (a: string, b: string) => isUnder(a, b) && isUnder(b, a)

// One path holds the other, either way round, or both are the same.
const overlaps = (a: string, b: string) => isUnder(a, b) || isUnder(b, a)

// What closing `card` does with its doc: it follows the card into CLOSED_DIR only from
// inside the card's repo (a doc elsewhere is not the repo's to retire), never from inside
// handoff/ (other cards, closed/), and only when no card still open in `others` names it, a
// folder holding it, or a file inside it. `from` is the doc as found, for the result line.
// register.tsx's retireDoc adds the checks that need `$`: a file, not a folder, tracked by git.
export const docPlan = (
  card: HandoffCard,
  others: readonly HandoffCard[],
  root: string,
  home: string | undefined,
): { from: string; left?: string } | undefined => {
  if (card.doc === undefined) return undefined
  const from = docAt(card.doc, home)
  if (from === undefined) return { from: card.doc, left: 'HOME/USERPROFILE is unset' }
  if (from.split('/').some(s => s === '.' || s === '..')) return { from, left: 'the path has a . or .. segment' }
  if (!isUnder(from, root) || samePath(from, root)) return { from, left: 'outside this repo' }
  if (isUnder(from, `${root}/${DIR}`)) return { from, left: `it is inside ${DIR}/` }
  for (const c of others) {
    if (c.file === card.file || c.doc === undefined) continue
    const at = docAt(c.doc, home)
    // A `~` path with no home to expand it cannot be told apart: kept, as a sharer would be.
    if (at === undefined) return { from, left: `card ${c.file} names ${c.doc}, which cannot be compared` }
    if (!overlaps(at, from)) continue
    return { from, left: samePath(at, from) ? `card ${c.file} still names it` : `card ${c.file} names ${c.doc}, which overlaps it` }
  }
  return { from }
}

// `name` itself when no file in the folder has it, else `<stem>-2<ext>`, `-3`, ... (as freshFile
// numbers a slug): a move never lands on a file that is already there. Case-insensitive, as
// the default macOS and Windows file systems are.
export const freeName = (name: string, taken: ReadonlySet<string>) => {
  const low = new Set([...taken].map(n => n.toLowerCase()))
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let candidate = name
  for (let n = 2; low.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`
  return candidate
}

// ---- the card file ----

// A quoted scalar is unquoted; an unquoted one loses a trailing ` # comment`.
const scalar = (raw: string) => {
  const v = raw.trim()
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v.slice(0, v.lastIndexOf('"') + 1)))
    } catch {
      return undefined
    }
  }
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'") > 0 ? v.lastIndexOf("'") : undefined).replace(/''/g, "'")
  return v.replace(/\s+#.*$/, '').trim()
}

// Undefined for anything short of a card: no frontmatter, no title or next, a bad
// status. An `updated` or `workspaces` line from an older card is ignored. Never throws.
export const parseCard = (file: string, text: string): HandoffCard | undefined => {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text)
    if (m === null) return undefined
    const raw = new Map<string, string>()
    for (const line of (m[1] ?? '').split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)[ \t]*:(.*)$/.exec(line)
      if (kv !== null) raw.set(kv[1]!, kv[2]!)
    }
    const field = (k: string) => {
      const v = raw.get(k)
      return v === undefined ? undefined : str(scalar(v))
    }
    const title = field('title')
    const next = field('next')
    // A card written before `hold` was named so reads `on-hold`; the tool accepts only the two names.
    const rawStatus = field('status')
    const status = !raw.has('status') ? 'open' : rawStatus === 'on-hold' ? 'hold' : asStatus(rawStatus)
    if (title === undefined || next === undefined || status === undefined) return undefined
    const doc = field('doc')
    const summary = field('summary')
    return {
      file,
      title,
      status,
      next,
      ...(summary !== undefined ? { summary } : {}),
      ...(doc !== undefined ? { doc } : {}),
      body: (m[2] ?? '').replace(/\s+$/, ''),
    }
  } catch {
    return undefined
  }
}

// Quoted only where an unquoted value would read back otherwise.
const yaml = (s: string) => (/^[\s"'[\]{}#&*!|>%@`,-]|: | #|\s$|^$/.test(s) ? JSON.stringify(s) : s)

export const cardText = (c: HandoffCard) =>
  [
    '---',
    `title: ${yaml(oneLine(c.title))}`,
    `status: ${c.status}`,
    `next: ${yaml(oneLine(c.next))}`,
    ...(c.summary !== undefined ? [`summary: ${yaml(oneLine(c.summary))}`] : []),
    ...(c.doc !== undefined ? [`doc: ${yaml(oneLine(c.doc))}`] : []),
    '---',
    ...(c.body !== '' ? [c.body] : []),
    '',
  ].join('\n')

// ---- names ----

export const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'handoff'

export const isSlug = (s: string) => /^[a-z0-9][a-z0-9-]*$/.test(s)

export const slugOf = (file: string) => file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')

// A card by its filename (with or without `.md`) or its slug.
export const findCard = (cards: readonly HandoffCard[], key: string) =>
  cards.find(c => c.file === key || c.file === `${key}.md`) ?? cards.find(c => slugOf(c.file) === key)

// `<date>-<slug>.md`, `-2`, `-3`, ... past a slug a card already has and past any name in the
// folder (`names`, unreadable files and folders included), compared case-insensitively.
export const freshFile = (date: string, slug: string, cards: readonly HandoffCard[], names: readonly string[]) => {
  const used = new Set(cards.map(c => slugOf(c.file).toLowerCase()))
  const taken = new Set(names.map(n => n.toLowerCase()))
  const isFree = (s: string) => !used.has(s.toLowerCase()) && !taken.has(`${date}-${s}.md`.toLowerCase())
  let s = slug
  for (let n = 2; !isFree(s); n++) s = `${slug}-${n}`
  return `${date}-${s}.md`
}

// The card text with its one frontmatter `doc:` line now naming `doc`; undefined when the
// text has no frontmatter or not exactly one such line. Nothing else in the text changes.
export const withDocLine = (text: string, doc: string): string | undefined => {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n[\s\S]*)?)$/.exec(text)
  if (m === null) return undefined
  const head = m[2]!
  if ((head.match(/^doc[ \t]*:/gm) ?? []).length !== 1) return undefined
  return `${m[1]}${head.replace(/^doc[ \t]*:.*$/m, `doc: ${yaml(oneLine(doc))}`)}${m[3]}`
}

// ---- dates: the local calendar day ----

const pad = (n: number) => String(n).padStart(2, '0')

export const today = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const dayStart = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const daysBetween = (then: number, now: number) => Math.max(0, Math.round((dayStart(now) - dayStart(then)) / 86_400_000))

// When the card last changed: its file's mtime, so any edit counts, by the tool or by
// hand; the filename's creation date only when the listing gave no mtime.
const changedAt = (c: HandoffCard) => {
  if (c.mtimeMs !== undefined && c.mtimeMs > 0) return c.mtimeMs
  const m = /^(\d{4})-(\d{2})-(\d{2})-/.exec(c.file)
  return m === null ? 0 : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

// Whole calendar days from the card's last change to today, counted afresh each call.
export const cardAge = (c: HandoffCard, now: number) => daysBetween(changedAt(c), now)

export const isStale = (c: HandoffCard, now: number) => cardAge(c, now) > STALE_DAYS

// Open before hold, then the most recently changed first.
export const ordered = (cards: readonly HandoffCard[]) =>
  [...cards].sort((a, b) =>
    a.status !== b.status ? (a.status === 'open' ? -1 : 1) : changedAt(b) - changedAt(a) || a.file.localeCompare(b.file),
  )

// ---- what the model reads ----

// `dir` is the workspace's card folder as the model reads it: absolute, `~`-prefixed under home.
export const cardPath = (dir: string, c: HandoffCard) => `${dir}/${c.file}`

const pointer = (dir: string, c: HandoffCard, now: number) => {
  const age = cardAge(c, now)
  const stale = age > STALE_DAYS ? ', STALE — verify current state before acting' : ''
  return `${cardPath(dir, c)} "${c.title}" [${c.status}, updated ${age}d ago${stale}]`
}

// Pointers only: the cards may be stale or forgotten, so neither `next` nor a body
// goes in, and the line says not to act on them unasked.
export const contextText = (dir: string, cards: readonly HandoffCard[], now: number) =>
  cards.length === 0
    ? undefined
    : `Handoff cards exist for this workspace (pointers only — do not read or act on them unless the user asks to resume that work): ${ordered(cards)
        .map(c => pointer(dir, c, now))
        .join('; ')}`

// One line per card, then one per `.md` file in the folder that does not parse as a card
// (`unreadable`, file names), so none goes unseen; `dir` and every path here are absolute,
// never `~`, so the model can Read them as given.
export const listText = (dir: string, cards: readonly HandoffCard[], home: string | undefined, unreadable: readonly string[] = []) =>
  [
    ...(cards.length === 0
      ? ['No handoff cards for this workspace.']
      : ordered(cards).map(c => {
          const doc = c.doc === undefined ? '' : ` (doc: ${home === undefined ? c.doc : slashed(expandHome(c.doc, home))})`
          return `[${c.status}] ${c.title} — ${cardPath(dir, c)}${doc}`
        })),
    ...[...unreadable].sort().map(name => `[unreadable] ${dir}/${name}`),
  ].join('\n')
