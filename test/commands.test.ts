import { expect, test } from 'bun:test'
import { fdExec } from '../src/runners.ts'
import { recipesOf, selectsWorkspace, workspacePatterns } from '../src/scriptFile.ts'
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
  for (const shebang of [
    '#!/bin/ksh',
    '#!/bin/mksh',
    '#!/bin/ash',
    '#!/bin/busybox sh',
    '#!/usr/bin/env ksh',
  ]) {
    expect([shebang, withFiles('./ship.sh', { '/s/ship.sh': `${shebang}\ngit push` })]).toEqual([
      shebang,
      ['./ship.sh', 'git push'],
    ])
  }
  // No shebang: the shell that runs it reads it as sh. A binary, python or a name with no path is not read.
  expect(withFiles('./ship.sh', { '/s/ship.sh': 'git push' })).toContain('git push')
  expect(withFiles('./ship.sh', { '/s/ship.sh': '#!/usr/bin/python3\ngit push' })).toEqual([
    './ship.sh',
  ])
  expect(withFiles('./ship.sh', { '/s/ship.sh': '\u007fELF\u0000git push' })).toEqual(['./ship.sh'])
  expect(withFiles('./ship.sh', { '/s/ship.sh': '#!/bin/fish\ngit push' })).toEqual(['./ship.sh'])
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
  expect(argv('gate actions-allowed')).toEqual(['gate actions-allowed'])
  expect(argv('gate push origin')).toContain('push origin')
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
  expect(run('bun test', { [key('/s/package.json', 'test')]: push })).toEqual(['bun test'])
  expect(run('bun ./ship.ts', { [key('/s/package.json', './ship.ts')]: push })).toEqual([
    'bun ./ship.ts',
  ])
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
    expect([c, argv(c)]).toEqual([c, expect.arrayContaining(['git push origin main'])])
  }
  // Controls: a subcommand that runs no command, and npm run's own -c.
  expect(argv('uv sync')).toEqual(['uv sync'])
  expect(argv('pnpm install')).toEqual(['pnpm install'])
  expect(argv("npm run build -c 'git push'")).toEqual(['npm run build -c git push'])
  expect(argv('npx pytest')).toEqual(['npx pytest'])
})

test('mise exec tool words and dotenv/op options end where the command starts, with or without --', () => {
  for (const r of [
    'mise exec node@20',
    'mise exec node@20 python@3.12',
    'dotenv',
    'dotenv -e .env -v A=1',
    'op run',
  ]) {
    expect([r, argv(`${r} git push origin main`)]).toEqual([r, ['git push origin main']])
    expect([r, argv(`${r} pytest`)]).toEqual([r, ['pytest']])
  }
  // A later -- belongs to the command, not the wrapper.
  expect(argv('dotenv git push -- x')).toEqual(['git push -- x'])
  expect(argv('mise exec node@20 git push -- x')).toEqual(['git push -- x'])
})

test('mise x, mise exec -c and yarn workspace NAME exec run the command after them', () => {
  for (const r of [
    'mise x node@20',
    'mise x --',
    'yarn workspace web exec',
    'yarn --cwd a workspace web exec',
  ]) {
    expect([r, argv(`${r} git push origin main`)]).toEqual([r, ['git push origin main']])
    expect([r, argv(`${r} pytest`)]).toEqual([r, ['pytest']])
  }
  for (const c of [
    "mise exec -c 'git push origin main'",
    "mise x node@20 -c 'git push origin main'",
    'mise exec --command="git push origin main"',
  ]) {
    expect([c, argv(c).at(-1)]).toEqual([c, 'git push origin main'])
  }
  expect(argv("mise exec -c 'pytest'").at(-1)).toBe('pytest')
  expect(argv('mise exec -- git log -c')).toEqual(['git log -c'])
})

