import { expect, test } from 'bun:test'
import {
  LIST_PROGRAMS,
  READ_ONLY_GIT,
  READ_ONLY_RGIT,
  READ_PROGRAMS,
  SEARCH_PROGRAMS,
} from '../src/readOnly.ts'

// The read set, pinned: any verb added to or removed from it fails here, and none of them writes. rgit is
// not on the gate's PATH, so this list is kept by hand rather than asked of `rgit --help`.
test('rgit reads are exactly the verbs that only read', () => {
  expect([...READ_ONLY_RGIT].sort((a, b) => a.localeCompare(b))).toEqual([
    'blame',
    'context',
    'diff',
    'find',
    'log',
    'show',
    'symbols',
  ])
  expect(READ_ONLY_RGIT.has('commit')).toBe(false)
  expect(READ_ONLY_RGIT.has('land')).toBe(false)
})

test('git reads never include a writing verb, and the program sets do not overlap', () => {
  for (const v of ['push', 'commit', 'checkout', 'reset']) {
    expect(READ_ONLY_GIT.has(v)).toBe(false)
  }
  for (const p of SEARCH_PROGRAMS) {
    expect(READ_PROGRAMS.has(p) || LIST_PROGRAMS.has(p)).toBe(false)
  }
  for (const p of READ_PROGRAMS) {
    expect(LIST_PROGRAMS.has(p)).toBe(false)
  }
})
