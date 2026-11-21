// The shape of shfmt's (mvdan/sh) JSON syntax tree, and what a walk over it hands back. No engine imports.

import { isNumber, isString, readJson } from './util.ts'

export interface Node {
  readonly [key: string]: unknown
}
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)
export const one = (n: Node | undefined, key: string) => {
  const v = n?.[key]
  return isNode(v) ? v : undefined
}
export const many = (n: Node | undefined, key: string): Node[] => {
  const v = n?.[key]
  return Array.isArray(v) ? v.filter(isNode) : []
}
export const str = (n: Node | undefined, key: string) => {
  const v = n?.[key]
  return isString(v) ? v : undefined
}
const num = (n: Node | undefined, key: string) => {
  const v = n?.[key]
  return isNumber(v) ? v : undefined
}
export const byteAt = (n: Node | undefined, key: string) => num(one(n, key), 'Offset') ?? 0
// A node's character span in its text, through a byte-to-character map from charIndex.
export const spanOf = (at: (b: number) => number, n: Node | undefined) => ({
  start: at(byteAt(n, 'Pos')),
  end: at(byteAt(n, 'End')),
})
// Every node under a value, depth first; a visitor returning true keeps out of that node's children.
export const walkNodes = (v: unknown, visit: (n: Node) => boolean | undefined) => {
  if (Array.isArray(v)) {
    for (const x of v) {
      walkNodes(x, visit)
    }
  } else if (isNode(v) && !visit(v)) {
    for (const x of Object.values(v)) {
      walkNodes(x, visit)
    }
  }
}
// The statements of a left-nested pipeline, stopping at a left side with redirects of its own.
export const pipelineStages = (cmd: Node | undefined): Node[] => {
  const x = one(cmd, 'X')
  const xc = one(x, 'Cmd')
  const left = xc && opName(xc) === '|' && many(x, 'Redirs').length === 0 ? pipelineStages(xc) : [x]
  return [...left, one(cmd, 'Y')].filter((s) => s !== undefined)
}
// `2>&1`, from a redirect's operator, descriptor and target.
export const isStderrToStdout = (op: string, fd: string | undefined, target: string | undefined) =>
  op === '>&' && fd === '2' && target === '1'
// Keys holding the statement lists inside a compound command (a block's, a loop's, a branch's).
export const BODY_LISTS = ['Stmts', 'Cond', 'Then', 'Do']

export const parseJson = (json: string) => {
  const v = readJson(json)
  return isNode(v) && v.Type === 'File' ? v : undefined
}

// A value only the run knows: a variable never bound in the command, a substitution's output.
export const DYN = '\u0000'
// $!, the PID of a job this command started.
export const LAST_JOB = '\u0001!'

// shfmt's operator codes (mvdan/sh syntax tokens).
const OP_AND = 10
const OP_OR = 11
const OP_PIPE = 12
const OP_PIPE_ALL = 13
// The redirect operators in shfmt's order, from its first code on.
const FIRST_REDIRECT = 54
const REDIRECT_OPS = ['>', '>>', '<', '<>', '<&', '>&', '>|', '<<', '<<-', '<<<', '&>', '&>>']
export const opName = (n: Node) => {
  const op = num(n, 'Op')
  if (op === OP_AND) {
    return '&&'
  }
  if (op === OP_OR) {
    return '||'
  }
  return op === OP_PIPE || op === OP_PIPE_ALL
    ? '|'
    : (REDIRECT_OPS[(op ?? 0) - FIRST_REDIRECT] ?? '')
}

// shfmt counts bytes; JavaScript strings count UTF-16 units.
const ASCII = /^[\x20-\x7e\s]*$/u
// The UTF-8 width of each code point below each bound: 1, 2, 3, else 4 bytes.
const ONE_BYTE = 0x80
const TWO_BYTES = 0x8_00
const SURROGATE_PAIR = 0x1_00_00
const UTF8_BOUNDS = [ONE_BYTE, TWO_BYTES, SURROGATE_PAIR]
const utf8Width = (c: number) => {
  const below = UTF8_BOUNDS.findIndex((bound) => c < bound)
  return below < 0 ? UTF8_BOUNDS.length + 1 : below + 1
}
export const charIndex = (text: string) => {
  if (ASCII.test(text)) {
    return (b: number) => b
  }
  const map: number[] = []
  let byte = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.codePointAt(i) ?? 0
    const width = utf8Width(c)
    for (let k = 0; k < width; k++) {
      map[byte + k] = i
    }
    byte += width
    i += c >= SURROGATE_PAIR ? 1 : 0
  }
  map[byte] = text.length
  return (b: number) => map[b] ?? text.length
}

// Text a shell runs, and where it starts in the command when its bytes are the command's own.
export interface Piece {
  text: string
  base: number | undefined
  // The script file the text was read from.
  file?: string
}
export interface ShellEnv {
  aliases: Map<string, string>
  functions: Map<string, { body: Node; text: string }>
  gitAliases?: Map<string, string>
}
// A parsed command, every script it runs as text (`bash -c`, eval, a heredoc fed to a shell) parsed too.
export interface Script {
  text: string
  file: Node
  nested: Map<string, Node | undefined>
  env: ShellEnv | undefined
  // Script files the command runs (`bash x.sh`, `source x`), by absolute path, as read from disk.
  files?: Map<string, string>
  // Where relative script paths resolve when the parse is completed.
  cwd?: string | undefined
}
export interface Word {
  // The word as the shell would pass it, DYN where only the run knows.
  text: string
  value: string | undefined
  expands: boolean
  subst: boolean
  start: number | undefined
  end: number | undefined
  raw: string
  script: Piece
}
export interface Redirect {
  op: string
  fd: string | undefined
  target: Word | undefined
  body: Piece | undefined
}
export interface Wrapper {
  name: string
  words: Word[]
}
export interface Pipe {
  id: number
  stage: number
}
export interface Call {
  argv: Word[]
  name: string
  wrappers: Wrapper[]
  // Prefix assignments, or a standalone assignment's (argv empty) bindings.
  assigns: Map<string, string>
  env: Map<string, string>
  redirects: Redirect[]
  cwd: string | undefined
  start: number | undefined
  end: number | undefined
  subst: boolean
  loop: boolean
  bounded?: boolean
  background: boolean
  nested: boolean
  stdinArgs: boolean
  // A shell reading its script from a pipe whose producer is not a written-out echo, printf or heredoc.
  opaqueStdin: boolean
  pipes: Pipe[]
  via: string | undefined
  // The script file this call's line was read from, when a file the command runs holds it.
  file: string | undefined
  // The wrappers of the calls whose scripts hold this one: a shell run under systemd-run passes it on.
  outer: readonly string[]
}
export interface WalkOptions {
  cwd?: string | undefined
  home?: string | undefined
  vars?: Record<string, string>
  // The value of a $(...) holding this one call, when its run is known not to matter.
  known?: (call: Call) => string | undefined
}
