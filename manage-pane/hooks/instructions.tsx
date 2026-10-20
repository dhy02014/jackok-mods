import type { PaneInstruction } from '../types'
import { tilde } from './agents'
import { slashed } from './platform'
import type { Strings } from './strings'
import type { Draw } from './tasks'

// The instruction files' pure half: which ones the context carried this conversation, how
// many times each went in and how big its body was, read off the conversation the model is
// sent (`$.session.messages({ as: 'api' })`): every `Contents of <path>` framing the engine put
// inside a system reminder, in the first message's context or riding a tool result as a
// nested CLAUDE.md or a path-scoped rule. `prompt.context`, `prompt.attachment` and
// `session.compact` are not used: where an organization manages Claude Code they pass over
// an installed plugin. A compaction (or a rewind) shortens the conversation and drops the
// old copies, so a scan that finds fewer messages than the last one banks the last one's
// counts first. The hooks are in ./register.tsx.

export type Loads = Record<string, PaneInstruction>
export type Scan = Record<string, { kind: string; count: number; bytes?: number }>
export type LastScan = { messages: number; live: Scan }

// The bank after a scan of `messages` messages: the last scan's copies join it when the
// conversation got shorter, since those copies were sent and are gone from the window.
export const bankIfShrunk = (shown: Loads, base: Loads, last: LastScan, messages: number): Loads =>
  messages < last.messages ? mergeLoads(shown, base, last.live) : base

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'
// The engine's framing line: `Contents of <path>:` or `Contents of <path> (<what it is>):`.
const CONTENTS = /^Contents of (.+?)(?: \([^()\n]*\))?:[ \t]*$/gm

