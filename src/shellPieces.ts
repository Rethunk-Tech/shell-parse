// What a call feeds the next stage of a pipeline, and how a shell call reads its script. No engine imports.
import { ansiC } from './ansi.ts'
import { wrapperCwd } from './runners.ts'
import type { Call, Piece, Redirect, Word, Wrapper } from './shellNodes.ts'
import { type Ctx, nameOf, SHELLS, shellFlags } from './shellWords.ts'

const ECHO_FLAG = /^-[neE]+$/u
// printf's directives (`%s`, `%b`, `%%`, `%5d`): each takes the next argument, and the format runs again while
// arguments are left.
const PRINTF_DIRECTIVE = /%(?:%|[-+ #0]*\d*(?:\.\d+)?[a-zA-Z])/gu
const printfText = (format: string, args: string[]) => {
  let used = 0
  const pass = () => {
    let out = ''
    let last = 0
    for (const m of format.matchAll(PRINTF_DIRECTIVE)) {
      out += ansiC(format.slice(last, m.index))
      last = m.index + m[0].length
      if (m[0] === '%%') {
        out += '%'
      } else {
        const arg = args[used] ?? ''
        used += 1
        out += m[0].endsWith('b') ? ansiC(arg) : arg
      }
    }
    return out + ansiC(format.slice(last))
  }
  let out = pass()
  while (used > 0 && used < args.length) {
    out += pass()
  }
  return out
}
// What an echo or printf with written-out words prints, escapes decoded as the shell would.
const literalOutput = (call: Call): Piece | undefined => {
  const args = call.argv.slice(1)
  const flags = args.filter((a) => call.name === 'echo' && ECHO_FLAG.test(a.value ?? ''))
  const words = args.filter((a) => !flags.includes(a))
  const values = words.map((a) => a.value)
  if (!values.every((v) => v !== undefined) || values[0]?.startsWith('-') === true) {
    return
  }
  const joined = values.join(' ')
  const decodes = flags.some((a) => (a.value ?? '').includes('e'))
  let text = decodes ? ansiC(joined) : joined
  if (call.name === 'printf') {
    text = printfText(values[0] ?? '', values.slice(1))
  }
  return { text, base: undefined }
}
export const output = (call: Call): Piece | undefined => {
  if (call.name !== 'echo' && call.name !== 'printf') {
    return call.name === 'cat' && call.argv.length === 1
      ? call.redirects.find((r) => r.body)?.body
      : undefined
  }
  const args = call.argv
    .slice(1)
    .filter((a) => !(call.name === 'echo' && ECHO_FLAG.test(a.value ?? '')))
  const [only] = args
  const raw =
    args.length === 1 && only
      ? only.script
      : { text: args.map((a) => a.script.text).join(' '), base: undefined }
  // Keep the command's own bytes (and their positions) when decoding changes nothing.
  const literal = literalOutput(call)
  return literal && literal.text !== raw.text ? literal : raw
}
// A shell that takes its script from a pipe (`cmd | sh`, `| bash -s`) whose producer is no echo, printf or heredoc cat.
export const shellFromPipe = (call: Call, own: Redirect[], ctx: Ctx) => {
  const args = call.argv.slice(1)
  const { i, dashC, dashS } = shellFlags(args)
  const fedByPipe = (ctx.pipes.at(-1)?.stage ?? 0) > 0
  return (
    SHELLS.has(call.name) &&
    fedByPipe &&
    !dashC &&
    (dashS || i >= args.length || args[i]?.value === '-') &&
    !own.some((r) => r.op.startsWith('<') && (r.fd === undefined || r.fd === '0'))
  )
}
export const scriptRuns = (call: Call) => {
  if (call.name === 'source' || call.name === '.') {
    return 'source'
  }
  return SHELLS.has(call.name) || call.argv[0]?.value?.includes('/') === true
    ? 'program'
    : undefined
}
// What a pipeline stage feeds the next: its output, none when an echo or printf has a word only the run knows.
export const feedOf = (call: Call | undefined) =>
  call && (call.name === 'echo' || call.name === 'printf') && !literalOutput(call)
    ? undefined
    : call && output(call)
// A script read by path knows its own name: `$(dirname "$0")` resolves. A sourced file keeps its caller's $0.
export const bindOwnPath = (
  scope: Ctx['scope'],
  file: string | undefined,
  runs: 'program' | 'source' | undefined,
) => {
  if (file !== undefined && runs !== undefined) {
    if (runs === 'program') {
      scope.env.set('0', file)
    }
    scope.env.set('BASH_SOURCE', file)
  }
}

const GIT_PROGRAM = /^git-(?<verb>[a-z][a-z-]*)$/u
// git's own programs (`git-reset`) are git run with the verb, so every rule on the verb applies.
export const gitProgramSpelled = (argv: Word[]): Word[] => {
  const dash = GIT_PROGRAM.exec(nameOf(argv[0]))?.groups?.verb
  const [first] = argv
  return dash !== undefined && first
    ? [
        { ...first, text: 'git', value: 'git', raw: 'git' },
        { ...first, text: dash, value: dash, raw: dash, start: undefined, end: undefined },
        ...argv.slice(1),
      ]
    : argv
}

// A long script sets hundreds of variables and exports a few, and every call takes a copy: walk the smaller side.
export const exportedEnv = ({ env, exported }: Ctx['scope']): [string, string][] =>
  exported.size < env.size
    ? [...exported].flatMap((k) => {
        const v = env.get(k)
        return v === undefined ? [] : [[k, v] as [string, string]]
      })
    : [...env].filter(([k]) => exported.has(k))
export const callOf = (
  ctx: Ctx,
  { argv, wrappers }: { argv: Word[]; wrappers: Wrapper[] },
  assigns: Map<string, string>,
  r: { start: number | undefined; end: number | undefined },
): Call => ({
  argv: gitProgramSpelled(argv),
  name: nameOf(gitProgramSpelled(argv)[0]),
  wrappers,
  assigns,
  env: new Map([...exportedEnv(ctx.scope), ...assigns]),
  redirects: ctx.redirects,
  cwd: wrapperCwd(wrappers, ctx.scope.cwd),
  start: r.start,
  end: r.end,
  subst: ctx.subst,
  loop: ctx.loop,
  bounded: ctx.loop && ctx.bounded === true,
  background: ctx.background,
  nested: ctx.nested,
  opaqueStdin: false,
  stdinArgs: wrappers.some((x) => x.name === 'xargs') || ctx.outer.includes('xargs'),
  pipes: ctx.pipes,
  via: ctx.via,
  file: ctx.file,
  outer: ctx.outer,
})
