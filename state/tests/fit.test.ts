import { expect, test } from 'claude-code/testing'
import { cells, fitParts, shareWidths, truncateEnd, truncateStart } from '../hooks/fit'

test('truncation counts cells, so Hangul never overruns', () => {
  expect(truncateEnd('abcdef', 6)).toBe('abcdef')
  expect(truncateEnd('abcdef', 4)).toBe('abc…')
  expect(truncateStart('…/worktrees/feature-x', 10)).toBe('…feature-x')
  expect(truncateEnd('한글브랜치', 6)).toBe('한글…')
  expect(cells(truncateEnd('한글브랜치', 6))).toBeLessThanOrEqual(6)
  expect(cells(truncateStart('~/작업/한글폴더', 7))).toBeLessThanOrEqual(7)
  expect(truncateEnd('abc', 0)).toBe('')
})

test('shareWidths keeps a short part whole and cuts the heavier long part first', () => {
  // Fits: nothing cut.
  expect(shareWidths([{ width: 5, weight: 1 }, { width: 5, weight: 3 }], 10)).toEqual([5, 5])
  // A long model never takes a short branch's cells.
  const ws = shareWidths([{ width: 76, weight: 1 }, { width: 6, weight: 2 }, { width: 8, weight: 3 }], 40)
  expect(ws).toEqual([26, 6, 8])
  // Two long parts: the heavier gives way more, and the room is used exactly.
  const [cwd = 0, branch = 0] = shareWidths([{ width: 40, weight: 2 }, { width: 40, weight: 3 }], 50)
  expect(cwd + branch).toBe(50)
  expect(cwd).toBeGreaterThan(branch)
  expect(shareWidths([{ width: 10, weight: 1 }], -5)).toEqual([0])
})

test('fitParts drops the heaviest part rather than show a stub of it', () => {
  const parts = [{ width: 15, weight: 1 }, { width: 40, weight: 2 }, { width: 50, weight: 3 }]
  // Room for all three, cut.
  const wide = fitParts(parts, 60, 3)
  expect(wide.every(w => w >= 4)).toBe(true)
  expect(wide.reduce((n, w) => n + w, 0) + 9).toBeLessThanOrEqual(60)
  // Too little: the branch goes first, then the cwd.
  const narrow = fitParts(parts, 20, 3)
  expect(narrow[2]).toBe(-1)
  expect(narrow.filter(w => w >= 0).reduce((n, w) => n + w + 3, 0)).toBeLessThanOrEqual(20)
  expect(fitParts(parts, 2, 3)).toEqual([-1, -1, -1])
})
