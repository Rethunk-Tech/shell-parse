// What a shell makes of the words of a command: quotes, escapes, variables, substitutions, redirects
// and the wrappers that run another command. No engine imports.

import { ansiC } from './ansi.ts'
import { evaluated, evaluatedClause } from './shellEval.ts'
import { knownFields, splits } from './shellFields.ts'
import {
  type Call,
  charIndex,
  DYN,
  LAST_JOB,
  many,
  type Node,
  one,
  opName,
  type Piece,
  type Pipe,
  type Redirect,
  type Script,
  spanOf,
  str,
  type WalkOptions,
  type Word,
  type Wrapper,
  walkNodes,
} from './shellNodes.ts'
import { hasShellFlag, WRAPPERS, type WrapperSpec } from './wrappers.ts'

interface Src {
  text: string
  at: (byte: number) => number
  base: number | undefined
}
export interface Scope {
  env: Map<string, string>
  exported: Set<string>
  // set -a: every later assignment is exported.
  allexport?: boolean
  cwd: string | undefined
  funcs: Map<string, { body: Node; src: Src }>
  aliases: Map<string, string>
}
export interface Ctx {
  src: Src
  scope: Scope
  subst: boolean
  loop: boolean
  // Every loop around the call runs over a list of words written in the command: a fixed repeat count.
  bounded?: boolean
  background: boolean
  nested: boolean
  pipes: Pipe[]
  redirects: Redirect[]
  stdin: Piece | undefined
  depth: number
  expanding: ReadonlySet<string>
  via: string | undefined
  file: string | undefined
  // The wrappers (systemd-run, sudo, ...) of the calls whose scripts hold this one.
  outer: readonly string[]
}
// One walk's state, and the statement walkers words call back into for their substitutions.
export interface W {
  script: Script
  opts: WalkOptions
  out: { calls: Call[]; missing: Set<string>; pipes: number; expanded: number }
  stmts: (ctx: Ctx, stmts: Node[]) => void
  stmt: (ctx: Ctx, s: Node) => Call | undefined
  // Walks text a shell would evaluate as code.
  nest: (ctx: Ctx, text: string) => void
}
interface Val {
  text: string
  expands: boolean
  subst: boolean
  // The word is several words once the shell splits or brace-expands it.
  splits?: boolean
  // What a variable of known value splits into at the default IFS: a command line the walk can read.
  fields?: string[]
}

