import { expect, test } from 'bun:test'
import { ansiC } from '../src/ansi.ts'
import { writesRedirect } from '../src/fileOps.ts'
import { fdExec } from '../src/runners.ts'
import { recipesOf, selectsWorkspace, workspacePatterns } from '../src/scriptFile.ts'
import { commandsOf, completeAsync, scriptOf, scriptOfAsync } from '../src/shell.ts'
import { DYN, type Script } from '../src/shellNodes.ts'
import { calls, parse, sh } from './parse.ts'

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

test('a shell fed by -s or a stdin path reads its heredoc though a file of that operand is on record', () => {
  const read = (c: string) =>
    withFiles(c, { '/s/a': '', '/s/1': '' }).filter(
      (w) => w.startsWith('git push') || w.startsWith('pkill'),
    )
  for (const c of [
    "bash -s -- a <<'E'\ngit push --force origin main\nE",
    "bash -es -- 1 <<'E'\ngit push -f\nE",
    "bash /dev/stdin <<< 'pkill node'",
    "bash /proc/self/fd/0 <<< 'pkill node'",
    "cat <<'E' | bash /dev/stdin\npkill node\nE",
  ]) {
    expect([c, read(c).length]).toEqual([c, 1])
  }
  // A real script operand is still the file, whose text is what runs.
  expect(withFiles('bash a', { '/s/a': 'pkill node' })).toContain('pkill node')
})

test('a runner hands the command it runs to the guards, one test per runner', () => {
  for (const [c, ran] of [
    ['taskset -c 0 git push --force origin main', 'git push --force origin main'],
    ['taskset 0x3 git push -f', 'git push -f'],
    ['nsenter -t 1 git push -f', 'git push -f'],
    ['firejail git clean -fdx', 'git clean -fdx'],
    ['bwrap --ro-bind / / --dev /dev pkill node', 'pkill node'],
    ['bwrap --overlay-src /a --overlay /rw /work /dest --tmp-overlay /t pkill node', 'pkill node'],
    ['bwrap --argv0 x --symlink /a /b --overlay /rw /work /dest pkill node', 'pkill node'],
    ['systemd-inhibit --why x pkill node', 'pkill node'],
    ['toolbox run git push -f', 'git push -f'],
    ['distrobox enter box -- pkill node', 'pkill node'],
    ['distrobox enter -n box -- pkill node', 'pkill node'],
    ['podman unshare pkill node', 'pkill node'],
    ['screen -dm git reset --hard', 'git reset --hard'],
    ['screen -dmS job git reset --hard', 'git reset --hard'],
    ["fish -c 'git push -f'", 'git push -f'],
    ["tmux new-session -d 'git push --force'", 'git push --force'],
    ["tmux send-keys -t s 'git push -f' Enter", 'git push -f Enter'],
    ["nix-shell --run 'pkill node'", 'pkill node'],
  ] as const) {
    expect([c, argv(c)]).toEqual([c, expect.arrayContaining([ran])])
  }
  // Runners with no command of their own run nothing.
  expect(argv('podman ps')).toEqual(['podman ps'])
})

test('a script the command makes by tee, cp, ln or base64 -d is read as the body it will hold', () => {
  for (const [c, files] of [
    ["tee /s/t.sh <<< 'pkill node' >/dev/null; bash /s/t.sh", {}],
    ["printf 'pkill node\\n' > /s/a.sh; cp /s/a.sh /s/b.sh; bash /s/b.sh", {}],
    ['cp /s/e.sh /s/c.sh; bash /s/c.sh', { '/s/e.sh': 'pkill node' }],
    ['ln -sf /s/e.sh /s/l.sh; bash /s/l.sh', { '/s/e.sh': 'pkill node' }],
    ['cp /s/e.sh /s/c.sh; mv /s/c.sh /s/d.sh; bash /s/d.sh', { '/s/e.sh': 'pkill node' }],
    ['base64 -d <<< cGtpbGwgbm9kZQo= > /s/b.sh; bash /s/b.sh', {}],
    ['cp /s/e.sh /s/f.sh /s/d/; bash /s/d/e.sh', { '/s/e.sh': 'pkill node', '/s/f.sh': 'ls' }],
    ['cp /s/e.sh /s/f.sh /s/d/; bash /s/d/f.sh', { '/s/e.sh': 'ls', '/s/f.sh': 'pkill node' }],
  ] as const) {
    expect([c, withFiles(c, files)]).toEqual([c, expect.arrayContaining(['pkill node'])])
  }
  const unknown = (c: string) => {
    const script = scriptOf(c, parse, undefined, { files: new Map(), cwd: '/s' }) as Script
    commandsOf(script, { cwd: '/s', home: '/h' })
    return [...(script.unknown ?? [])]
  }
  expect(unknown('curl http://x > /s/u.sh; bash /s/u.sh')).toEqual(['/s/u.sh'])
  expect(unknown('cp "$X" /s/u.sh; bash /s/u.sh')).toEqual(['/s/u.sh'])
  expect(unknown('base64 -d /s/in > /s/u.sh; bash /s/u.sh')).toEqual(['/s/u.sh'])
  expect(unknown("printf 'ls\\n' > /s/k.sh; bash /s/k.sh")).toEqual([])
})

