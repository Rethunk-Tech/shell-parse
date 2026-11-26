import { expect, test } from 'bun:test'
import { defineAliases } from '../src/shellAlias.ts'
import { type Call, DYN, LAST_JOB, many, one, type Word } from '../src/shellNodes.ts'
import {
  ASSIGN_WORD,
  anyIn,
  assignsOf,
  baseName,
  type Ctx,
  cloneScope,
  gitCommand,
  gitVerb,
  hasShort,
  isLongOpt,
  joinPath,
  nameOf,
  peel,
  range,
  readsStdin,
  redirect,
  scriptFileOf,
  shellFlags,
  srcOf,
  type W,
  word,
} from '../src/shellWords.ts'
import { parse } from './parse.ts'

const wd = (text: string, value: string | undefined = text): Word => ({
  text,
  value,
  expands: value === undefined,
  subst: false,
  start: undefined,
  end: undefined,
  raw: text,
  script: { text, base: undefined },
})

const asCall = (argv: Word[], over: Partial<Call> = {}): Call => ({
  argv,
  name: nameOf(argv[0]),
  wrappers: [],
  assigns: new Map(),
  env: new Map(),
  redirects: [],
  cwd: undefined,
  start: undefined,
  end: undefined,
  subst: false,
  loop: false,
  background: false,
  nested: false,
  stdinArgs: false,
  opaqueStdin: false,
  pipes: [],
  via: undefined,
  file: undefined,
  outer: [],
  ...over,
})

const walk = (text: string, env?: Map<string, string>) => {
  const file = parse(text)
  if (!file) {
    throw new Error(`parse failed: ${text}`)
  }
  const ctx: Ctx = {
    src: srcOf(text, 0),
    scope: {
      env: env ?? new Map(),
      exported: new Set(),
      cwd: '/s',
      funcs: new Map(),
      aliases: new Map(),
    },
    subst: false,
    loop: false,
    background: false,
    nested: false,
    pipes: [],
    redirects: [],
    stdin: undefined,
    depth: 0,
    expanding: new Set(),
    via: undefined,
    file: undefined,
    outer: [],
  }
  const w: W = {
    script: { text, file, nested: new Map(), env: undefined },
    opts: { cwd: '/s', home: '/h', known: (c) => (c.name === 'printf' ? 'out' : undefined) },
    out: { calls: [], missing: new Set(), pipes: 0, expanded: 0 },
    stmts: () => undefined,
    nest: () => undefined,
    stmt: (c, s) => {
      const cmd = one(s, 'Cmd')
      if (cmd?.Type !== 'CallExpr') {
        return
      }
      return asCall(many(cmd, 'Args').map((a) => word(w, c, a)))
    },
  }
  return { w, ctx, file }
}

const argWords = (text: string, env?: Map<string, string>) => {
  const { w, ctx, file } = walk(text, env)
  return many(one(many(file, 'Stmts')[0], 'Cmd'), 'Args').map((a) => word(w, ctx, a))
}

test('joinPath resolves . and ..; a relative path without a base, or a tilde, is unknown', () => {
  const cases: [string | undefined, string][] = [
    ['/a', '/x'],
    ['/a/b', '../x'],
    ['/a', './b/../c'],
    ['/a', '/../x'],
    [undefined, 'x'],
    ['/a', '~/r'],
    ['/a', 'b/c'],
  ]
  expect(cases.map(([base, path]) => [base, path, joinPath(base, path)])).toEqual([
    ['/a', '/x', '/x'],
    ['/a/b', '../x', '/a/x'],
    ['/a', './b/../c', '/a/c'],
    ['/a', '/../x', '/x'],
    [undefined, 'x', undefined],
    ['/a', '~/r', undefined],
    ['/a', 'b/c', '/a/b/c'],
  ])
  expect(baseName('/usr/bin/git')).toBe('git')
  expect(nameOf(wd('/usr/bin/sudo'))).toBe('sudo')
  expect(nameOf(undefined)).toBe('')
  expect(nameOf({ ...wd('$x'), value: undefined })).toBe('')
})

