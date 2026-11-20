import { expect, test } from 'bun:test'
import { commandsOf, scriptOf } from '../src/shell.ts'
import { DYN, type Script } from '../src/shellNodes.ts'
import { calls, parse } from './parse.ts'

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

const withFiles = (command: string, files: Record<string, string>) =>
  commandsOf(
    scriptOf(command, parse, undefined, {
      files: new Map(Object.entries(files)),
      cwd: '/s',
    }) as Script,
    { cwd: '/s', home: '/h' },
  ).map((c) => c.argv.map((w) => w.text).join(' '))

test('a script run by its path is read when its shebang names an sh-family shell', () => {
  const push = '#!/usr/bin/env bash\ngit push origin main\n'
  expect(withFiles('./ship.sh', { '/s/ship.sh': push })).toContain('git push origin main')
  expect(withFiles('/r/ship.sh', { '/r/ship.sh': '#!/bin/sh\ngit push origin main' })).toContain(
    'git push origin main',
  )
  expect(withFiles('./ship.sh', { '/s/ship.sh': '#!/usr/bin/env -S zsh -e\ngit push' })).toContain(
    'git push',
  )
  // Not a shell script: python, no shebang, or a name with no path.
  expect(withFiles('./ship.sh', { '/s/ship.sh': '#!/usr/bin/python3\ngit push' })).toEqual([
    './ship.sh',
  ])
  expect(withFiles('./ship.sh', { '/s/ship.sh': 'git push' })).toEqual(['./ship.sh'])
  expect(withFiles('ship.sh', { '/s/ship.sh': push })).toEqual(['ship.sh'])
})
