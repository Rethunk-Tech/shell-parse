// Script files a command writes before it runs them: what a redirect, tee, cp, mv, ln or base64 -d leaves in
// a file, so the run is read as the body that will be there. No engine imports.
import { type Call, DYN, type Piece, type Redirect, type Script, type Word } from './shellNodes.ts'
import { output } from './shellPieces.ts'
import { type Ctx, joinPath, nameOf, type W } from './shellWords.ts'

const COPIERS = new Set(['cp', 'mv', 'ln'])
const DECODE = new Set(['-d', '-D', '--decode'])
const WHITESPACE = /\s+/gu
const decode64 = (text: string) => {
  try {
    const bytes = Uint8Array.from(atob(text.replace(WHITESPACE, '')), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return
  }
}
// A redirect that writes the call's output to a file: `>`, `>|` and the stdout+stderr forms `&>` and `>& file`.
// A descriptor copy (`2>&1`, `>&2`) names no file.
const DESCRIPTOR = /^\d+-?$/u
const stdoutRedirect = (r: Redirect) =>
  (r.op.includes('>') || r.op === '&>') &&
  (r.fd === undefined || r.fd === '1') &&
  !DESCRIPTOR.test(r.target?.value ?? '')
// `>>` and `&>>` add to what the file holds.
const appending = (r: Redirect) => r.op === '>>' || r.op === '&>>'
// `tee -a` adds to each file rather than replacing it.
const TEE_APPEND = new Set(['-a', '--append'])
// A script is walked more than once (as the texts it runs are parsed, then by the caller), so an append is
// recorded once per call site: the same body a re-walk reaches again is already in the file.
const APPENDED = new WeakMap<Script, Set<string>>()
const firstAppend = (script: Script, key: string) => {
  const seen = APPENDED.get(script) ?? new Set<string>()
  APPENDED.set(script, seen)
  if (seen.has(key)) {
    return false
  }
  seen.add(key)
  return true
}
// What a call's `> file` leaves in the file, when the call is one whose output is written out.
const redirected = (call: Call, args: Word[], fed: Piece | undefined) => {
  // A redirect with no command (`> file`) writes nothing, so the file is empty.
  if (call.argv.length === 0) {
    return ''
  }
  const decoding = call.name === 'base64' && call.argv.some((a) => DECODE.has(a.value ?? ''))
  if (!decoding) {
    return output(call)?.text
  }
  return args.length === 0 ? decode64(fed?.text ?? '') : undefined
}
export const recordFileOps = (w: W, call: Call, own: Redirect[], ctx: Ctx) => {
  const { script } = w
  script.files = script.files ?? new Map<string, string>()
  script.unknown = script.unknown ?? new Set<string>()
  script.copies = script.copies ?? new Map<string, string>()
  const { files, unknown, copies } = script as Required<
    Pick<Script, 'files' | 'unknown' | 'copies'>
  >
  const abs = (word: Word | undefined) => {
    const dir = call.cwd ?? w.opts.cwd
    const path = word?.value === undefined ? undefined : joinPath(dir, word.value)
    return path?.startsWith('/') === true ? path : undefined
  }
  const set = (path: string | undefined, text: string | undefined, append = false) => {
    if (path === undefined) {
      return
    }
    copies.delete(path)
    const before = files.get(path)
    // A body only the run knows leaves the file unknown.
    if (text === undefined || text.includes(DYN)) {
      files.delete(path)
      unknown.add(path)
      return
    }
    // An append to a body no one recorded (a file on disk) leaves the file for the caller to read, which
    // adds the appended text to what it finds; it is not a body only the run knows.
    if (append && before === undefined) {
      return
    }
    if (!append) {
      files.set(path, text)
      unknown.delete(path)
      return
    }
    // A re-walk of the same call site must not add the same body a second time.
    if (firstAppend(script, `${path}\u0000${call.start ?? -1}\u0000${text}`)) {
      files.set(path, before + text)
    }
    unknown.delete(path)
  }
  const copy = (from: string | undefined, to: string) => {
    if (from !== undefined && files.has(from)) {
      set(to, files.get(from))
    } else if (from === undefined || unknown.has(from)) {
      set(to, undefined)
    } else {
      files.delete(to)
      unknown.delete(to)
      copies.set(to, from)
    }
  }
  const fed = own.find((r) => r.body && (r.fd === undefined || r.fd === '0'))?.body ?? ctx.stdin
  const args = call.argv.slice(1).filter((a) => !(a.value ?? '').startsWith('-'))
  const target = call.redirects.find(stdoutRedirect)
  if (call.name === 'tee') {
    const append = call.argv.some((a) => TEE_APPEND.has(a.value ?? ''))
    for (const a of args) {
      set(abs(a), fed?.text, append)
    }
  } else if (COPIERS.has(call.name) && args.length >= 2) {
    // With more than two operands the last is a directory, and each source lands in it under its own name.
    const dir = abs(args.at(-1))
    for (const a of args.slice(0, -1)) {
      const to = args.length === 2 || dir === undefined ? dir : joinPath(dir, nameOf(a))
      if (to !== undefined) {
        copy(abs(a), to)
      }
    }
  } else if (target !== undefined) {
    set(abs(target.target), redirected(call, args, fed), appending(target))
  }
}
