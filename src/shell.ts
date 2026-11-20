// A Bash command as shfmt (mvdan/sh) parses it, read as the calls a shell would run. No engine imports
// and no spawning: the caller runs `shfmt --to-json` and passes each parse in.

import { runnerPieces } from './runners.ts'
import { markExported, setsAllexport } from './shellExport.ts'
import {
  BODY_LISTS,
  type Call,
  DYN,
  many,
  type Node,
  one,
  opName,
  type Piece,
  pipelineStages,
  type Redirect,
  type Script,
  type ShellEnv,
  str,
  type WalkOptions,
  type Word,
  type Wrapper,
} from './shellNodes.ts'
import {
  anyIn,
  assignsOf,
  type Ctx,
  cloneScope,
  defineAliases,
  gitCommand,
  gitVerb,
  joinPath,
  nameOf,
  peel,
  range,
  readsStdin,
  recordWrittenScript,
  redirect,
  SHELLS,
  scriptFileOf,
  shellFlags,
  srcOf,
  type W,
  word,
} from './shellWords.ts'

const MAX_DEPTH = 8
const MAX_UNROLL = 16
const MAX_PASSES = 6
const NAME = /^[A-Za-z_]\w*$/u
const GLOB = /[*?[{]/u
const ECHO_FLAG = /^-[neE]+$/u
const READ_VALUES = new Set(['-d', '-i', '-n', '-N', '-p', '-t', '-u'])

function stmtsIn(w: W, ctx: Ctx, stmts: Node[]) {
  for (const s of stmts) {
    stmt(w, ctx, s)
  }
}
function stmt(w: W, ctx: Ctx, s: Node): Call | undefined {
  const c = s.Background === true ? { ...ctx, background: true, scope: cloneScope(ctx.scope) } : ctx
  const own = many(s, 'Redirs').map((r) => redirect(w, c, r))
  const cmd = one(s, 'Cmd')
  const inner = { ...c, redirects: [...own, ...c.redirects] }
  if (cmd?.Type === 'CallExpr') {
    return callExpr(w, inner, cmd, own)
  }
  if (cmd) {
    compound(w, inner, cmd)
  } else if (own.length > 0) {
    // `> file` alone still truncates file.
    w.out.calls.push(callOf(inner, { argv: [], wrappers: [] }, new Map(), range(c, s)))
  }
  return
}

const output = (call: Call): Piece | undefined => {
  if (call.name !== 'echo' && call.name !== 'printf') {
    return call.name === 'cat' && call.argv.length === 1
      ? call.redirects.find((r) => r.body)?.body
      : undefined
  }
  const args = call.argv
    .slice(1)
    .filter((a) => !(call.name === 'echo' && ECHO_FLAG.test(a.value ?? '')))
  const [only] = args
  return args.length === 1 && only
    ? only.script
    : { text: args.map((a) => a.script.text).join(' '), base: undefined }
}
const pipeline = (w: W, ctx: Ctx, cmd: Node) => {
  const id = w.out.pipes
  w.out.pipes += 1
  let feed: Piece | undefined
  for (const [stage, s] of pipelineStages(cmd).entries()) {
    const pipes = [...ctx.pipes, { id, stage }]
    const call = stmt(w, { ...ctx, scope: cloneScope(ctx.scope), pipes, stdin: feed }, s)
    feed = call ? output(call) : undefined
  }
}
const ifClause = (w: W, ctx: Ctx, n: Node | undefined) => {
  if (n) {
    stmtsIn(w, ctx, many(n, 'Cond'))
    stmtsIn(w, ctx, many(n, 'Then'))
    ifClause(w, ctx, one(n, 'Else'))
  }
}
// A loop over written-out words runs its body once per word; otherwise the variable is only known at run.
const forClause = (w: W, ctx: Ctx, cmd: Node) => {
  const loop = one(cmd, 'Loop')
  const body = many(cmd, 'Do')
  const name = str(one(loop, 'Name'), 'Value')
  const items = many(loop, 'Items').map((i) => word(w, ctx, i))
  const literal =
    one(loop, 'InPos') !== undefined &&
    items.length > 0 &&
    items.length <= MAX_UNROLL &&
    items.every((i) => i.value !== undefined && !GLOB.test(i.raw))
  // A for body runs again for every word, so a command in it repeats as a loop's does.
  const bodyCtx = { ...ctx, loop: true, bounded: literal && (!ctx.loop || ctx.bounded === true) }
  if (loop?.Type !== 'WordIter' || name === undefined) {
    anyIn(w, ctx, loop)
    stmtsIn(w, bodyCtx, body)
    return
  }
  for (const value of literal ? items.map((i) => i.value ?? DYN) : [DYN]) {
    ctx.scope.env.set(name, value)
    stmtsIn(w, bodyCtx, body)
  }
}
const funcDecl = (w: W, ctx: Ctx, cmd: Node) => {
  const name = str(one(cmd, 'Name'), 'Value') ?? ''
  const body = one(cmd, 'Body')
  if (body) {
    ctx.scope.funcs.set(name, { body, src: ctx.src })
    const expanding = new Set([...ctx.expanding, name])
    stmt(w, { ...ctx, scope: cloneScope(ctx.scope), expanding }, body)
  }
}
const compound = (w: W, ctx: Ctx, cmd: Node) => {
  switch (cmd.Type) {
    case 'BinaryCmd':
      if (opName(cmd) === '|') {
        pipeline(w, ctx, cmd)
      } else {
        stmtsIn(
          w,
          ctx,
          [one(cmd, 'X'), one(cmd, 'Y')].filter((s) => s !== undefined),
        )
      }
      break
    case 'Subshell':
      stmtsIn(w, { ...ctx, scope: cloneScope(ctx.scope) }, many(cmd, 'Stmts'))
      break
    case 'Block':
      stmtsIn(w, ctx, many(cmd, 'Stmts'))
      break
    case 'IfClause':
      ifClause(w, ctx, cmd)
      break
    case 'WhileClause':
      stmtsIn(w, { ...ctx, loop: true, bounded: false }, [...many(cmd, 'Cond'), ...many(cmd, 'Do')])
      break
    case 'ForClause':
      forClause(w, ctx, cmd)
      break
    case 'CaseClause':
      anyIn(w, ctx, one(cmd, 'Word'))
      for (const item of many(cmd, 'Items')) {
        anyIn(w, ctx, item.Patterns)
        stmtsIn(w, ctx, many(item, 'Stmts'))
      }
      break
    case 'FuncDecl':
      funcDecl(w, ctx, cmd)
      break
    case 'TimeClause':
    case 'CoprocClause':
      stmtsIn(
        w,
        ctx,
        [one(cmd, 'Stmt')].filter((s) => s !== undefined),
      )
      break
    case 'DeclClause':
      bindAll(w, ctx, cmd, assignsOf(w, ctx, many(cmd, 'Args')))
      break
    default: {
      // A compound shape not named above still runs the statement lists it holds.
      const bodies = BODY_LISTS.flatMap((key) => many(cmd, key))
      if (bodies.length > 0) {
        stmtsIn(w, ctx, bodies)
      } else {
        anyIn(w, ctx, cmd)
      }
    }
  }
}

const bindAll = (w: W, ctx: Ctx, n: Node, assigns: Map<string, string>): undefined => {
  for (const [k, v] of assigns) {
    ctx.scope.env.set(k, v)
  }
  markExported(w, ctx, n, assigns.keys())
  w.out.calls.push(callOf(ctx, { argv: [], wrappers: [] }, assigns, range(ctx, n)))
}
const callOf = (
  ctx: Ctx,
  { argv, wrappers }: { argv: Word[]; wrappers: Wrapper[] },
  assigns: Map<string, string>,
  r: { start: number | undefined; end: number | undefined },
): Call => ({
  argv,
  name: nameOf(argv[0]),
  wrappers,
  assigns,
  env: new Map([...[...ctx.scope.env].filter(([k]) => ctx.scope.exported.has(k)), ...assigns]),
  redirects: ctx.redirects,
  cwd: ctx.scope.cwd,
  start: r.start,
  end: r.end,
  subst: ctx.subst,
  loop: ctx.loop,
  bounded: ctx.loop && ctx.bounded === true,
  background: ctx.background,
  nested: ctx.nested,
  stdinArgs: wrappers.some((x) => x.name === 'xargs') || ctx.outer.includes('xargs'),
  pipes: ctx.pipes,
  via: ctx.via,
  file: ctx.file,
  outer: ctx.outer,
})
const callExpr = (w: W, ctx: Ctx, cmd: Node, own: Redirect[]) => {
  const assigns = assignsOf(w, ctx, many(cmd, 'Assigns'))
  const words = many(cmd, 'Args').map((a) => word(w, ctx, a))
  if (words.length === 0) {
    return bindAll(w, ctx, cmd, assigns)
  }
  const peeled = peel(words)
  for (const [k, v] of peeled.assigns) {
    assigns.set(k, v)
  }
  const call = callOf(ctx, peeled, assigns, range(ctx, cmd))
  w.out.calls.push(call)
  recordWrittenScript(w, call, output(call))
  builtin(w, ctx, call)
  defineAliases(ctx.scope, call)
  const script = scriptRun(w, call, own, ctx)
  const outer = [...ctx.outer, ...call.wrappers.map((x) => x.name)]
  if (script) {
    nest(w, ctx, script, { sameShell: call.name === 'eval', via: ctx.via, outer })
  }
  for (const piece of runnerPieces(call)) {
    nest(w, ctx, piece, { sameShell: false, via: call.name, outer })
  }
  expand(w, ctx, call, words[0])
  gitAlias(w, ctx, call)
  return call
}

// What cd, read and unset change for the rest of the command.
const builtin = (w: W, ctx: Ctx, call: Call) => {
  const args = call.argv.slice(1)
  if (call.name === 'cd' || call.name === 'pushd') {
    const [target] = args.filter((a) => !(a.value?.startsWith('-') && a.value !== '-'))
    const value = target ? target.value : w.opts.home
    ctx.scope.cwd =
      value === undefined || value === '-' ? undefined : joinPath(ctx.scope.cwd, value)
  } else if (call.name === 'popd') {
    ctx.scope.cwd = undefined
  } else if (call.name === 'read' || call.name === 'mapfile' || call.name === 'readarray') {
    for (const [i, a] of args.entries()) {
      const before = args[i - 1]?.value ?? ''
      if (a.value !== undefined && NAME.test(a.value) && !READ_VALUES.has(before)) {
        ctx.scope.env.set(a.value, DYN)
      }
    }
  } else if (call.name === 'set' && setsAllexport(args.map((a) => a.value))) {
    ctx.scope.allexport = true
  } else if (call.name === 'unset') {
    for (const a of args) {
      ctx.scope.env.delete(a.value ?? '')
      ctx.scope.exported.delete(a.value ?? '')
    }
  }
}
// The script a shell call runs: its -c string, a script file read from disk, else what it reads on
// stdin; eval's arguments.
const scriptRun = (w: W, call: Call, own: Redirect[], ctx: Ctx): Piece | undefined => {
  const file = scriptFileOf(call, w.opts.cwd)
  const read = file === undefined ? undefined : w.script.files?.get(file)
  if (read !== undefined) {
    return { text: read, base: undefined, file }
  }
  const args = call.argv.slice(1)
  if (call.name === 'eval') {
    const [only] = args
    return args.length === 1 && only
      ? only.script
      : { text: args.map((a) => a.raw).join(' '), base: undefined }
  }
  const stdinBody = () =>
    own.find((r) => r.body && (r.fd === undefined || r.fd === '0'))?.body ?? ctx.stdin
  if (readsStdin(call, args)) {
    return stdinBody()
  }
  if (!SHELLS.has(call.name)) {
    return
  }
  const { i, dashC, dashS } = shellFlags(args)
  if (dashC) {
    return args[i]?.script
  }
  // A lone `-` reads the script from stdin, like -s.
  return dashS || i >= args.length || args[i]?.value === '-' ? stdinBody() : undefined
}
const nest = (
  w: W,
  ctx: Ctx,
  piece: Piece,
  {
    sameShell,
    via,
    outer = ctx.outer,
  }: { sameShell: boolean; via: string | undefined; outer?: readonly string[] },
) => {
  if (ctx.depth >= MAX_DEPTH) {
    return
  }
  if (!w.script.nested.has(piece.text)) {
    w.out.missing.add(piece.text)
    return
  }
  const file = w.script.nested.get(piece.text)
  const scope = sameShell ? ctx.scope : cloneScope(ctx.scope)
  const inner = {
    ...ctx,
    src: srcOf(piece.text, piece.base),
    depth: ctx.depth + 1,
    scope,
    via,
    outer,
    file: piece.file ?? ctx.file,
  }
  stmtsIn(w, { ...inner, nested: true, stdin: undefined, redirects: [] }, many(file, 'Stmts'))
}
// A call to an alias or a function runs what it stands for: a function's body, an alias's words.
const expand = (w: W, ctx: Ctx, call: Call, first: Word | undefined) => {
  const name = first?.value
  if (call.wrappers.length > 0 || name === undefined || ctx.expanding.has(name)) {
    return
  }
  const deeper = { ...ctx, expanding: new Set([...ctx.expanding, name]), via: name }
  const alias =
    first?.raw === name
      ? (ctx.scope.aliases.get(name) ?? w.script.env?.aliases.get(name))
      : undefined
  const fn = ctx.scope.funcs.get(name)
  const shared = w.script.env?.functions.get(name)
  if (alias !== undefined) {
    const rest = call.argv.slice(1).map((a) => a.raw)
    nest(
      w,
      deeper,
      { text: [alias, ...rest].join(' '), base: undefined },
      { sameShell: true, via: name },
    )
  } else if (fn && ctx.depth < MAX_DEPTH) {
    stmt(w, { ...deeper, src: { ...fn.src, base: undefined }, depth: ctx.depth + 1 }, fn.body)
  } else if (shared && ctx.depth < MAX_DEPTH) {
    stmt(w, { ...deeper, src: srcOf(shared.text, undefined), depth: ctx.depth + 1 }, shared.body)
  }
}

// A git alias runs its expansion: git with the alias's words, or a shell (`!`) with its script.
export const SHELL_ALIAS = 'git !'
const INLINE_ALIAS = /^alias\.(?<name>[^=]+)=(?<value>.*)$/su
const gitAlias = (w: W, ctx: Ctx, call: Call) => {
  const verb = gitVerb(call)
  const name = verb?.verb
  if (!verb || name === undefined || gitCommand(name) || ctx.expanding.has(`git ${name}`)) {
    return
  }
  const globals = call.argv.slice(0, verb.at)
  const inline = globals
    .map((g) => INLINE_ALIAS.exec(g.value ?? '')?.groups)
    .find((g) => g?.name === name)?.value
  const value = inline ?? w.script.env?.gitAliases?.get(name)
  if (value === undefined) {
    return
  }
  const rest = call.argv.slice(verb.at + 1).map((a) => a.raw)
  const deeper = { ...ctx, expanding: new Set([...ctx.expanding, `git ${name}`]) }
  const shell = value.startsWith('!')
  const text = shell
    ? [value.slice(1), ...rest].join(' ')
    : [...globals.map((g) => g.raw), value, ...rest].join(' ')
  const via = shell ? `${SHELL_ALIAS}${name}` : `git ${name}`
  nest(w, deeper, { text, base: undefined }, { sameShell: !shell, via })
}

const walkScript = (script: Script, opts: WalkOptions) => {
  const w: W = {
    script,
    opts,
    out: { calls: [], missing: new Set(), pipes: 0 },
    stmts: (ctx, stmts) => stmtsIn(w, ctx, stmts),
    stmt: (ctx, s) => stmt(w, ctx, s),
  }
  const env = new Map(Object.entries(opts.vars ?? {}))
  if (opts.home !== undefined && !env.has('HOME')) {
    env.set('HOME', opts.home)
  }
  const exported = new Set(env.keys())
  stmtsIn(
    w,
    {
      src: srcOf(script.text, 0),
      scope: { env, exported, cwd: opts.cwd, funcs: new Map(), aliases: new Map() },
      subst: false,
      loop: false,
      background: false,
      nested: false,
      pipes: [],
      redirects: [],
      stdin: undefined,
      depth: 0,
      expanding: new Set(),
      outer: [],
      via: undefined,
      file: undefined,
    },
    many(script.file, 'Stmts'),
  )
  return w.out
}

// Every call the command would run, in order: inside substitutions, subshells, loops, conditionals,
// functions, pipelines and the scripts it hands a shell.
export const commandsOf = (script: Script, opts: WalkOptions = {}) => walkScript(script, opts).calls

type Parse = (text: string) => Node | undefined
// Parse every script a parsed command runs that is not parsed yet, a few levels down: the loop yields each
// script text it needs parsed and takes its parse back, so one loop serves a sync and an async parser.
function* completing(script: Script): Generator<string, Script, Node | undefined> {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const missing = walkScript(script, { cwd: script.cwd }).missing
    for (const t of missing) {
      script.nested.set(t, yield t)
    }
    if (missing.size === 0) {
      return script
    }
  }
  // Past the pass cap the rest is unreadable, which the guards treat as unparsed rather than clean.
  for (const t of walkScript(script, { cwd: script.cwd }).missing) {
    script.nested.set(t, undefined)
  }
  return script
}
const complete = (script: Script, parse: Parse) => {
  const run = completing(script)
  let step = run.next()
  while (!step.done) {
    step = run.next(parse(step.value))
  }
  return step.value
}
export const completeAsync = async (
  script: Script,
  parse: (text: string) => Promise<Node | undefined>,
) => {
  const run = completing(script)
  let step = run.next()
  while (!step.done) {
    step = run.next(await parse(step.value))
  }
  return step.value
}
// Parse a command and every script it runs.
export const scriptOf = (
  text: string,
  parse: Parse,
  env?: ShellEnv,
  read?: { files: Map<string, string>; cwd?: string },
): Script | undefined => {
  const file = parse(text)
  return file
    ? complete({ text, file, nested: new Map(), env, files: read?.files, cwd: read?.cwd }, parse)
    : undefined
}
export const scriptOfAsync = async (
  text: string,
  parse: (text: string) => Promise<Node | undefined>,
  env?: ShellEnv,
): Promise<Script | undefined> => {
  const file = await parse(text)
  return file ? completeAsync({ text, file, nested: new Map(), env }, parse) : undefined
}