const LINE_CONT = /\\\n/gu
const BARE_ESC = /\\(.)/gsu
const QUOTED_ESC = /\\([$`"\\])/gu
export const ASSIGN_WORD = /^(?<name>[A-Za-z_]\w*)=(?<value>.*)$/su
// An unquoted brace list or range expands to several words before the command runs.
const BRACE = /(?<!\$)\{[^{}]*(?:,|\.\.)[^{}]*\}/u
const EVALUATING = new Set(['ArithmCmd', 'LetClause', 'TestClause'])
const PROMPT_EXPANSION = 84
const COMPLEX_PARAM = ['Exp', 'Index', 'Length', 'Excl', 'Repl', 'Slice', 'Names', 'Width']
const LOOKUP = /^-[vV]/u
export const srcOf = (text: string, base: number | undefined): Src => ({
  text,
  at: charIndex(text),
  base,
})
export const cloneScope = (s: Scope): Scope => ({
  env: new Map(s.env),
  exported: new Set(s.exported),
  allexport: s.allexport,
  cwd: s.cwd,
  funcs: new Map(s.funcs),
  aliases: new Map(s.aliases),
})
export const range = (ctx: Ctx, n: Node) => {
  const { start, end } = spanOf(ctx.src.at, n)
  const base = ctx.src.base
  const pos = (i: number) => (base === undefined ? undefined : base + i)
  return { raw: ctx.src.text.slice(start, end), start: pos(start), end: pos(end) }
}
// git's option parser takes any unambiguous prefix of a long option (`--ha` is `--hard`), at least two
// characters of the name; `=value` is not part of the option.
const MIN_ABBREVIATION = 4
export const isLongOpt = (arg: string, name: string) => {
  const given = arg.split('=')[0] ?? ''
  return given.length >= MIN_ABBREVIATION && given.startsWith('--') && `--${name}`.startsWith(given)
}
// A short-option group (`-fq`) that holds one of `letters`.
const SHORT_GROUP = /^-[a-zA-Z]+$/u
export const hasShort = (arg: string, letters: string) =>
  SHORT_GROUP.test(arg) && [...arg.slice(1)].some((l) => letters.includes(l))
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const nameOf = (w: Word | undefined) => (w?.value === undefined ? '' : baseName(w.value))

// A path with `.` and `..` resolved, as the kernel walks it.
const normalize = (path: string) => {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '..') {
      parts.pop()
    } else if (p !== '' && p !== '.') {
      parts.push(p)
    }
  }
  return `/${parts.join('/')}`
}
export const joinPath = (base: string | undefined, path: string) => {
  if (path.startsWith('/')) {
    return normalize(path)
  }
  return base === undefined || path.startsWith('~') ? undefined : normalize(`${base}/${path}`)
}

const lit = (text: string): Val => ({ text, expands: false, subst: false })
const dyn = (subst: boolean): Val => ({ text: DYN, expands: true, subst })
const joined = (vals: Val[]): Val => ({
  text: vals.map((v) => v.text).join(''),
  expands: vals.some((v) => v.expands),
  subst: vals.some((v) => v.subst),
  splits: vals.some((v) => v.splits),
  fields: vals.length === 1 ? vals[0]?.fields : undefined,
})
const substCtx = (ctx: Ctx): Ctx => ({
  ...ctx,
  scope: cloneScope(ctx.scope),
  subst: true,
  pipes: [],
  stdin: undefined,
  redirects: [],
})

// Substitutions anywhere under a node no other rule reads (a test, arithmetic, a case pattern).
export const anyIn = (w: W, ctx: Ctx, n: unknown) =>
  walkNodes(n, (node) => {
    if (EVALUATING.has(String(node.Type))) {
      evaluatedClause(w, ctx, node)
    }
    const subst = node.Type === 'CmdSubst' || node.Type === 'ProcSubst'
    if (subst) {
      w.stmts(substCtx(ctx), many(node, 'Stmts'))
    }
    return subst
  })

const tilde = (w: W, text: string) => {
  const home = w.opts.home
  return home !== undefined && (text === '~' || text.startsWith('~/')) ? home + text.slice(1) : text
}
// `${BASH_SOURCE[0]}` is the script's own path, like $0 and $BASH_SOURCE.
const isSourceZero = (p: Node) => {
  const parts = many(one(p, 'Index'), 'Parts')
  return (
    str(one(p, 'Param'), 'Value') === 'BASH_SOURCE' &&
    parts.length === 1 &&
    str(parts[0], 'Value') === '0' &&
    !COMPLEX_PARAM.some((k) => k !== 'Index' && Boolean(p[k]))
  )
}
// Text that arithmetic, a test, a declared name or `${x@P}` evaluates runs the `$(...)` it holds, even
// when it sits in single quotes or in a variable.
const param = (w: W, ctx: Ctx, p: Node, quoted: boolean): Val => {
  const exp = one(p, 'Exp')
  if (exp?.Op === PROMPT_EXPANSION && str(many(one(exp, 'Word'), 'Parts')[0], 'Value') === 'P') {
    evaluated(w, ctx, { Type: 'ParamExp', Param: one(p, 'Param') })
  }
  if (!isSourceZero(p) && COMPLEX_PARAM.some((k) => Boolean(p[k]))) {
    anyIn(w, ctx, p)
    return dyn(false)
  }
  const name = isSourceZero(p) ? 'BASH_SOURCE' : (str(one(p, 'Param'), 'Value') ?? '')
  const text = name === '!' ? LAST_JOB : (ctx.scope.env.get(name) ?? DYN)
  // An unquoted variable splits into words at the IFS in effect.
  const ifs = ctx.scope.env.get('IFS')
  if (!quoted && splits(text, ifs)) {
    return { ...dyn(false), splits: true, fields: knownFields(text, ifs) }
  }
  return { text, expands: true, subst: false }
}
const cmdSubst = (w: W, ctx: Ctx, p: Node): Val => {
  const stmts = many(p, 'Stmts')
  const inner = substCtx(ctx)
  const [only] = stmts
  if (
    !only ||
    stmts.length > 1 ||
    one(only, 'Cmd')?.Type !== 'CallExpr' ||
    many(only, 'Redirs').length > 0
  ) {
    w.stmts(inner, stmts)
    return dyn(true)
  }
  const call = w.stmt(inner, only)
  return { text: (call && w.opts.known?.(call)) ?? DYN, expands: true, subst: true }
}
const partValue = (w: W, ctx: Ctx, p: Node, at: { quoted: boolean; lead: boolean }): Val => {
  const { quoted, lead } = at
  switch (p.Type) {
    case 'Lit': {
      const v = (str(p, 'Value') ?? '').replace(LINE_CONT, '')
      if (quoted) {
        return lit(v.replace(QUOTED_ESC, '$1'))
      }
      if (BRACE.test(v)) {
        return { ...dyn(false), splits: true }
      }
      const bare = v.replace(BARE_ESC, '$1')
      return lit(lead && v.startsWith('~') ? tilde(w, bare) : bare)
    }
    case 'SglQuoted':
      return lit(p.Dollar === true ? ansiC(str(p, 'Value') ?? '') : (str(p, 'Value') ?? ''))
    case 'DblQuoted':
      return joined(
        many(p, 'Parts').map((q) => partValue(w, ctx, q, { quoted: true, lead: false })),
      )
    case 'ParamExp':
      return param(w, ctx, p, quoted)
    case 'CmdSubst':
      return cmdSubst(w, ctx, p)
    case 'ProcSubst':
      w.stmts(substCtx(ctx), many(p, 'Stmts'))
      return dyn(true)
    default:
      if (p.Type === 'ArithmExp') {
        evaluated(w, ctx, p)
      }
      anyIn(w, ctx, p)
      return dyn(false)
  }
}
// The script a word holds when a shell runs it, and where it sits when its bytes are the script's own.
const pieceOf = (parts: Node[], v: Val, r: ReturnType<typeof range>): Piece => {
  const [only] = parts
  const inside = r.start === undefined ? undefined : r.start + 1
  if (parts.length === 1 && only?.Type === 'SglQuoted' && only.Dollar !== true) {
    return { text: str(only, 'Value') ?? '', base: inside }
  }
  if (parts.length === 1 && only?.Type === 'DblQuoted') {
    const text = r.raw.slice(1, -1)
    // A word holding a variable hands the shell the value it holds, not the source bytes: it has no base.
    const escaped = text.includes('\\')
    const shown = escaped ? text.replace(LINE_CONT, '').replace(QUOTED_ESC, '$1') : text
    return v.expands && !v.text.includes(DYN)
      ? { text: v.text, base: undefined }
      : { text: shown, base: escaped ? undefined : inside }
  }
  if (parts.every((p) => p.Type === 'Lit') && !r.raw.includes('\\')) {
    return { text: r.raw, base: r.start }
  }
  return { text: v.text.includes(DYN) ? r.raw : v.text, base: undefined }
}
export const word = (w: W, ctx: Ctx, n: Node): Word => {
  const parts = many(n, 'Parts')
  const v = joined(parts.map((p, i) => partValue(w, ctx, p, { quoted: false, lead: i === 0 })))
  const r = range(ctx, n)
  return {
    ...v,
    value: v.text.includes(DYN) ? undefined : v.text,
    start: r.start,
    end: r.end,
    raw: r.raw,
    script: pieceOf(parts, v, r),
  }
}

export const redirect = (w: W, ctx: Ctx, n: Node): Redirect => {
  const op = opName(n)
  const target = one(n, 'Word')
  const word_ = target ? word(w, ctx, target) : undefined
  const hdoc = one(n, 'Hdoc')
  let body: Piece | undefined
  if (op === '<<<') {
    body = word_?.script
  } else if (hdoc) {
    anyIn(w, ctx, hdoc)
    const r = range(ctx, hdoc)
    const delim = word_?.text ?? ''
    body = {
      text: r.raw.endsWith(delim) ? r.raw.slice(0, -delim.length || undefined) : r.raw,
      base: r.start,
    }
  } else if (op === '<<' || op === '<<-') {
    body = { text: '', base: undefined }
  }
  return { op, fd: str(one(n, 'N'), 'Value'), target: word_, body }
}
export const assignsOf = (w: W, ctx: Ctx, nodes: Node[]) => {
  const bound = new Map<string, string>()
  for (const a of nodes) {
    const name = str(one(a, 'Name'), 'Value')
    const value = one(a, 'Value')
    if (name === undefined || a.Naked === true) {
      continue
    }
    if (a.Append === true || one(a, 'Array') || one(a, 'Index')) {
      anyIn(w, ctx, a)
      bound.set(name, DYN)
    } else {
      bound.set(name, value ? word(w, ctx, value).text : '')
    }
  }
  return bound
}

const skipOptions = (
  words: Word[],
  from: number,
  { values, pairs = [], triples = [] }: Pick<WrapperSpec, 'values' | 'pairs' | 'triples'>,
  env?: Map<string, string>,
) => {
  let j = from
  while (j < words.length) {
    const word_ = words[j]
    const assign = env && ASSIGN_WORD.exec(word_?.text ?? '')?.groups
    const v = word_?.value
    if (assign) {
      env.set(assign.name ?? '', assign.value ?? '')
    } else if (v === '--') {
      return j + 1
    } else if (v === undefined || !v.startsWith('-') || v === '-') {
      return j
    }
    const named = v ?? ''
    let extra = Number(values.includes(named))
    if (pairs.includes(named)) {
      extra = 2
    } else if (triples.includes(named)) {
      extra = 3
    }
    j += 1 + extra
  }
  return j
}
// The command a wrapper chain (sudo, env, timeout, xargs, ...) finally runs, and the wrappers.
// A tool word: `node@20`, `npm:prettier@latest`.
const TOOL_WORD = /^[^-\s][^\s@]*@\S+$/u
// Where a wrapper's own words end and its command starts, or -1 when it runs none.
const commandAt = (words: Word[], at: number, spec: WrapperSpec, env?: Map<string, string>) => {
  const start = at + 1
  // A wrapper whose -c hands its text to a shell runs no command of its own.
  if (spec.shell && hasShellFlag(words, start)) {
    return -1
  }
  let from = start
  if (spec.sub !== undefined) {
    let sub = skipOptions(words, start, spec)
    if (spec.workspace && words[sub]?.value === 'workspace') {
      sub = skipOptions(words, sub + 2, spec)
    }
    const named = words[sub]?.value
    if (named !== spec.sub && (spec.alias === undefined || named !== spec.alias)) {
      return -1
    }
    from = sub + 1
  }
  let end = skipOptions(words, from, spec, env)
  const first = end
  while (spec.tools && TOOL_WORD.test(words[end]?.value ?? '')) {
    end += 1
  }
  if (words[end]?.value === '--' && end > first) {
    return end + 1
  }
  // With no tool word named, a `--` further on may follow a bare tool name (`mise exec node -- cmd`).
  const dashes =
    spec.dashes && end === first ? words.findIndex((w, k) => k >= from && w.value === '--') : -1
  const named = words
    .slice(from, first)
    .some((x) => spec.leadUnless?.includes(x.value ?? '') ?? false)
  return dashes >= 0 ? dashes + 1 : end + (named ? 0 : (spec.lead ?? 0))
}
export const peel = (words: Word[]) => {
  const wrappers: Wrapper[] = []
  const assigns = new Map<string, string>()
  let i = 0
  while (i < words.length) {
    const name = nameOf(words[i])
    const spec = WRAPPERS.get(name)
    if (!spec || (name === 'command' && LOOKUP.test(words[i + 1]?.value ?? ''))) {
      break
    }
    const env = name === 'env' ? assigns : undefined
    const j = commandAt(words, i, spec, env)
    if (j < 0 || j >= words.length) {
      break
    }
    wrappers.push({ name, words: words.slice(i, j) })
    i = j
  }
  return { wrappers, argv: words.slice(i), assigns }
}

// git's own subcommands, which no alias can shadow: anything else may be an alias worth looking up.
const GIT_COMMANDS = new Set(
  'add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry cherry-pick clean clone commit config describe diff diff-files diff-index diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree maintenance merge merge-base merge-tree mergetool mv notes prune pull push range-diff rebase reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit verify-tag version whatchanged worktree write-tree'.split(
    ' ',
  ),
)
export const gitCommand = (verb: string) => GIT_COMMANDS.has(verb)
// git's subcommand, past its global options.
const GIT_VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
])
const RGIT_VALUE_OPTS = new Set(['-C'])
export const gitVerb = (call: Call) => {
  if (call.name !== 'git' && call.name !== 'rgit') {
    return
  }
  // rgit's globals are `--json` and `-C DIR`; git's are GIT_VALUE_OPTS.
  const valueOpts = call.name === 'git' ? GIT_VALUE_OPTS : RGIT_VALUE_OPTS
  let at = 1
  while (at < call.argv.length) {
    const v = call.argv[at]?.value
    if (v === undefined || !v.startsWith('-')) {
      return { verb: v, at }
    }
    at += valueOpts.has(v) ? 2 : 1
  }
  return { verb: undefined, at }
}

const SHELL_FLAG = /^(?:[-+][A-Za-z]+|--.*)$/u
// Options whose value is the next word: `--rcfile FILE`, and a short cluster ending in o or O (`-o errexit`, `-euo pipefail`).
const SET_OPTION = /^(?:--rcfile|--init-file|[-+][A-Za-z]*[oO])$/u
const STDIN_FILES = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
// A shell's leading flags: where its operands start, and whether they said -c or -s.
export const shellFlags = (args: Word[]) => {
  let i = 0
  let dashC = false
  let dashS = false
  while (i < args.length && SHELL_FLAG.test(args[i]?.value ?? '')) {
    const v = args[i]?.value ?? ''
    i += SET_OPTION.test(v) ? 2 : 1
    if (v === '--') {
      break
    }
    // A short group says -c or -s; a long option never does.
    const short = v.startsWith('-') && !v.startsWith('--')
    dashC ||= short && v.includes('c')
    dashS ||= short && v.includes('s')
  }
  // `bash /dev/stdin` reads the commands it is fed, as -s does.
  return { i, dashC, dashS: dashS || STDIN_FILES.has(args[i]?.value ?? '') }
} // at and batch queue the commands they read on stdin; `source /dev/stdin` runs them now.
export const readsStdin = (call: Call, args: Word[]) =>
  call.name === 'at' ||
  call.name === 'batch' ||
  ((call.name === 'source' || call.name === '.') && STDIN_FILES.has(args[0]?.value ?? ''))
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])
// Before the script name, -c runs its argument instead and -n only parses: no script file runs.
const NO_FILE = /^-[a-z]*[cn]/u
// The script file a shell or source call runs, as an absolute path, when its name is literal.
export const scriptFileOf = (call: Call, cwd: string | undefined) => {
  const { i, dashS } = shellFlags(call.argv.slice(1))
  const at = i + 1
  const fed = call.redirects.find((r) => r.op === '<' && (r.fd === undefined || r.fd === '0'))
  const operand = at >= call.argv.length && SHELLS.has(call.name) ? fed?.target : call.argv[at]
  const name = operand?.value === '-' ? undefined : operand
  const runs = SHELLS.has(call.name) || call.name === 'source' || call.name === '.'
  const pre = call.argv.slice(1, at)
  // `bash < file` runs the file as `bash file` does; a lone `-` is stdin; with -s the operands are positional parameters.
  if (!runs || dashS || name?.value === undefined || pre.some((a) => NO_FILE.test(a.value ?? ''))) {
    return
  }
  return joinPath(call.cwd ?? cwd, name.value)
}