test('peel unwraps wrapper chains, binds env assigns, and leaves command -v alone', () => {
  const names = (words: Word[]) => {
    const p = peel(words)
    return {
      wrappers: p.wrappers.map((x) => x.name),
      argv: p.argv.map((a) => a.text),
      assigns: [...p.assigns],
    }
  }
  expect(names([wd('/usr/bin/sudo'), wd('-u'), wd('x'), wd('git'), wd('push')])).toEqual({
    wrappers: ['sudo'],
    argv: ['git', 'push'],
    assigns: [],
  })
  expect(
    names([
      wd('timeout'),
      wd('-s'),
      wd('KILL'),
      wd('60'),
      wd('nice'),
      wd('-n'),
      wd('5'),
      wd('git'),
    ]),
  ).toEqual({
    wrappers: ['timeout', 'nice'],
    argv: ['git'],
    assigns: [],
  })
  expect(names([wd('env'), wd('-u'), wd('X'), wd('FOO=bar'), wd('git')])).toEqual({
    wrappers: ['env'],
    argv: ['git'],
    assigns: [['FOO', 'bar']],
  })
  expect(names([wd('env'), wd('--'), wd('git')])).toEqual({
    wrappers: ['env'],
    argv: ['git'],
    assigns: [],
  })
  expect(names([wd('flock'), wd('/lock'), wd('git'), wd('push')])).toEqual({
    wrappers: ['flock'],
    argv: ['git', 'push'],
    assigns: [],
  })
  expect(names([wd('command'), wd('-v'), wd('git')])).toEqual({
    wrappers: [],
    argv: ['command', '-v', 'git'],
    assigns: [],
  })
  expect(names([wd('command'), wd('git'), wd('status')])).toEqual({
    wrappers: ['command'],
    argv: ['git', 'status'],
    assigns: [],
  })
  expect(names([wd('exec'), wd('-a'), wd('g'), wd('git')])).toEqual({
    wrappers: ['exec'],
    argv: ['git'],
    assigns: [],
  })
  expect(names([wd('sudo')])).toEqual({ wrappers: [], argv: ['sudo'], assigns: [] })
})

test('gitVerb skips git global options; scriptFileOf names a shell file, not bash -c', () => {
  expect(gitCommand('push')).toBe(true)
  expect(gitCommand('p')).toBe(false)
  expect(gitVerb(asCall([wd('echo')]))).toBeUndefined()
  expect(gitVerb(asCall([wd('git')]))).toEqual({ verb: undefined, at: 1 })
  expect(gitVerb(asCall([wd('rgit'), wd('commit')]))).toEqual({ verb: 'commit', at: 1 })
  expect(
    gitVerb(
      asCall([
        wd('git'),
        wd('-C'),
        wd('/r'),
        wd('-c'),
        wd('x=y'),
        wd('--git-dir'),
        wd('/r/.git'),
        wd('push'),
      ]),
    ),
  ).toEqual({ verb: 'push', at: 7 })
  expect(scriptFileOf(asCall([wd('bash'), wd('run.sh')], { cwd: '/s' }), '/x')).toBe('/s/run.sh')
  expect(scriptFileOf(asCall([wd('bash'), wd('-lc'), wd('echo x')]), '/s')).toBeUndefined()
  expect(scriptFileOf(asCall([wd('source'), wd('./x.sh')], { cwd: '/s' }), undefined)).toBe(
    '/s/x.sh',
  )
  expect(scriptFileOf(asCall([wd('.'), wd('/abs.sh')]), undefined)).toBe('/abs.sh')
  expect(scriptFileOf(asCall([wd('python'), wd('x.sh')]), '/s')).toBeUndefined()
  expect(scriptFileOf(asCall([wd('bash'), wd('-n'), wd('x.sh')]), '/s')).toBeUndefined()
  expect(scriptFileOf(asCall([wd('bash'), wd('-xn'), wd('x.sh')]), '/s')).toBeUndefined()
  expect(scriptFileOf(asCall([wd('bash'), wd('x.sh'), wd('-n')]), '/s')).toBe('/s/x.sh')
  expect(scriptFileOf(asCall([wd('zsh'), wd('-x'), wd('t.sh')], { cwd: '/s' }), undefined)).toBe(
    '/s/t.sh',
  )
})

