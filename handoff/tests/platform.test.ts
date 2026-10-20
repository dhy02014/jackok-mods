import { expect, test } from 'claude-code/testing'
import { isUnder, isWindowsPath, mkdirArgv, moveArgv, slashed } from '../hooks/platform'

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

test('isUnder folds drive-letter case and ignores separators', () => {
  expect(isUnder('c:\\Users\\u\\proj', 'C:/Users/u')).toBe(true)
  expect(isUnder('C:/Users/u', 'C:\\Users\\u\\')).toBe(true)
  expect(isUnder('C:/Users/uv', 'C:/Users/u')).toBe(false)
  expect(isUnder('/home/U/proj', '/home/u')).toBe(false)
  expect(isUnder('/home/u/proj', '/home/u')).toBe(true)
})

test('moveArgv never overwrites and mkdirArgv creates parents: mv and mkdir from PATH on POSIX, cmd with \\ paths on Windows', () => {
  expect(moveArgv('/h/a.md', '/h/closed/a.md')).toEqual(['mv', '-n', '/h/a.md', '/h/closed/a.md'])
  expect(moveArgv('C:/h/a', 'C:/h/b')).toEqual(['cmd', '/d', '/c', 'move', '/-y', 'C:\\h\\a', 'C:\\h\\b'])
  expect(mkdirArgv('/h/handoff/closed')).toEqual(['mkdir', '-p', '/h/handoff/closed'])
  expect(mkdirArgv('C:/h/handoff/closed')).toEqual(['cmd', '/d', '/c', 'mkdir', 'C:\\h\\handoff\\closed'])
})

test('a Windows path cmd would parse as commands gets no argv; POSIX is untouched', () => {
  expect(moveArgv('C:/r/a&calc.md', 'C:/r/b.md')).toBeUndefined()
  expect(moveArgv('C:/r/a.md', 'C:/Users/Tom|x/b.md')).toBeUndefined()
  expect(mkdirArgv('C:/Users/Tom&Jerry/handoff')).toBeUndefined()
  expect(mkdirArgv('C:/Users/%TEMP%/handoff')).toBeUndefined()
  expect(mkdirArgv('C:/Users/John Doe/handoff')).toEqual(['cmd', '/d', '/c', 'mkdir', 'C:\\Users\\John Doe\\handoff'])
  expect(moveArgv('/r/a&b', '/r/c')).toEqual(['mv', '-n', '/r/a&b', '/r/c'])
})