test('a compound pipeline stage feeds its written-out output to the next stage', () => {
  expect(argv('(echo git push --force origin main) | sh')).toContain('git push --force origin main')
  expect(argv('{ echo git push --force origin main; } | sh')).toContain(
    'git push --force origin main',
  )
  expect(argv("(printf 'git stash\\n') | sh")).toContain('git stash')
})

test('a $\\U escape past the last code point is no crash', () => {
  expect(ansiC('\\UFFFFFFFF')).toBe('\\UFFFFFFFF')
  expect(ansiC('\\U110000')).toBe('\\U110000')
  expect(ansiC('\\u0061')).toBe('a')
  expect(argv(`echo $'\\UFFFFFFFF'`)).toContain('echo \\UFFFFFFFF')
})

test('a stdout+stderr redirect writes the file as > does', () => {
  for (const op of ['&>', '>&']) {
    expect([op, withFiles(`echo git stash ${op} /s/x.sh; bash /s/x.sh`, {})]).toEqual([
      op,
      expect.arrayContaining(['git stash']),
    ])
  }
  // A descriptor copy names no path to record.
  expect(withFiles('echo git stash >&2; bash /s/x.sh', { '/s/x.sh': 'pkill node' })).toContain(
    'pkill node',
  )
})

test('a redirect with no command truncates the file it names', () => {
  expect(withFiles('> /s/x.sh; bash /s/x.sh', { '/s/x.sh': 'pkill node' })).toEqual([
    '',
    'bash /s/x.sh',
  ])
  expect(withFiles('> /s/x.sh; bash /s/x.sh', {})).not.toContain('pkill node')
})

test('a child shell sees the exported names and its call prefix assignments, not unexported ones', () => {
  expect(argv(`FOO=bar bash -c 'echo $FOO'`)).toContain('echo bar')
  expect(argv(`SECRET=sshhh; bash -c 'echo $SECRET'`)).toContain('echo ?')
  expect(argv(`export FOO=bar; bash -c 'echo $FOO'`)).toContain('echo bar')
  // A prefix assignment reaches only its own process.
  expect(argv(`X=1 bash -c 'echo $X'; bash -c 'echo $X'`)).toEqual(
    expect.arrayContaining(['echo 1', 'echo ?']),
  )
})

test('set -a exports later assignments until +a or +o allexport, and -- stops the flags', () => {
  const env = (c: string) => [...(calls(c).at(-1)?.env ?? [])].map(([k]) => k)
  expect(env('set -a; FOO=bar; echo')).toContain('FOO')
  expect(env('set -a; set +a; FOO=bar; echo')).not.toContain('FOO')
  expect(env('set -a; set +o allexport; FOO=bar; echo')).not.toContain('FOO')
  expect(env('set -o allexport; FOO=bar; echo')).toContain('FOO')
  expect(env('set -- -a; FOO=bar; echo')).not.toContain('FOO')
})

test('parallel with flags and no command runs nothing', () => {
  expect(argv('parallel -j4')).toEqual(['parallel -j4'])
  expect(argv('parallel -j4 -- git push --force')).toContain('git push --force')
  expect(argv('parallel echo ::: a b')).toContain('echo')
})

