import { expect, test } from 'claude-code/testing'
import { isWindowsPath, moveArgv, removeArgv, slashed } from '../hooks/platform'

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

test('moveArgv and removeArgv use mv and rm from PATH on POSIX and cmd with \\ paths on Windows', () => {
  expect(moveArgv('/h/a.tmp', '/h/a')).toEqual(['mv', '-f', '/h/a.tmp', '/h/a'])
  expect(moveArgv('C:/h/a', 'C:/h/b')).toEqual(['cmd', '/d', '/c', 'move', '/y', 'C:\\h\\a', 'C:\\h\\b'])
  expect(removeArgv('/h/a')).toEqual(['rm', '-f', '/h/a'])
  expect(removeArgv('C:/h/a')).toEqual(['cmd', '/d', '/c', 'del', '/f', '/q', 'C:\\h\\a'])
})

test('a Windows path cmd would parse as commands gets no argv; POSIX is untouched', () => {
  expect(moveArgv('C:/r/a&calc.md', 'C:/r/b.md')).toBeUndefined()
  expect(moveArgv('C:/r/a.md', 'C:/Users/Tom|x/b.md')).toBeUndefined()
  expect(removeArgv('C:/Users/Tom&Jerry/1.json')).toBeUndefined()
  expect(removeArgv('C:/Users/%TEMP%/1.json')).toBeUndefined()
  expect(removeArgv('C:/Users/John Doe/1.json')).toEqual(['cmd', '/d', '/c', 'del', '/f', '/q', 'C:\\Users\\John Doe\\1.json'])
  expect(moveArgv('/r/a&b', '/r/c')).toEqual(['mv', '-f', '/r/a&b', '/r/c'])
})
