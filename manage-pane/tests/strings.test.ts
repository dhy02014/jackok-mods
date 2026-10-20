import { expect, test } from 'claude-code/testing'
import { cells, tailFit } from '../hooks/strings'

test('widths are terminal cells: Hangul takes two, and a cut keeps the end', () => {
  expect([cells('worktree'), cells('워크트리'), cells('é')]).toEqual([8, 8, 1])
  expect([tailFit('워크트리', 8), tailFit('워크트리', 5), tailFit('워크트리', 6), tailFit('abcdef', 4)]).toEqual(['워크트리', '…트리', '…트리', '…def'])
})