test('word expands quotes, ANSI-C, tildes, parameters and a known substitution', () => {
  const val = (text: string, env?: Map<string, string>) => argWords(text, env)[1]
  expect(val("echo 'a b'")?.value).toBe('a b')
  expect(val('echo "a b"')?.value).toBe('a b')
  // $'\x70ush' is how a push hides from a regex that reads the source bytes.
  expect(val("echo $'\\x70ush'")?.value).toBe('push')
  expect(val("echo $'\\n'")?.value).toBe('\n')
  expect(val("echo $'\\101'")?.value).toBe('A')
  expect(val("echo $'\\u0061'")?.value).toBe('a')
  expect(val("echo $'\\t'")?.value).toBe('\t')
  expect(val('echo ~/r')?.value).toBe('/h/r')
  expect(val('echo a~/r')?.value).toBe('a~/r')
  expect(val('echo $HOME', new Map([['HOME', '/h']]))?.value).toBe('/h')
  expect(val('echo $MISS')?.value).toBeUndefined()
  expect(val('echo $MISS')?.text).toBe(DYN)
  expect(val('echo $!')?.text).toBe(LAST_JOB)
  expect(val('echo $' + '{HOME:1}', new Map([['HOME', '/h']]))?.text).toBe(DYN)
  expect(val('echo $(printf hi)')?.value).toBe('out')
  expect(val('echo $(git status)')?.text).toBe(DYN)
  expect(val('echo $(printf a; printf b)')?.text).toBe(DYN)
  expect(val('echo <(true)')?.text).toBe(DYN)
  const quoted = val("echo 'git push'")
  expect(quoted?.script).toEqual({ text: 'git push', base: 6 })
  expect(val('echo "git\\$x"')?.script.base).toBeUndefined()
  expect(ASSIGN_WORD.exec('FOO=bar')?.groups).toEqual({ name: 'FOO', value: 'bar' })
  expect(ASSIGN_WORD.test('FOO+=x')).toBe(false)
})

test('redirect captures a here-string and a heredoc; assignsOf binds, appends go dynamic', () => {
  const redir = (text: string) => {
    const { w, ctx, file } = walk(text)
    const n = many(many(file, 'Stmts')[0], 'Redirs')[0]
    if (!n) {
      throw new Error(`no redirect: ${text}`)
    }
    return redirect(w, ctx, n)
  }
  const out = redir('echo x > /tmp/out')
  expect(out.op).toBe('>')
  expect(out.target?.value).toBe('/tmp/out')
  expect(out.body).toBeUndefined()
  expect(redir("cat <<<'hi'").body?.text).toBe('hi')
  const doc = redir('cat <<EOF\nbody\nEOF')
  expect(doc.op).toBe('<<')
  expect(doc.body?.text).toBe('body\n')
  const bound = (text: string) => {
    const { w, ctx, file } = walk(text)
    return [...assignsOf(w, ctx, many(one(many(file, 'Stmts')[0], 'Cmd'), 'Assigns'))]
  }
  expect(bound('FOO=bar echo')).toEqual([['FOO', 'bar']])
  expect(bound('FOO= echo')).toEqual([['FOO', '']])
  expect(bound('FOO+=bar echo')).toEqual([['FOO', DYN]])
  expect(bound('FOO[1]=x')).toEqual([['FOO', DYN]])
  expect(bound('FOO=(a b)')).toEqual([['FOO', DYN]])
  const { w, ctx } = walk('echo')
  expect([...assignsOf(w, ctx, [{ Naked: true, Name: { Value: 'FOO' } }])]).toEqual([])
})

test('range offsets from src.base; cloneScope copies maps; anyIn walks substitutions', () => {
  const text = 'echo hi'
  const { w, ctx, file } = walk(text)
  const cmd = one(many(file, 'Stmts')[0], 'Cmd')
  if (!cmd) {
    throw new Error('no cmd')
  }
  expect(range(ctx, cmd)).toEqual({ raw: 'echo hi', start: 0, end: 7 })
  expect(range({ ...ctx, src: srcOf(text, undefined) }, cmd)).toEqual({
    raw: 'echo hi',
    start: undefined,
    end: undefined,
  })
  expect(range({ ...ctx, src: srcOf(text, 10) }, cmd).start).toBe(10)
  const orig = {
    env: new Map([['A', '1']]),
    exported: new Set(['A']),
    cwd: '/s',
    funcs: new Map(),
    aliases: new Map(),
  }
  const copy = cloneScope(orig)
  copy.env.set('A', '2')
  copy.cwd = '/t'
  expect(orig.env.get('A')).toBe('1')
  expect(orig.cwd).toBe('/s')
  let substs = 0
  w.stmts = () => {
    substs += 1
  }
  anyIn(w, ctx, parse('[[ $(echo a) -eq $(echo b) ]]'))
  expect(substs).toBe(2)
})