test('an appended write adds to the recorded body instead of replacing it', async () => {
  const after = (c: string, files: Record<string, string>) => {
    const script = scriptOf(c, parse, undefined, {
      files: new Map(Object.entries(files)),
      cwd: '/s',
    })
    commandsOf(script as Script, { cwd: '/s', home: '/h' })
    return [...((script as Script).files ?? [])]
  }
  expect(after('echo git stash >> /s/x.sh', { '/s/x.sh': 'pkill node\n' })).toEqual([
    ['/s/x.sh', 'pkill node\ngit stash'],
  ])
  expect(after("tee -a /s/a.sh <<< 'git stash'", { '/s/a.sh': 'pkill node\n' })).toEqual([
    ['/s/a.sh', 'pkill node\ngit stash'],
  ])
  // Each write appends once, though the script is walked more than once.
  expect(after(`printf 'a\\n' >> /s/x.sh; printf 'b\\n' >> /s/x.sh`, { '/s/x.sh': '' })).toEqual([
    ['/s/x.sh', 'a\nb\n'],
  ])
  // Appending to a body no one recorded is not a body only the run knows: the file stays unread, so a
  // caller reads it from disk and completes again, and `bash x.sh` then runs both bodies.
  const script = (await scriptOfAsync(
    `printf 'pkill node' >> /s/x.sh; bash /s/x.sh`,
    async (t) => parse(t),
    undefined,
    { files: new Map(), cwd: '/s' },
  )) as Script
  expect(commandsOf(script, { cwd: '/s', home: '/h' }).map((c) => c.name)).toEqual([
    'printf',
    'bash',
  ])
  expect([...(script.unknown ?? [])]).toEqual([])
  script.files = new Map([['/s/x.sh', 'git stash\n']])
  await completeAsync(script, async (t) => parse(t))
  expect(commandsOf(script, { cwd: '/s', home: '/h' }).map((c) => c.argv[0]?.value)).toEqual([
    'printf',
    'bash',
    'git',
    'pkill',
  ])
  // A plain write still replaces.
  expect(after('echo git stash > /s/x.sh', { '/s/x.sh': 'pkill node\n' })).toEqual([
    ['/s/x.sh', 'git stash'],
  ])
})

test('scriptOfAsync takes the same read files and cwd as scriptOf', async () => {
  const script = await scriptOfAsync('bash /s/run.sh', async (t) => parse(t), undefined, {
    files: new Map([['/s/run.sh', 'git push origin main']]),
    cwd: '/s',
  })
  const names = commandsOf(script as Script, { cwd: '/s', home: '/h' }).map((c) =>
    c.argv.map((w) => w.text).join(' '),
  )
  expect(names).toContain('git push origin main')
})

test('an IFS in opts.vars splits a variable only where its value holds that character', () => {
  const echo = (vars: Record<string, string>) =>
    calls('x=hello; echo $x', { cwd: '/s', home: '/h', vars })
      .at(-1)
      ?.argv.map((w) => w.text) ?? []
  expect(echo({ IFS: ' \t\n' })).toEqual(['echo', 'hello'])
  expect(echo({ IFS: ',' })).toEqual(['echo', 'hello'])
  expect(echo({ IFS: '' })).toEqual(['echo', 'hello'])
  // A value holding a character IFS names is several words.
  expect(echo({ IFS: 'l' })).toEqual(['echo', DYN])
  expect(
    calls('IFS=,; x=a,b; echo $x')
      .at(-1)
      ?.argv.map((w) => w.text),
  ).toEqual(['echo', DYN])
})

test('a bash -c script is read as the calls it runs', () => {
  expect(argv("bash -c 'ls /a; cat b'")).toContain('cat b')
})

test('a shell or eval handed an expanded variable runs the value, not the source word', () => {
  const force = `CMD='git push --force origin main'; `
  expect(argv(`${force}bash -c "$CMD"`)).toContain('git push --force origin main')
  expect(argv(`${force}eval "$CMD"`)).toContain('git push --force origin main')
  expect(argv(`FOO=bar; eval echo '$FOO'`)).toContain('echo bar')
})

