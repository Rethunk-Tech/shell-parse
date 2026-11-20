// What a shell makes of the words of a command: quotes, escapes, variables, substitutions, redirects
// and the wrappers that run another command. No engine imports.
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
interface Scope {
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
  out: { calls: Call[]; missing: Set<string>; pipes: number }
  stmts: (ctx: Ctx, stmts: Node[]) => void
  stmt: (ctx: Ctx, s: Node) => Call | undefined
}
interface Val {
  text: string
  expands: boolean
  subst: boolean
}

const LINE_CONT = /\\\n/gu
const BARE_ESC = /\\(.)/gsu
const QUOTED_ESC = /\\([$`"\\])/gu
export const ASSIGN_WORD = /^(?<name>[A-Za-z_]\w*)=(?<value>.*)$/su
const COMPLEX_PARAM = ['Exp', 'Index', 'Length', 'Excl', 'Repl', 'Slice', 'Names', 'Width']
const LOOKUP = /^-[vV]/u
export const srcOf = (text: string, base: number | undefined): Src => ({
  text,
  at: charIndex(text),
  base,
})
// `alias name=value` words bind the name for the calls after it.
export const defineAliases = (scope: Scope, call: Call) => {
  for (const a of call.name === 'alias' ? call.argv.slice(1) : []) {
    const eq = a.value?.indexOf('=') ?? -1
    if (a.value !== undefined && eq > 0) {
      scope.aliases.set(a.value.slice(0, eq), a.value.slice(eq + 1))
    }
  }
}
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
  return {
    raw: ctx.src.text.slice(start, end),
    start: base === undefined ? undefined : base + start,
    end: base === undefined ? undefined : base + end,
  }
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
const param = (w: W, ctx: Ctx, p: Node): Val => {
  if (COMPLEX_PARAM.some((k) => Boolean(p[k]))) {
    anyIn(w, ctx, p)
    return dyn(false)
  }
  const name = str(one(p, 'Param'), 'Value') ?? ''
  return {
    text: name === '!' ? LAST_JOB : (ctx.scope.env.get(name) ?? DYN),
    expands: true,
    subst: false,
  }
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
// $'...' words carry C escapes bash decodes before the call runs: `git $'\x70ush'` is a push.
const ANSI_C =
  /\\(?:x(?<hex>[0-9a-fA-F]{1,2})|[uU](?<uni>[0-9a-fA-F]{1,8})|(?<oct>[0-7]{1,3})|c(?<ctl>.)|(?<one>.))/gsu
const ANSI_C_ONE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}
const HEX = 16
const OCTAL = 8
const CONTROL_BIT = 0x40
const ansiC = (text: string) =>
  text.replace(ANSI_C, (all, ...rest) => {
    const g = rest.at(-1) as Record<string, string | undefined>
    if (g.hex !== undefined) {
      return String.fromCharCode(Number.parseInt(g.hex, HEX))
    }
    if (g.uni !== undefined) {
      return String.fromCodePoint(Number.parseInt(g.uni, HEX))
    }
    if (g.oct !== undefined) {
      return String.fromCharCode(Number.parseInt(g.oct, OCTAL))
    }
    if (g.ctl !== undefined) {
      return String.fromCharCode(
        (g.ctl.toUpperCase().charCodeAt(0) + CONTROL_BIT) % (2 * CONTROL_BIT),
      )
    }
    return ANSI_C_ONE[g.one ?? ''] ?? g.one ?? all
  })
const partValue = (w: W, ctx: Ctx, p: Node, at: { quoted: boolean; lead: boolean }): Val => {
  const { quoted, lead } = at
  switch (p.Type) {
    case 'Lit': {
      const v = (str(p, 'Value') ?? '').replace(LINE_CONT, '')
      if (quoted) {
        return lit(v.replace(QUOTED_ESC, '$1'))
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
      return param(w, ctx, p)
    case 'CmdSubst':
      return cmdSubst(w, ctx, p)
    case 'ProcSubst':
      w.stmts(substCtx(ctx), many(p, 'Stmts'))
      return dyn(true)
    default:
      anyIn(w, ctx, p)
      return dyn(false)
  }
}
// The script a word holds when a shell runs it, and where it sits in the command when its bytes are
// exactly the script's (a single-quoted string, an escape-free double-quoted one or bare word).
const pieceOf = (parts: Node[], v: Val, r: ReturnType<typeof range>): Piece => {
  const [only] = parts
  const inside = r.start === undefined ? undefined : r.start + 1
  if (parts.length === 1 && only?.Type === 'SglQuoted' && only.Dollar !== true) {
    return { text: str(only, 'Value') ?? '', base: inside }
  }
  if (parts.length === 1 && only?.Type === 'DblQuoted') {
    const text = r.raw.slice(1, -1)
    return text.includes('\\')
      ? { text: text.replace(LINE_CONT, '').replace(QUOTED_ESC, '$1'), base: undefined }
      : { text, base: inside }
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
    if (name === undefined || a.Naked === true) {
      continue
    }
    const value = one(a, 'Value')
    if (a.Append === true || one(a, 'Array') || one(a, 'Index')) {
      anyIn(w, ctx, a)
      bound.set(name, DYN)
    } else {
      bound.set(name, value ? word(w, ctx, value).text : '')
    }
  }
  return bound
}

const skipOptions = (words: Word[], from: number, values: string[], env?: Map<string, string>) => {
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
    j += v !== undefined && values.includes(v) ? 2 : 1
  }
  return j
}
// The command a wrapper chain (sudo, env, timeout, xargs, ...) finally runs, and the wrappers.
// A tool word: `node@20`, `npm:prettier@latest`.
const TOOL_WORD = /^[^-\s][^\s@]*@\S+$/u
// Where a wrapper's own words end and its command starts, or -1 when it runs none.
const commandAt = (
  words: Word[],
  at: number,
  spec: WrapperSpec,
  env: Map<string, string> | undefined,
) => {
  let start = at + 1
  if (spec.sub !== undefined) {
    let sub = skipOptions(words, start, spec.values)
    if (spec.workspace && words[sub]?.value === 'workspace') {
      sub = skipOptions(words, sub + 2, spec.values)
    }
    const named = words[sub]?.value
    if (named !== spec.sub && (spec.alias === undefined || named !== spec.alias)) {
      return -1
    }
    start = sub + 1
    if (spec.shell && hasShellFlag(words, start)) {
      return -1
    }
  }
  let end = skipOptions(words, start, spec.values, env)
  const first = end
  while (spec.tools && TOOL_WORD.test(words[end]?.value ?? '')) {
    end += 1
  }
  if (words[end]?.value === '--' && end > first) {
    return end + 1
  }
  // With no tool word named, a `--` further on may follow a bare tool name (`mise exec node -- cmd`).
  const dashes =
    spec.dashes && end === first ? words.findIndex((w, k) => k >= start && w.value === '--') : -1
  return dashes >= 0 ? dashes + 1 : end + (spec.lead ?? 0)
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
export const gitVerb = (call: Call) => {
  if (call.name === 'rgit') {
    return { verb: call.argv[1]?.value, at: 1 }
  }
  if (call.name !== 'git') {
    return
  }
  let at = 1
  while (at < call.argv.length) {
    const v = call.argv[at]?.value
    if (v === undefined || !v.startsWith('-')) {
      return { verb: v, at }
    }
    at += GIT_VALUE_OPTS.has(v) ? 2 : 1
  }
  return { verb: undefined, at }
}

const SHELL_FLAG = /^(?:[-+][A-Za-z]+|--.*)$/u
const SET_OPTION = new Set(['-o', '+o', '-O', '+O'])
const STDIN_FILES = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
// A shell's leading flags: where its operands start, and whether they said -c or -s.
export const shellFlags = (args: Word[]) => {
  let i = 0
  let dashC = false
  let dashS = false
  while (i < args.length && SHELL_FLAG.test(args[i]?.value ?? '')) {
    const v = args[i]?.value ?? ''
    i += SET_OPTION.has(v) ? 2 : 1
    if (v === '--') {
      break
    }
    dashC ||= v.startsWith('-') && !v.startsWith('--') && v.includes('c')
    dashS ||= v.startsWith('-') && !v.startsWith('--') && v.includes('s')
  }
  return { i, dashC, dashS }
}
// at and batch queue the commands they read on stdin; `source /dev/stdin` runs them now.
export const readsStdin = (call: Call, args: Word[]) =>
  call.name === 'at' ||
  call.name === 'batch' ||
  ((call.name === 'source' || call.name === '.') && STDIN_FILES.has(args[0]?.value ?? ''))
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])
// Before the script name, -c runs its argument instead and -n only parses: no script file runs.
const NO_FILE = /^-[a-z]*[cn]/u
// The script file a shell or source call runs, as an absolute path, when its name is literal.
export const scriptFileOf = (call: Call, cwd: string | undefined) => {
  const at = call.argv.findIndex((a, i) => i > 0 && !a.value?.startsWith('-'))
  const runs = SHELLS.has(call.name) || call.name === 'source' || call.name === '.'
  // `bash < file` runs the file as `bash file` does.
  const fed = call.redirects.find((r) => r.op === '<' && (r.fd === undefined || r.fd === '0'))
  const name = at < 0 && SHELLS.has(call.name) ? fed?.target : call.argv[at]
  const pre = call.argv.slice(1, at < 0 ? undefined : at)
  return runs && !pre.some((a) => NO_FILE.test(a.value ?? '')) && name?.value !== undefined
    ? joinPath(call.cwd ?? cwd, name.value)
    : undefined
}
export const recordWrittenScript = (w: W, call: Call, body: Piece | undefined) => {
  const dest = call.redirects.find((r) => r.op.includes('>'))?.target
  const path = body?.text && dest?.value ? joinPath(call.cwd ?? w.opts.cwd, dest.value) : undefined
  if (path?.startsWith('/') === true && body?.text) {
    const files = w.script.files ?? new Map<string, string>()
    w.script.files = files
    files.set(path, body.text)
  }
}