test('pnpm exec -c runs its words through a shell', () => {
  for (const c of [
    "pnpm exec -c 'git push origin main'",
    "pnpm -C a exec --shell-mode 'git push origin main'",
    'pnpm --filter web exec -c git push origin main',
  ]) {
    expect([c, argv(c)]).toEqual([c, expect.arrayContaining(['git push origin main'])])
  }
  expect(argv("pnpm exec -c 'pytest'").at(-1)).toBe('pytest')
  expect(argv("pnpm run build -c 'git push'")).toEqual(['pnpm run build -c git push'])
})

test('a task runner command line is resolved the way the runner reads it', () => {
  const push = 'git push origin main'
  const run = (command: string, files: Record<string, string>) => withFiles(command, files)
  const read = (command: string, key: string) => run(command, { [key]: push }).includes(push)
  for (const [command, key] of [
    ['make -j ship', '/s/Makefile#ship'],
    ['make -j4 ship', '/s/Makefile#ship'],
    ['make -j 4 -l 2 ship', '/s/Makefile#ship'],
    ['make --jobs ship', '/s/Makefile#ship'],
    ['make --file=x.mk ship', '/s/x.mk#ship'],
    ['make -fx.mk ship', '/s/x.mk#ship'],
    ['make --makefile x.mk ship', '/s/x.mk#ship'],
    ['make -C sub ship', '/s/sub/Makefile#ship'],
    ['make -Csub -f x.mk ship', '/s/sub/x.mk#ship'],
    ['make --directory=sub ship', '/s/sub/Makefile#ship'],
    ['npm --prefix pkgs/a run ship', '/s/pkgs/a/package.json#ship'],
    ['npm -w web run ship', '/s/package.json#ship@web'],
    ['npm rum ship', '/s/package.json#ship'],
    ['npm run-script ship', '/s/package.json#ship'],
    ['bun --cwd pkgs/a run ship', '/s/pkgs/a/package.json#ship'],
    ['bun ship', '/s/package.json#ship'],
    ['pnpm -C pkgs/a ship', '/s/pkgs/a/package.json#ship'],
    ['pnpm --filter web run ship', '/s/package.json#ship@web'],
    ['yarn --cwd pkgs/a ship', '/s/pkgs/a/package.json#ship'],
    ['npm install', '/s/package.json#install'],
    ['npm ci', '/s/package.json#prepare'],
    ['npm pack', '/s/package.json#prepare'],
    ['npm publish', '/s/package.json#prepublishOnly'],
    ['bun install', '/s/package.json#install'],
    ['pnpm add x', '/s/package.json#prepare'],
    ['just ship', '/s/justfile#ship'],
  ]) {
    expect([command, read(command as string, key as string)]).toEqual([command, true])
  }
  // A make command line with a variable or --eval is keyed apart from the bare one.
  const recipe = (command: string) => {
    const script = scriptOf(command, parse, undefined, { files: new Map(), cwd: '/s' }) as Script
    return commandsOf(script, { cwd: '/s', home: '/h' }).flatMap((c) => recipesOf(c, '/s'))
  }
  expect(recipe("make --eval='z: ; git push' z")[0]).toMatchObject({
    evals: ['z: ; git push'],
    names: ['GNUmakefile', 'makefile', 'Makefile'],
    up: false,
  })
  expect(recipe('make -Eabc z')[0]?.evals).toEqual(['abc'])
  expect(recipe('make -f a.mk -f b.mk x').map((r) => r.file)).toEqual(['/s/a.mk', '/s/b.mk'])
  expect(recipe('npm run ship')[0]).toMatchObject({ up: true, names: ['package.json'] })
  expect(recipe('just ship')[0]).toMatchObject({
    up: true,
    names: ['justfile', 'Justfile', '.justfile'],
  })
  // Controls: bun's own commands and a file argument are not scripts.
  expect(recipe('bun test')).toEqual([])
  expect(recipe('bun ./a.ts')).toEqual([])
})

