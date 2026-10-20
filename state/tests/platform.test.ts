import { expect, test } from 'claude-code/testing'
import { isUnder, slashed } from '../hooks/platform'

test('slashed turns separators to / and drops a trailing one', () => {
  expect(slashed('C:\\Users\\u\\')).toBe('C:/Users/u')
  expect(slashed('/home/u/')).toBe('/home/u')
  expect(slashed('/')).toBe('/')
  expect(slashed('C:\\')).toBe('C:/')
})

test('isUnder folds drive-letter case and ignores separators', () => {
  expect(isUnder('c:\\Users\\u\\proj', 'C:/Users/u')).toBe(true)
  expect(isUnder('C:/Users/u', 'C:\\Users\\u\\')).toBe(true)
  expect(isUnder('C:/Users/uv', 'C:/Users/u')).toBe(false)
  expect(isUnder('/home/U/proj', '/home/u')).toBe(false)
  expect(isUnder('/home/u/proj', '/home/u')).toBe(true)
})
