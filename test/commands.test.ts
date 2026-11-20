import { expect, test } from 'bun:test'
import { fdExec } from '../src/runners.ts'
import { recipesOf } from '../src/scriptFile.ts'
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

test('fd -x and -X run their command like find -exec', () => {
  expect(argv('fd . ~ -X rm -rf')).toContain('rm -rf')
  expect(argv('fd -e log --exec rm {} ; .')).toContain('rm {}')
  expect(argv('fd -e log')).toEqual(['fd -e log'])
})

test('gate CMD runs CMD, while gate own verbs and bare flags run no command', () => {
  expect(argv('gate git push origin main')).toContain('git push origin main')
  expect(argv('gate -C /r --timeout 5m pkill node')).toContain('pkill node')
  expect(argv('gate -- run x')).toContain('run x')
  expect(argv('gate rm -rf "$X"')).toContain('rm -rf ?')
  expect(argv('gate push')).toEqual(['gate push'])
  expect(argv('gate -C /r run lint test')).toEqual(['gate -C /r run lint test'])
  expect(argv('gate --list')).toEqual(['gate --list'])
})

test('a task runner call reads the recipe the caller kept under its key', () => {
  const key = (file: string, target: string) => `${file}#${target}`
  const run = (command: string, files: Record<string, string>) => withFiles(command, files)
  const push = 'git push origin main'
  expect(run('make ship', { [key('/s/Makefile', 'ship')]: push })).toContain(push)
  expect(run('make', { [key('/s/Makefile', '')]: push })).toContain(push)
  expect(run('make -C /r ship', { [key('/r/Makefile', 'ship')]: push })).toContain(push)
  expect(run('make -j 4 -f b.mk ship', { [key('/s/b.mk', 'ship')]: push })).toContain(push)
  expect(run('npm run ship', { [key('/s/package.json', 'ship')]: push })).toContain(push)
  expect(run('npm test', { [key('/s/package.json', 'test')]: push })).toContain(push)
  expect(run('bun run ship', { [key('/s/package.json', 'ship')]: push })).toContain(push)
  expect(run('pnpm ship', { [key('/s/package.json', 'ship')]: push })).toContain(push)
  expect(run('pnpm run ship', { [key('/s/package.json', 'ship')]: push })).toContain(push)
  expect(run('yarn --silent ship', { [key('/s/package.json', 'ship')]: push })).toContain(push)
  expect(run('just ship', { [key('/s/justfile', 'ship')]: push })).toContain(push)
  // Controls: another target, a runner that reads no package script, and a recipe not kept.
  expect(run('make build', { [key('/s/Makefile', 'ship')]: push })).toEqual(['make build'])
  expect(run('bun ship', { [key('/s/package.json', 'ship')]: push })).toEqual(['bun ship'])
  expect(run('npm install', { [key('/s/package.json', 'install')]: push })).toEqual(['npm install'])
  expect(run('make ship', {})).toEqual(['make ship'])
})

test('a make call keys its recipe by the variables its command line sets', () => {
  const recipe = (command: string) => {
    const script = scriptOf(command, parse, undefined, { files: new Map(), cwd: '/s' }) as Script
    return commandsOf(script, { cwd: '/s', home: '/h' }).flatMap((c) => recipesOf(c, '/s'))
  }
  expect(recipe('make clean')[0]).toMatchObject({ key: '/s/Makefile#clean', vars: [] })
  expect(recipe('make clean BUILD_DIR=/ X=1')[0]).toMatchObject({
    key: '/s/Makefile#clean#BUILD_DIR,X',
    vars: ['BUILD_DIR', 'X'],
  })
  expect(recipe('make -e clean')[0]?.vars).toEqual(['*'])
  expect(recipe('make --environment-overrides clean')[0]?.vars).toEqual(['*'])
})

test('the recipe call carries the file it was read from', () => {
  const script = scriptOf('npm run ship', parse, undefined, {
    files: new Map([['/s/package.json#ship', 'git push']]),
    cwd: '/s',
  }) as Script
  const files = commandsOf(script, { cwd: '/s', home: '/h' }).map((c) => c.file)
  expect(files).toContain('/s/package.json')
})

test('fd runs its command from -HX clusters and --exec= too', () => {
  expect(argv('fd . ~ -HX rm -rf')).toContain('rm -rf')
  expect(argv('fd . ~ --exec=rm -rf')).toContain('rm -rf')
  expect(argv('fd . ~ --exec-batch=rm {} ;')).toContain('rm {}')
  const fd = calls('fd . ~ -HX rm').find((c) => c.name === 'fd')
  expect(fdExec(fd?.argv.slice(1) ?? [])).toEqual({ at: 2, first: 'rm' })
})

test('env -C dir runs the script from dir', () => {
  const ship = '#!/bin/sh\ngit push origin main'
  const run = (cmd: string, path: string) => withFiles(cmd, { [path]: ship })
  expect(run('env -C sub ./ship.sh', '/s/sub/ship.sh')).toContain('git push origin main')
  expect(run('env --chdir=sub ./ship.sh', '/s/sub/ship.sh')).toContain('git push origin main')
  expect(run('env -C sub ./ship.sh', '/s/ship.sh')).toEqual(['./ship.sh'])
})

test('a command runner runs the command after its own words, so every guard reads it', () => {
  const runners = [
    'uv run',
    'uv run --no-project --python 3.12 --with rich',
    'pnpm exec',
    'pnpm -C pkgs/a exec',
    'yarn exec',
    'mise exec --',
    'mise exec node@20 --',
    'direnv exec .',
    'poetry run',
    'dotenv --',
    'dotenv -e .env --',
    'op run --',
    'op run --env-file x.env --',
    'chronic',
  ]
  for (const r of runners) {
    expect([r, argv(`${r} git push origin main`)]).toEqual([r, ['git push origin main']])
    expect([r, argv(`${r} pytest`)]).toEqual([r, ['pytest']])
  }
  for (const c of [
    "npx -c 'git push origin main'",
    "npx --call='git push origin main'",
    "npm exec -c 'git push origin main'",
    "npm x --call 'git push origin main'",
  ]) {
    expect([c, argv(c).at(-1)]).toEqual([c, 'git push origin main'])
  }
  // Controls: a subcommand that runs no command, and npm run's own -c.
  expect(argv('uv sync')).toEqual(['uv sync'])
  expect(argv('pnpm install')).toEqual(['pnpm install'])
  expect(argv("npm run build -c 'git push'")).toEqual(['npm run build -c git push'])
  expect(argv('npx pytest')).toEqual(['npx pytest'])
})
