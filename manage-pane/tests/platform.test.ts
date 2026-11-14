import { expect, test } from 'claude-code/testing'
import { isWindowsPath, slashed } from '../hooks/platform'

test('isWindowsPath knows drive-letter and UNC paths in either separator', () => {
  expect(isWindowsPath('C:\\Users\\u')).toBe(true)
  expect(isWindowsPath('c:/Users/u')).toBe(true)
  expect(isWindowsPath('\\\\server\\share')).toBe(true)
  expect(isWindowsPath('//server/share')).toBe(true)
  expect(isWindowsPath('/home/u')).toBe(false)
  expect(isWindowsPath('/c/Users/u')).toBe(false)
})

test('slashed turns separators to / and drops a trailing one', () => {
  expect(slashed('C:\\Users\\u\\')).toBe('C:/Users/u')
  expect(slashed('/home/u/')).toBe('/home/u')
  expect(slashed('/')).toBe('/')
  expect(slashed('C:\\')).toBe('C:/')
})
