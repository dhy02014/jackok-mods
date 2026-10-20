import type { HandoffCard, HandoffStatus } from '../types'
import { CLOSED_MARK, MARK, oneLine, ordered } from './cards'

// What the card and list tools' rows show in the transcript, from plain values (no `$`): each
// call's result block as one line per card, `● title (new)`, as manage-pane's task rows read.
// The card call's header carries no input at all (register.tsx hands the engine `{}`): the result
// line already names the card and what the call did. The model's own tool result is never touched.

const MAX = 80

const cap = (s: string) => {
  const chars = [...oneLine(s)]
  return chars.length > MAX ? `${chars.slice(0, MAX - 1).join('')}…` : chars.join('')
}

// A line never starts with a space or a tab, so every line of the block starts where the first
// does: the engine puts the block's text in one column box beside its `⎿` prefix.

// A card the call wrote: its mark and title with what the call did, then `→ next`.
export const cardLines = (c: { title: string; status: HandoffStatus; next: string }, did: string) => [
  `${MARK[c.status]} ${cap(c.title)} ${did}`,
  `→ ${cap(c.next)}`,
]

export const closedLines = (title: string, did: string) => [`${CLOSED_MARK} ${cap(title)} ${did}`]

// One line per card in the band's order, then each `.md` file that is no card.
export const listLines = (cards: readonly HandoffCard[], unreadable: readonly string[], text: { none: string; unreadable: string }) => {
  const lines = [
    ...ordered(cards).map(c => `${MARK[c.status]} ${cap(c.title)}`),
    ...[...unreadable].sort().map(name => `? ${name} ${text.unreadable}`),
  ]
  return lines.length === 0 ? [text.none] : lines
}

const isBlock = (b: unknown): b is { type: string; text: string } =>
  typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text' && typeof (b as Record<string, unknown>).text === 'string'

// `output` carrying `text` in the shape it came in: the engine's output schema for a plugin tool
// takes a string or an array of content blocks (a `{ content }` wrapper too). Undefined for any
// other shape, which the caller leaves as the engine drew it.
export const withText = (output: unknown, text: string): unknown => {
  if (typeof output === 'string') return text
  if (Array.isArray(output)) return output.length > 0 && output.every(isBlock) ? [{ type: 'text', text }] : undefined
  if (typeof output === 'object' && output !== null && 'content' in output) {
    const content = withText((output as Record<string, unknown>).content, text)
    return content === undefined ? undefined : { ...output, content }
  }
  return undefined
}