test('a shell option that takes a file leaves -c to run its command and no rc file', () => {
  expect(argv(`bash --rcfile /etc/bashrc -c 'git stash'`)).toEqual([
    'bash --rcfile /etc/bashrc -c git stash',
    'git stash',
  ])
  expect(withFiles(`bash --rcfile /s/rc.sh -c 'git stash'`, { '/s/rc.sh': 'pkill node' })).toEqual([
    'bash --rcfile /s/rc.sh -c git stash',
    'git stash',
  ])
  expect(withFiles('bash --init-file=/s/rc.sh /s/run.sh', { '/s/run.sh': 'git push' })).toContain(
    'git push',
  )
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

test('a script an env -C wrapper runs resolves its relative paths from that directory', () => {
  const cwdOfRm = (cmd: string) => calls(cmd).find((c) => c.name === 'rm')?.cwd
  expect(cwdOfRm("env -C /d sh -c 'rm x'")).toBe('/d')
  expect(cwdOfRm("env --chdir=/d bash -c 'rm x'")).toBe('/d')
  expect(cwdOfRm("env FOO=1 sh -c 'rm x'")).toBe('/s')
})

test('writesRedirect is true for a file written, false for a descriptor copy or close', () => {
  const writes = (cmd: string) => calls(cmd)[0]?.redirects.map(writesRedirect)
  for (const c of [
    'echo x > f',
    'echo x >> f',
    'echo x >| f',
    'echo x &> f',
    'echo x >& f',
    'echo x 2> f',
    'echo x <> f',
  ]) {
    expect([c, writes(c)]).toEqual([c, [true]])
  }
  for (const c of ['echo x 2>&1', 'echo x >&2', 'echo x >&-', 'echo x 2>&-', 'echo x < f']) {
    expect([c, writes(c)]).toEqual([c, [false]])
  }
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
})

test('npm exec, npx and bunx run the command after their own words, like pnpm exec', () => {
  // The runner keeps a call of its own: a guard reads the package it runs from the call's name and argv
  // (`npx -y pkg@2 stop`), as nomad-hud's supabase, port-killer and npx notes do.
  for (const [c, name] of [
    ['npx prettier', 'npx'],
    ['npx -y supabase@latest stop --no-backup', 'npx'],
    ['npx --yes kill-port@2 4780', 'npx'],
    ['bunx -p some-wrapper kill-port 4780', 'bunx'],
    ['npm exec kill-port 4780', 'npm'],
    ['npm x --package=kill-port kill-port 4780', 'npm'],
  ] as const) {
    expect([c, calls(c).at(0)?.name]).toEqual([c, name])
  }
  // The command after the runner's own words is walked too, so a guard reads it.
  for (const r of ['npm exec', 'npm x', 'npx', 'bunx'] as const) {
    expect([r, argv(`${r} git push --force`)]).toEqual([
      r,
      [`${r} git push --force`, 'git push --force'],
    ])
    expect([r, argv(`${r} -- git push --force`)]).toEqual([
      r,
      [`${r} -- git push --force`, 'git push --force'],
    ])
  }
  // npm's own verbs, and -c which hands its text to a shell, are not the command words.
  expect(argv('npm install')).toEqual(['npm install'])
  expect(argv('npm run build')).toEqual(['npm run build'])
  expect(argv("npx -c 'git push origin main'")).toEqual(
    expect.arrayContaining(['git push origin main']),
  )
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

test('a tmux command runs its shell command detached, except run-shell and if-shell without -b', () => {
  const inner = (command: string) => calls(command).find((c) => c.name === 'sleep')?.background
  expect(inner("tmux new-session -d 'sleep 60'")).toBe(true)
  expect(inner("tmux send-keys -t s 'sleep 60' Enter")).toBe(true)
  expect(inner("tmux run-shell -b 'sleep 60'")).toBe(true)
  expect(inner("tmux run-shell 'sleep 60'")).toBe(false)
  expect(inner("tmux if-shell 'sleep 60'")).toBe(false)
})

test('a repeated walk of one script is served from the last one until an input changes', () => {
  const script = scriptOf('bash ./run.sh; echo done', parse) as Script
  const opts = { cwd: '/w', home: '/h' }
  const first = commandsOf(script, opts)
  expect(commandsOf(script, opts)[0]).toBe(first[0])
  // Another place, or a script file read since, is a fresh walk.
  expect(commandsOf(script, { cwd: '/x', home: '/h' })[0]).not.toBe(first[0])
  script.files = new Map([['/w/run.sh', 'git push origin main\n']])
  script.nested.set('git push origin main\n', parse('git push origin main\n'))
  const after = commandsOf(script, opts).map((c) => c.argv.map((w) => w.text).join(' '))
  expect(after).toContain('git push origin main')
})

test('a file edited in place on one script is walked again though the map keeps its size', () => {
  const script = scriptOf('bash /s/run.sh', parse, undefined, {
    files: new Map([['/s/run.sh', 'echo one']]),
    cwd: '/s',
  }) as Script
  // Both bodies are parsed already, so the nested map does not grow when the file changes.
  script.nested.set('pkill node', parse('pkill node'))
  const opts = { cwd: '/s', home: '/h' }
  expect(commandsOf(script, opts).map((c) => c.name)).toContain('echo')
  script.files?.set('/s/run.sh', 'pkill node')
  const names = commandsOf(script, opts).map((c) => c.name)
  expect(names).toContain('pkill')
  expect(names).not.toContain('echo')
})

test('helpers that each call two earlier helpers are walked inside a bounded number of expansions', () => {
  const fns = Array.from(
    { length: 450 },
    (_, n) => `f${n}() { echo ${n}; ${n > 1 ? `f${n - 1}; f${n >> 1}` : ':'}; }`,
  )
  const started = performance.now()
  const found = argv(`${fns.join('\n')}\nf449`)
  expect(found.length).toBeGreaterThan(60)
  expect(performance.now() - started).toBeLessThan(2000)
})

test('a repeat walk of the same command over the same script files is served from the kept walk, and an edited file is walked again', () => {
  const body = (n: number) =>
    Array.from(
      { length: 300 },
      (_, i) => `h${i}() { echo ${n}; ${i > 1 ? `h${i - 1}; h${i >> 1}` : ':'}; }`,
    ).join('\n')
  const walk = (text: string) => {
    const script = scriptOf('bash /s/x.sh', parse, undefined, {
      files: new Map([['/s/x.sh', text]]),
      cwd: '/s',
    })
    if (!script) {
      throw new Error('unparsed')
    }
    const started = performance.now()
    const found = commandsOf(script, { cwd: '/s', home: '/h' })
    return { found, ms: performance.now() - started }
  }
  const first = walk(`${body(1)}\nh299`)
  const again = walk(`${body(1)}\nh299`)
  expect(first.found.length).toBeGreaterThan(300)
  expect(again.found[0]).toBe(first.found[0])
  expect(again.ms).toBeLessThan(first.ms / 5)
  expect(walk(`${body(2)}\nh299`).found[0]).not.toBe(first.found[0])
})

const spelled = (command: string) =>
  calls(command).map((c) => c.argv.map((w) => w.text.replaceAll(DYN, '?')).join(' '))

test('an unquoted brace list or a variable that splits is words no one can name; quoted ones stay one', () => {
  expect(spelled('{git,stash}')).toEqual(['?'])
  expect(spelled('git {reset,--hard}')).toEqual(['git ?'])
  expect(spelled('echo "{a,b}" \'{a,b}\'')).toEqual(['echo {a,b} {a,b}'])
  expect(spelled("x='/tmp/a /home/u'; rm -rf $x")).toContain('rm -rf /tmp/a /home/u')
  expect(spelled('x="$(echo a b)"; rm -rf $x')).toContain('rm -rf ?')
  expect(spelled('x=\'a b\'; echo "$x"')).toContain('echo a b')
  expect(spelled('IFS=,; x=git,reset,--hard; $x')).toContain('?')
  expect(spelled('x=a; echo $x')).toContain('echo a')
})

test('a local, declare or typeset in a function keeps its value to that call', () => {
  expect(spelled("f() { local IFS=,; }; f; x='git stash'; $x")).toContain('git stash')
  expect(spelled("f() { declare IFS=,; }; f; x='git stash'; $x")).toContain('git stash')
  expect(spelled("f() { typeset -x IFS=,; }; f; x='git stash'; echo $x")).toContain(
    'echo git stash',
  )
  // The caller's own value comes back; inside the call the local one holds.
  expect(spelled('x=a; f() { local x=b; echo $x; }; f; echo $x').slice(-2)).toEqual([
    'echo b',
    'echo a',
  ])
  // -g and a plain assignment reach the caller, as in bash.
  expect(spelled("f() { declare -g IFS=,; }; f; x='git stash'; $x")).toContain('git stash')
  expect(spelled("f() { IFS=,; }; f; x='git stash'; $x")).toContain('git stash')
})

test('env -S takes its script attached, with option letters before it', () => {
  for (const c of [
    'env -S"git reset --hard"',
    "env -vS'git reset --hard'",
    "env -iS'git reset --hard'",
  ]) {
    expect([c, spelled(c).includes('git reset --hard')]).toEqual([c, true])
  }
})

test('env -iS and -vS take the script from the next word', () => {
  for (const c of ["env -iS 'git reset --hard'", "env -vS 'git reset --hard'"]) {
    expect([c, spelled(c).includes('git reset --hard')]).toEqual([c, true])
  }
})

test('watch without -x runs its command words through sh -c', () => {
  expect(spelled("watch 'git reset --hard'")).toContain('git reset --hard')
  expect(spelled("watch -n 1 -- 'git reset --hard'")).toContain('git reset --hard')
  expect(spelled('watch -n 1 date')).not.toContain('git reset --hard')
})

test('mapfile and readarray -C run the callback as shell code', () => {
  for (const c of [
    "mapfile -C 'git reset --hard' -c 1 < /etc/hostname",
    "readarray -C 'git reset --hard' -c 1 < /etc/hostname",
    "mapfile -C'git reset --hard' -c 1 < /etc/hostname",
    "readarray -c1 -C'git reset --hard' < /etc/hostname",
    "mapfile -tC'git reset --hard' a < /etc/hostname",
    "mapfile -tC 'git reset --hard' a < /etc/hostname",
  ]) {
    expect([c, spelled(c).includes('git reset --hard')]).toEqual([c, true])
  }
})

test('an alias ending in a blank expands the next word; a value only the run knows is unknown; hash -p binds a name', () => {
  expect(spelled("alias k='git ' r='reset --hard'\nk r")).toContain('git reset --hard')
  expect(calls('alias x="$(echo git stash)"\nx').at(-1)?.argv[0]?.splits).toBe(true)
  expect(spelled('hash -p /usr/bin/git g; g stash')).toContain('/usr/bin/git stash')
})

test('git-<verb> programs are git with the verb', () => {
  expect(spelled('/usr/libexec/git-core/git-reset --hard')).toEqual(['git reset --hard'])
})

test('text arithmetic, declare, printf -v, read and a @P expansion walk the code they evaluate', () => {
  for (const c of [
    "x='a[$(git stash)]'; echo $((x))",
    "x='a[$(git stash)0]'; (( x ))",
    `x='$(git stash)'; echo \${x@P}`,
    "declare 'a[$(git stash)0]=1'",
    "printf -v 'a[$(git stash)0]' x",
    "read -r 'a[$(git stash)0]'",
    "let 'a[$(git stash)0]'",
    "x='a[$(git stash)0]'; [[ 1 -eq $x ]]",
    "[[ -v 'a[$(git stash)0]' ]]",
    "x='a[$(git stash)0]'; [[ -n y && ( 1 -lt $x ) ]]",
  ]) {
    expect([c, spelled(c).some((l) => l.startsWith('git stash'))]).toEqual([c, true])
  }
  expect(spelled('x=3; echo $((x+1))')).not.toContain('git stash')
})

test('a [[ ]] string comparison or =~ reads its operands as text, not as code', () => {
  for (const c of [
    "x='$(git stash)'; [[ $x == y ]]",
    "re='a|`|b'; [[ y =~ $re ]]",
    "x='$(git stash)'; [[ -n $x ]]",
  ]) {
    expect([c, spelled(c).some((l) => l.startsWith('git stash'))]).toEqual([c, false])
    expect([c, [...sh(c).nested.values()].includes(undefined)]).toEqual([c, false])
  }
})

test('a word the shell splits or brace-expands says so; a quoted or plain one does not', () => {
  const first = (c: string) => calls(c)[0]?.argv[0]?.splits
  expect(first('{git,stash}')).toBe(true)
  expect(first("x='a b'; $x")).toBeUndefined()
  expect(calls('IFS=,; x=a,b; $x').at(-1)?.argv[0]?.splits).toBe(true)
  // A value the walk knows is read as the words it splits into.
  expect(calls("x='a b'; $x")[1]?.argv.map((a) => a.value)).toEqual(['a', 'b'])
  expect(calls('x=\'a b\'; "$x"')[1]?.argv[0]?.splits).toBe(false)
  expect(calls('x=a; $x')[1]?.argv[0]?.splits).toBe(false)
})

test('a Python file run through uv is not read as a shell script', () => {
  const python = 'def f(x):\n    return {x: 1}\n'
  expect(withFiles('uv run --no-project tmp/x.py', { '/s/tmp/x.py': python })).toEqual(['tmp/x.py'])
  expect(withFiles('tmp/x.sh', { '/s/tmp/x.sh': 'git push origin main' })).toContain(
    'git push origin main',
  )
  expect(withFiles('uv run tmp/x.sh', { '/s/tmp/x.sh': 'git push origin main' })).toContain(
    'git push origin main',
  )
})

test('a variable of known value is the command line it holds, a loop variable over literals included', () => {
  const wordsOf = (c: string) => calls(c).map((x) => x.argv.map((a) => a.value))
  expect(wordsOf('P="docker exec -i db psql"; $P -c "select 1"').at(-1)).toEqual([
    'docker',
    'exec',
    '-i',
    'db',
    'psql',
    '-c',
    'select 1',
  ])
  expect(wordsOf('for c in "gate --fuzz" "gate -x"; do $c; done')).toEqual([
    ['gate', '--fuzz'],
    ['gate', '-x'],
  ])
  // An IFS of its own, or a value only the run knows, stays unread.
  expect(calls('IFS=,; x=a,b; $x').at(-1)?.argv[0]?.value).toBeUndefined()
  expect(calls('read P; $P').at(-1)?.argv[0]?.value).toBeUndefined()
})

test('gate -- sh -c "$P" hands the child shell the value P holds; an unknown P stays as written', () => {
  expect(argv(`P='echo hi'; gate -C /x --mem 4G -- sh -c "$P"`)).toContain('echo hi')
  expect(argv(`P='git push'; gate -- sh -c "$P"`)).toContain('git push')
  expect(argv('gate -- sh -c "$P"')).not.toContain('echo hi')
})

test('a function forwards its call site words through "$@" and $1; unknown words stay unknown', () => {
  expect(spelled('f() { "$@"; }; f echo hi')).toContain('echo hi')
  expect(spelled('f() { git -C /x log "$@"; }; f -1')).toContain('git -C /x log -1')
  expect(spelled('f() { git "$1" origin; }; f push')).toContain('git push origin')
  expect(spelled('f() { git "$@"; }; f push origin')).toContain('git push origin')
  expect(spelled('f() { "$@"; }; f "$X"')).toContain('?')
  expect(spelled('f() { "$@"; }; f')).not.toContain('echo hi')
  expect(spelled('f() { sh -c "$1"; }; f "git push"')).toContain('sh -c git push')
})

test('cd under CDPATH, pushd/popd by index and cd - leave the directory unknown; a plain cd still tracks it', () => {
  const cwdOf = (command: string) => calls(command).at(-1)?.cwd
  expect(cwdOf('cd /v/w && CDPATH=/u cd g && rm x')).toBeUndefined()
  expect(cwdOf('cd /v/w && export CDPATH=/u && cd g && rm x')).toBeUndefined()
  expect(cwdOf('pushd /a && pushd /b && pushd +1 && rm x')).toBeUndefined()
  expect(cwdOf('pushd /a && pushd -1 && rm x')).toBeUndefined()
  expect(cwdOf('cd /v/w && cd g && rm x')).toBe('/v/w/g')
  expect(cwdOf('cd /v/w && CDPATH=/u cd ./g && rm x')).toBe('/v/w/g')
  expect(cwdOf('cd /v/w && CDPATH=/u cd /abs && rm x')).toBe('/abs')
})
