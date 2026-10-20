import { MARK, str } from './tasks'

// What this mod's task_create / task_update rows show in the transcript, from plain values
// (no `$`): the header's count, and the result block's one-line-per-task text. The engine
// draws both rows itself; the model's own tool result is never touched.

type Item = Record<string, unknown>

const SUBJECT_MAX = 60

const items = (input: unknown, list: 'tasks' | 'updates'): Item[] => {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Item
  const many = o[list]
  return Array.isArray(many) ? many.filter((x): x is Item => typeof x === 'object' && x !== null) : [o]
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

const cap = (s: string) => {
  const chars = [...flat(s)]
  return chars.length > SUBJECT_MAX ? `${chars.slice(0, SUBJECT_MAX - 1).join('')}…` : chars.join('')
}

// The header's parentheses: only the count, under the tool's own batch field name, so the
// engine's `key: value` header reads `(tasks: 3)` / `(updates: 1)` like any MCP row (a number
// prints unquoted). Undefined: not a call this file summarises (another tool, or an input with
// nothing to show); the value is never undefined.
export const summary = (tool: string, input: unknown): Record<string, number> | undefined => {
  const isCreate = tool.endsWith('__task_create')
  const n = isCreate
    ? items(input, 'tasks').filter(i => str(i.subject) !== undefined).length
    : tool.endsWith('__task_update')
      ? items(input, 'updates').filter(i => str(i.taskId) !== undefined).length
      : 0
  return n === 0 ? undefined : { [isCreate ? 'tasks' : 'updates']: n }
}

const MARKS: Record<string, string> = { ...MARK, deleted: '✗' }

// One result line per task. A line never starts with a space or a tab, so every line of the
// block starts where the first does: the engine puts the block's text in one column box beside
// its `⎿` prefix and lays each line at that box's left edge.
export const createLines = (made: { id: string; subject: string }[]) => made.map(t => `#${t.id} ${cap(t.subject)}`)

// `status` is what the call set; a call that set none (an owner-only update) shows `·`, since
// the line says what the call did and the board's status then is not its doing.
export const updateLines = (rows: { id: string; status?: string; subject: string }[]) =>
  rows.map(r => `#${r.id} ${r.status === undefined ? '·' : (MARKS[r.status] ?? '·')} ${cap(r.subject)}`)

const isBlock = (b: unknown): b is { type: string; text: string } =>
  typeof b === 'object' && b !== null && (b as Item).type === 'text' && typeof (b as Item).text === 'string'

// `output` carrying `text` in the shape it came in: the engine's output schema for a plugin tool
// takes a string or an array of content blocks (a `{ content }` wrapper too). Undefined for any
// other shape, which the caller leaves as the engine drew it.
export const withText = (output: unknown, text: string): unknown => {
  if (typeof output === 'string') return text
  if (Array.isArray(output)) return output.length > 0 && output.every(isBlock) ? [{ type: 'text', text }] : undefined
  if (typeof output === 'object' && output !== null && 'content' in output) {
    const content = withText((output as Item).content, text)
    return content === undefined ? undefined : { ...output, content }
  }
  return undefined
}