test('peel unwraps the remaining wrappers and leaves a lone - as the command', () => {
  const names = (words: Word[]) => {
    const p = peel(words)
    return {
      wrappers: p.wrappers.map((x) => x.name),
      argv: p.argv.map((a) => a.text),
    }
  }
  const wrap = (head: Word[], cmd = [wd('git')]) => names([...head, ...cmd])
  expect(wrap([wd('doas'), wd('-u'), wd('root')])).toEqual({ wrappers: ['doas'], argv: ['git'] })
  expect(wrap([wd('builtin')])).toEqual({ wrappers: ['builtin'], argv: ['git'] })
  expect(wrap([wd('nohup'), wd('-x')])).toEqual({ wrappers: ['nohup'], argv: ['git'] })
  expect(wrap([wd('setsid'), wd('-x')])).toEqual({ wrappers: ['setsid'], argv: ['git'] })
  expect(wrap([wd('ionice'), wd('-c'), wd('3')])).toEqual({ wrappers: ['ionice'], argv: ['git'] })
  expect(wrap([wd('stdbuf'), wd('-o'), wd('0')])).toEqual({ wrappers: ['stdbuf'], argv: ['git'] })
  expect(wrap([wd('time'), wd('-f'), wd('%e')])).toEqual({ wrappers: ['time'], argv: ['git'] })
  expect(wrap([wd('xargs'), wd('-n'), wd('1')])).toEqual({ wrappers: ['xargs'], argv: ['git'] })
  expect(wrap([wd('watch'), wd('-n'), wd('1')])).toEqual({ wrappers: ['watch'], argv: ['git'] })
  expect(wrap([wd('busybox')])).toEqual({ wrappers: ['busybox'], argv: ['git'] })
  expect(wrap([wd('unbuffer')])).toEqual({ wrappers: ['unbuffer'], argv: ['git'] })
  expect(wrap([wd('strace'), wd('-o'), wd('/t')])).toEqual({ wrappers: ['strace'], argv: ['git'] })
  expect(wrap([wd('ltrace'), wd('-o'), wd('/t')])).toEqual({ wrappers: ['ltrace'], argv: ['git'] })
  expect(wrap([wd('valgrind'), wd('-x')])).toEqual({ wrappers: ['valgrind'], argv: ['git'] })
  expect(wrap([wd('unshare'), wd('-x')])).toEqual({ wrappers: ['unshare'], argv: ['git'] })
  expect(wrap([wd('pkexec'), wd('--user'), wd('root')])).toEqual({
    wrappers: ['pkexec'],
    argv: ['git'],
  })
  expect(wrap([wd('setpriv'), wd('-x')])).toEqual({ wrappers: ['setpriv'], argv: ['git'] })
  expect(wrap([wd('chroot'), wd('/jail')])).toEqual({ wrappers: ['chroot'], argv: ['git'] })
  expect(wrap([wd('chrt'), wd('0')])).toEqual({ wrappers: ['chrt'], argv: ['git'] })
  expect(wrap([wd('systemd-run'), wd('-p'), wd('Type=exec'), wd('--unit'), wd('u')])).toEqual({
    wrappers: ['systemd-run'],
    argv: ['git'],
  })
  expect(wrap([wd('nice'), wd('--adjustment'), wd('5')])).toEqual({
    wrappers: ['nice'],
    argv: ['git'],
  })
  expect(wrap([wd('timeout'), wd('--kill-after'), wd('1'), wd('60')])).toEqual({
    wrappers: ['timeout'],
    argv: ['git'],
  })
  expect(wrap([wd('env'), wd('--chdir'), wd('/t')])).toEqual({ wrappers: ['env'], argv: ['git'] })
  expect(wrap([wd('sudo'), wd('-g'), wd('x')])).toEqual({ wrappers: ['sudo'], argv: ['git'] })
  expect(names([wd('sudo'), wd('-'), wd('git')])).toEqual({
    wrappers: ['sudo'],
    argv: ['-', 'git'],
  })
  expect(names([wd('command'), wd('-V'), wd('git')])).toEqual({
    wrappers: [],
    argv: ['command', '-V', 'git'],
  })
  const flag = (name: string, opt: string) => wrap([wd(name), wd(opt), wd('x')])
  for (const [name, opt] of [
    ['sudo', '-h'],
    ['sudo', '-p'],
    ['sudo', '-C'],
    ['sudo', '-D'],
    ['sudo', '-r'],
    ['sudo', '-t'],
    ['sudo', '-U'],
    ['sudo', '-T'],
    ['doas', '-C'],
    ['env', '-C'],
    ['env', '-S'],
    ['env', '--unset'],
    ['env', '--split-string'],
    ['ionice', '-n'],
    ['ionice', '-p'],
    ['ionice', '--class'],
    ['ionice', '--classdata'],
    ['stdbuf', '-i'],
    ['stdbuf', '-e'],
    ['time', '-o'],
    ['time', '--format'],
    ['time', '--output'],
    ['xargs', '-I'],
    ['xargs', '-P'],
    ['xargs', '-d'],
    ['xargs', '-L'],
    ['xargs', '-s'],
    ['xargs', '-a'],
    ['xargs', '-E'],
    ['xargs', '--delimiter'],
    ['watch', '--interval'],
    ['watch', '-q'],
    ['watch', '--equexit'],
    ['strace', '-e'],
    ['strace', '-p'],
    ['strace', '-s'],
    ['strace', '-u'],
    ['strace', '-E'],
    ['strace', '-P'],
    ['strace', '-b'],
    ['strace', '-I'],
    ['ltrace', '-e'],
    ['ltrace', '-p'],
    ['ltrace', '-s'],
    ['ltrace', '-u'],
    ['ltrace', '-n'],
    ['systemd-run', '-u'],
    ['systemd-run', '-E'],
    ['systemd-run', '-M'],
    ['systemd-run', '--property'],
    ['systemd-run', '--setenv'],
    ['systemd-run', '--slice'],
    ['systemd-run', '--machine'],
  ] as const) {
    expect(flag(name, opt)).toEqual({ wrappers: [name], argv: ['git'] })
  }
  expect(wrap([wd('timeout'), wd('-k'), wd('1'), wd('60')])).toEqual({
    wrappers: ['timeout'],
    argv: ['git'],
  })
  expect(wrap([wd('timeout'), wd('--signal'), wd('TERM'), wd('60')])).toEqual({
    wrappers: ['timeout'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('-w'), wd('1'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('--wait'), wd('1'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('--timeout'), wd('1'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('-E'), wd('1'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('--conflict-exit-code'), wd('1'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('-c'), wd('true'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(wrap([wd('flock'), wd('--command'), wd('true'), wd('/lock')])).toEqual({
    wrappers: ['flock'],
    argv: ['git'],
  })
  expect(
    gitVerb(
      asCall([
        wd('git'),
        wd('--work-tree'),
        wd('/r'),
        wd('--namespace'),
        wd('n'),
        wd('--config-env'),
        wd('X'),
        wd('push'),
      ]),
    ),
  ).toEqual({ verb: 'push', at: 7 })
})

test('isLongOpt matches a unique -- prefix; hasShort reads a letter in a group', () => {
  expect(isLongOpt('--hard', 'hard')).toBe(true)
  expect(isLongOpt('--ha', 'hard')).toBe(true)
  expect(isLongOpt('--h', 'hard')).toBe(false)
  expect(isLongOpt('--harder', 'hard')).toBe(false)
  expect(isLongOpt('--hard=foo', 'hard')).toBe(true)
  expect(isLongOpt('-hard', 'hard')).toBe(false)
  expect(hasShort('-fq', 'f')).toBe(true)
  expect(hasShort('-q', 'f')).toBe(false)
  expect(hasShort('-f', 'f')).toBe(true)
  expect(hasShort('--f', 'f')).toBe(false)
  expect(hasShort('-f-x', 'f')).toBe(false)
  expect(hasShort('x-f', 'f')).toBe(false)
})

test('shellFlags, readsStdin, aliases, bash < file and recorded script writes', () => {
  expect(shellFlags([wd('-lc'), wd('echo')])).toEqual({ i: 1, dashC: true, dashS: false })
  expect(shellFlags([wd('-s')])).toEqual({ i: 1, dashC: false, dashS: true })
  expect(shellFlags([wd('-l')])).toEqual({ i: 1, dashC: false, dashS: false })
  expect(shellFlags([wd('-o'), wd('errexit'), wd('script.sh')])).toEqual({
    i: 2,
    dashC: false,
    dashS: false,
  })
  expect(shellFlags([wd('+O'), wd('extdebug'), wd('-c'), wd('x')])).toEqual({
    i: 3,
    dashC: true,
    dashS: false,
  })
  expect(shellFlags([wd('-O'), wd('extdebug'), wd('script.sh')])).toEqual({
    i: 2,
    dashC: false,
    dashS: false,
  })
  expect(shellFlags([wd('+o'), wd('noglob'), wd('script.sh')])).toEqual({
    i: 2,
    dashC: false,
    dashS: false,
  })
  expect(shellFlags([wd('-euo'), wd('pipefail')])).toEqual({ i: 2, dashC: false, dashS: false })
  expect(scriptFileOf(asCall([wd('sh'), wd('-')], { cwd: '/s' }), '/s')).toBeUndefined()
  expect(
    scriptFileOf(asCall([wd('bash'), wd('-euo'), wd('pipefail')], { cwd: '/s' }), '/s'),
  ).toBeUndefined()
  expect(shellFlags([wd('--'), wd('-c')])).toEqual({ i: 1, dashC: false, dashS: false })
  expect(shellFlags([wd('--login'), wd('script.sh')])).toEqual({
    i: 1,
    dashC: false,
    dashS: false,
  })
  expect(shellFlags([wd('script.sh')])).toEqual({ i: 0, dashC: false, dashS: false })
  expect(readsStdin(asCall([wd('at')]), [])).toBe(true)
  expect(readsStdin(asCall([wd('batch')]), [])).toBe(true)
  expect(readsStdin(asCall([wd('source')]), [wd('/dev/stdin')])).toBe(true)
  expect(readsStdin(asCall([wd('.')]), [wd('/dev/fd/0')])).toBe(true)
  expect(readsStdin(asCall([wd('source')]), [wd('/proc/self/fd/0')])).toBe(true)
  expect(readsStdin(asCall([wd('source')]), [wd('/etc/x')])).toBe(false)
  expect(readsStdin(asCall([wd('cat')]), [wd('/dev/stdin')])).toBe(false)
  const scope = {
    env: new Map<string, string>(),
    exported: new Set<string>(),
    cwd: '/s',
    funcs: new Map(),
    aliases: new Map<string, string>(),
  }
  defineAliases(scope, asCall([wd('alias'), wd('ll=ls -l'), wd('gs=git status')]))
  expect(scope.aliases.get('ll')).toBe('ls -l')
  expect(scope.aliases.get('gs')).toBe('git status')
  defineAliases(scope, asCall([wd('echo'), wd('x=y')]))
  expect(scope.aliases.has('x')).toBe(false)
  defineAliases(scope, asCall([wd('alias'), wd('=no'), wd('novalue')]))
  expect(scope.aliases.has('')).toBe(false)
  const fed = (target: string, fd?: string) => ({
    op: '<',
    fd,
    target: wd(target),
    body: undefined,
  })
  expect(scriptFileOf(asCall([wd('bash')], { redirects: [fed('/s/t.sh')] }), '/x')).toBe('/s/t.sh')
  expect(scriptFileOf(asCall([wd('bash')], { redirects: [fed('/s/t.sh', '0')] }), '/x')).toBe(
    '/s/t.sh',
  )
  expect(
    scriptFileOf(asCall([wd('bash')], { redirects: [fed('/s/t.sh', '1')] }), '/x'),
  ).toBeUndefined()
  expect(scriptFileOf(asCall([wd('sh'), wd('t.sh')], { cwd: '/s' }), undefined)).toBe('/s/t.sh')
  expect(scriptFileOf(asCall([wd('dash'), wd('t.sh')], { cwd: '/s' }), undefined)).toBe('/s/t.sh')
  expect(scriptFileOf(asCall([wd('ksh'), wd('t.sh')], { cwd: '/s' }), undefined)).toBe('/s/t.sh')
  expect(scriptFileOf(asCall([wd('mksh'), wd('t.sh')], { cwd: '/s' }), undefined)).toBe('/s/t.sh')
  expect(scriptFileOf(asCall([wd('ash'), wd('t.sh')], { cwd: '/s' }), undefined)).toBe('/s/t.sh')
})
