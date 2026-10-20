import { expect, test } from 'claude-code/testing'
import { flag } from '../hooks/input'

// The test host refuses a non-boolean option before the mod loads, so the string form is pinned here.
test('an option given as a boolean or its string counts; anything else is the default', () => {
  expect([flag(true, false), flag('true', false), flag(false, true), flag('false', true)]).toEqual([true, true, false, false])
  expect([flag(undefined, true), flag('yes', false), flag(1, false)]).toEqual([true, false, false])
})
