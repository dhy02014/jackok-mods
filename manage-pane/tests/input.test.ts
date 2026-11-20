import { expect, test } from 'claude-code/testing'
import { flag, idOf, patchOf } from '../hooks/input'

// The test host refuses a non-boolean option before the mod loads, so the string form is pinned here.
test('an option given as a boolean or its string counts; anything else is the default', () => {
  expect([flag(true, false), flag('true', false), flag(false, true), flag('false', true)]).toEqual([true, true, false, false])
  expect([flag(undefined, true), flag('yes', false), flag(1, false)]).toEqual([true, false, false])
})

test('a task id sent as an integer is its decimal string; any other non-string is no id', () => {
  expect([idOf(3), idOf('3'), idOf(0), idOf(1.5), idOf(Number.NaN), idOf(Infinity), idOf(''), idOf(null)]).toEqual(['3', '3', '0', undefined, undefined, undefined, undefined, undefined])
  expect(patchOf('1', { addBlockedBy: [2, '3', 4.5, '', null] }).addBlockedBy).toEqual(['2', '3'])
})