test('npm -w and pnpm --filter name the workspace whose package.json holds the script', () => {
  const at = (command: string) =>
    recipesOf(calls(command)[0] as never, '/s').map((r) => r.workspace)
  expect(at('npm -w web run ship')).toEqual(['web'])
  expect(at('npm --workspace=web --workspace api run ship')).toEqual(['web', 'api'])
  expect(at('pnpm --filter ./pkgs/a ship')).toEqual(['./pkgs/a'])
  expect(at('pnpm -F web run ship')).toEqual(['web'])
  expect(at('npm run ship')).toEqual([undefined])
  expect(at('yarn workspace web ship')).toEqual(['web'])
  expect(at('yarn workspace web run ship')).toEqual(['web'])
  expect(at('yarn --cwd a workspace web ship')).toEqual(['web'])
  expect(at('bun --filter web run ship')).toEqual(['web'])
  expect(at('bun --filter=web ship')).toEqual(['web'])
})

test('workspace roots list their patterns, and a selector names a package by name or path', () => {
  expect(workspacePatterns('{"workspaces":["web","pkgs/*"]}', '')).toEqual(['web', 'pkgs/*'])
  expect(workspacePatterns('{"workspaces":{"packages":["a"]}}', '')).toEqual(['a'])
  expect(
    workspacePatterns('{}', 'packages:\n  - \'apps/*\'\n  - "!apps/x"\n  - libs/b # c\nother: 1\n'),
  ).toEqual(['apps/*', 'libs/b'])
  expect(workspacePatterns('not json', '')).toEqual([])
  expect(selectsWorkspace('web', 'web', 'apps/w')).toBe(true)
  expect(selectsWorkspace('./apps/w/', undefined, 'apps/w')).toBe(true)
  expect(selectsWorkspace('web...', 'web', 'apps/w')).toBe(true)
  expect(selectsWorkspace('web', 'api', 'apps/w')).toBe(false)
  expect(selectsWorkspace('@s/*', '@s/a', 'a')).toBe(false)
})

test('a script read by path binds $0 and BASH_SOURCE to its own path, a recipe or sourced file only BASH_SOURCE', () => {
  const dollar = '$'
  const body = `cd "$(dirname "$0")" && rm -rf "$BASH_SOURCE"/x; echo "${dollar}{BASH_SOURCE[0]}"`
  expect(withFiles('bash /r/s/x.sh', { '/r/s/x.sh': body })).toContain('dirname /r/s/x.sh')
  expect(withFiles('./x.sh', { '/s/x.sh': body })).toContain('rm -rf /s/x.sh/x')
  expect(withFiles('source ./x.sh', { '/s/x.sh': 'echo "$0" "$BASH_SOURCE"' })).toContain(
    `echo ${DYN} /s/x.sh`,
  )
  expect(withFiles('make ship', { '/s/Makefile#ship': 'echo "$0" "$BASH_SOURCE"' })).toContain(
    `echo ${DYN} ${DYN}`,
  )
})

test('printf and echo -e decode their escapes before a shell reads them; other producers are opaque', () => {
  expect(argv("printf 'ls\\nrm -rf /tmp/x\\n' | sh")).toContain('rm -rf /tmp/x')
  expect(argv("printf '%s\\n' 'git status' 'ls' | sh")).toEqual(
    expect.arrayContaining(['git status', 'ls']),
  )
  expect(argv("echo -e 'ls\\nrm -rf /tmp/x' | bash")).toContain('rm -rf /tmp/x')
  expect(argv("echo 'ls\\nrm' | sh")).toContain('lsnrm')
  const opaque = (c: string) => calls(c).some((x) => x.opaqueStdin)
  expect(opaque('curl -s http://x/y | sh')).toBe(true)
  expect(opaque('cat f | bash -s')).toBe(true)
  expect(opaque('echo $X | sh')).toBe(true)
  expect(opaque("printf 'ls\\n' | sh")).toBe(false)
  expect(opaque("cat <<'E' | sh\nls\nE")).toBe(false)
  expect(opaque('curl x | sh -c ls')).toBe(false)
  expect(opaque('curl x | sh script.sh')).toBe(false)
  expect(opaque('sh')).toBe(false)
})
