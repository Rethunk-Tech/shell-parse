import { expect, test } from 'bun:test'
import { DYN } from '../src/shellNodes.ts'
import { calls } from './parse.ts'

const argv = (command: string) =>
  calls(command).map((c) => c.argv.map((w) => w.text.replaceAll(DYN, '?')).join(' '))

test('commandsOf lists every call that runs, in order, and no text that only mentions one', () => {
  expect(argv('cd /a && git -C "$R" push x"$(git stash)"y | sh')).toEqual([
    'cd /a',
    'git stash',
    'git -C ? push x?y',
    'sh',
  ])
  expect(argv('echo "x $(git stash) `date`"')).toEqual(['git stash', 'date', 'echo x ? ?'])
})

test('a bash -c script is read as the calls it runs', () => {
  expect(argv("bash -c 'ls /a; cat b'")).toContain('cat b')
})