// A string's length in UTF-8 bytes; the module has no TextEncoder to lean on.
export const utf8Bytes = (s: string) => {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

// The files one text frames as loaded, only inside a system reminder, so a tool's output
// that quotes the framing counts nothing. A file's span runs from its framing line to the
// next framing line or the reminder's close, whichever comes first, trimmed. The span can
// overrun the file: the engine may join other context (a hook's note, the token count) into
// the same reminder after a rule's body, so `scanLoads` trims it against the file on disk.
export const contentsIn = (text: string): { path: string; body: string }[] => {
  const found = [...text.matchAll(CONTENTS)].filter(m => text.lastIndexOf(OPEN, m.index) > text.lastIndexOf(CLOSE, m.index))
  return found.map((m, i) => {
    const start = m.index + m[0].length
    const close = text.indexOf(CLOSE, start)
    const end = Math.min(found[i + 1]?.index ?? text.length, close === -1 ? text.length : close)
    return { path: slashed(m[1]!), body: text.slice(start, end).trim() }
  })
}

const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/

// A file's text as the engine frames it: line ends as `\n`, its YAML frontmatter (a rule's
// `paths:`) left out, trimmed.
export const diskBody = (text: string) => text.replace(/\r\n?/g, '\n').replace(FRONTMATTER, '').trim()

// A copy's size: the file's own body when the span opens with it, so whatever followed in the
// reminder counts nothing; else (no file read, or it changed since it loaded) the whole span.
const sizeOf = (body: string, disk: string | undefined) =>
  utf8Bytes(disk !== undefined && disk !== '' && body.startsWith(disk) ? disk : body)

type ApiLike = { role?: unknown; content?: unknown }
type BlockLike = { type?: unknown; text?: unknown; content?: unknown }

// Each file's copies in the live conversation, in the order they first appear: `context` at
// a message's top level, `nested` inside a tool result. The model's own turns are skipped.
// The newest copy's size stands for the file: a reload after an edit carries the new body.
// `disk` holds each file's `diskBody` by path, where it could be read.
export const scanLoads = (messages: readonly ApiLike[], disk: Readonly<Record<string, string>> = {}): Scan => {
  const found: Scan = {}
  const add = (text: unknown, kind: string) => {
    if (typeof text !== 'string') return
    for (const { path, body } of contentsIn(text)) {
      const bytes = sizeOf(body, disk[path])
      const f = found[path]
      found[path] = f === undefined ? { kind, count: 1, bytes } : { ...f, count: f.count + 1, bytes }
    }
  }
  const walk = (content: unknown, kind: string) => {
    if (typeof content === 'string') return add(content, kind)
    if (!Array.isArray(content)) return
    for (const b of content as BlockLike[]) {
      if (b?.type === 'text') add(b.text, kind)
      else if (b?.type === 'tool_result') walk(b.content, 'nested')
    }
  }
  for (const m of messages) if (m.role === 'user') walk(m.content, 'context')
  return found
}

// The pane's list: what earlier context windows carried (`base`) plus the live window's
// copies. A path keeps the place it first took; a new one takes the next. Its size is the
// live window's copy, else the last one banked.
export const mergeLoads = (prev: Loads, base: Loads, live: Scan): Loads => {
  const next: Loads = {}
  let order = Math.max(0, ...[...Object.values(prev), ...Object.values(base)].map(f => f.order))
  for (const path of new Set([...Object.keys(base), ...Object.keys(live)])) {
    const count = (base[path]?.count ?? 0) + (live[path]?.count ?? 0)
    const kind = live[path]?.kind ?? base[path]?.kind ?? 'nested'
    const bytes = live[path]?.bytes ?? base[path]?.bytes
    const f: PaneInstruction = { kind, count, order: prev[path]?.order ?? base[path]?.order ?? ++order }
    next[path] = bytes === undefined ? f : { ...f, bytes }
  }
  return next
}

export type LoadGroup = { dir: string; rows: { path: string; rel: string; count: number; bytes?: number }[] }

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

// The shallowest directory at or above `dir` that itself holds a loaded file.
const rootOf = (dir: string, dirs: Set<string>) => {
  let root = dir
  for (let up = parentOf(dir); up !== ''; up = parentOf(up)) if (dirs.has(up)) root = up
  return root
}

// The files by workspace root, each written once as a header: a file at any depth below a
// directory that itself holds a loaded file joins it (`~/.claude` + `rules/style.md`,
// `memory/MEMORY.md`), so a config's rules and memory sit under its
// CLAUDE.md. Groups and rows keep load order.
export const groupLoads = (all: Loads): LoadGroup[] => {
  const rows = Object.entries(all).sort(([, a], [, b]) => a.order - b.order)
  const dirs = new Set(rows.map(([path]) => parentOf(path)))
  const groups = new Map<string, LoadGroup>()
  for (const [path, f] of rows) {
    const dir = rootOf(parentOf(path), dirs)
    const group = groups.get(dir) ?? { dir, rows: [] }
    group.rows.push({ path, rel: path.slice(dir.length + 1), count: f.count, bytes: f.bytes })
    groups.set(dir, group)
  }
  return [...groups.values()]
}

// A path below its root shows at most its last three segments, `…/` standing for the rest.
const MAX_DEPTH = 3
export const shortRel = (rel: string) => {
  const parts = rel.split('/')
  return parts.length > MAX_DEPTH ? `…/${parts.slice(-MAX_DEPTH).join('/')}` : rel
}

// A size in the pane's column: bytes under 1 KiB, else KiB with one decimal, whole from 100K.
export const formatBytes = (n: number) => (n < 1024 ? `${n}B` : n < 100 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${Math.round(n / 1024)}K`)

// The Prompt tab's body: per directory a dim header, then its files indented, each with its
// body's size dim at the right edge, and under them all the sizes' total. No load count: a
// file goes in once and rides every request after, so the count says nothing. A path too
// wide gives way from its start, so the file name and its size stay. A file loaded before
// sizes were kept has none and adds nothing to the total.
export const instructionsTree = ({ Box, Text }: Draw, t: Strings, all: Loads) => {
  const groups = groupLoads(all)
  const sizes = Object.values(all).flatMap(f => (f.bytes === undefined ? [] : [f.bytes]))
  return (
    <Box key="pane-instructions" flexDirection="column">
      {groups.length === 0 && <Text dimColor>{t.noInstructions}</Text>}
      {groups.map(g => (
        <Box key={`pane-instruction-dir:${g.dir}`} flexDirection="column">
          <Text dimColor wrap="truncate-start">
            {tilde(g.dir)}
          </Text>
          {g.rows.map(r => (
            <Box key={`pane-instruction:${r.path}`} paddingLeft={2} flexDirection="row">
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-start">{shortRel(r.rel)}</Text>
              </Box>
              {r.bytes !== undefined && (
                <Box flexShrink={0} paddingLeft={1}>
                  <Text key={`pane-instruction-size:${r.path}`} dimColor>
                    {formatBytes(r.bytes)}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      ))}
      {sizes.length > 0 && (
        <Box key="pane-instruction-total" marginTop={1} justifyContent="flex-end">
          <Text dimColor>{`${t.instructionsTotal}  ${formatBytes(sizes.reduce((a, b) => a + b, 0))}`}</Text>
        </Box>
      )}
    </Box>
  )
}
