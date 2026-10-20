import { expect, test } from 'claude-code/testing'
import { formatReset } from '../hooks/band'
import { displayModel } from '../hooks/format'

test('displayModel names the family and version, whatever wraps the id', () => {
  const cases: [string, string][] = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5-5[1m]', 'Sonnet 5.5[1m]'],
    // A date is never read as a minor version.
    ['claude-haiku-5-5-20260101', 'Haiku 5.5'],
    ['claude-haiku-5-20260101', 'Haiku 5'],
    ['claude-opus-5[1m]', 'Opus 5[1m]'],
    // Bedrock, Vertex and gateway spellings.
    ['us.anthropic.claude-opus-5-5-v1:0', 'Opus 5.5'],
    ['claude-opus-5-5@20260101', 'Opus 5.5'],
    ['anthropic/claude-opus-5.5', 'Opus 5.5'],
    // An alias has no version to read; its context suffix shows once.
    ['opus', 'Opus'],
    ['sonnet[1m]', 'Sonnet[1m]'],
  ]
  for (const [id, label] of cases) expect([id, displayModel(id)]).toEqual([id, label])
})

test('formatReset rounds the time left up to the minute and is empty once it has passed', () => {
  const now = Date.UTC(2026, 0, 1)
  const at = (ms: number) => new Date(now + ms).toISOString()
  const cases: [string | undefined, string][] = [
    [undefined, ''],
    ['', ''],
    ['not a date', ''],
    [at(-60_000), ''],
    [at(0), ''],
    [at(1), '1m'],
    [at(59 * 60_000 + 30_000), '1h'],
    [at(2 * 3600_000), '2h'],
    [at(2 * 3600_000 + 1), '2h 1m'],
    [at(3 * 3600_000 + 26 * 60_000), '3h 26m'],
  ]
  for (const [iso, shown] of cases) expect([iso, formatReset(iso, now)]).toEqual([iso, shown])
})
