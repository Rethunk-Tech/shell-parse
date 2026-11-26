// Which shell variables reach a child's environment: export, an -x flag on declare, typeset or
// local, and set -a mark them; and which names a function's local keeps to its call. No engine imports.
import { DYN, many, type Node, one, str, type Word } from './shellNodes.ts'
import { type Ctx, type Scope, type W, word } from './shellWords.ts'

const EXPORT_FLAG = /^-\w*x/u
const ALLEXPORT_FLAG = /^-\w*a/u
const ALLEXPORT_OFF = /^\+\w*a/u

const exportsAll = (w: W, ctx: Ctx, n: Node) =>
  ctx.scope.allexport === true ||
  str(one(n, 'Variant'), 'Value') === 'export' ||
  many(n, 'Args').some((a) => {
    const v = one(a, 'Value')
    return (
      a.Naked === true &&
      !one(a, 'Name') &&
      v !== undefined &&
      EXPORT_FLAG.test(word(w, ctx, v).text)
    )
  })

// The assignments a bare assignment or declaration makes, plus the names `export NAME` marks.
const markExported = (w: W, ctx: Ctx, n: Node, assigned: Iterable<string>) => {
  if (!exportsAll(w, ctx, n)) {
    return
  }
  const naked = many(n, 'Args').flatMap((a) => {
    const name = a.Naked === true ? str(one(a, 'Name'), 'Value') : undefined
    return name === undefined ? [] : [name]
  })
  for (const name of [...assigned, ...naked]) {
    ctx.scope.exported.add(name)
  }
}

// `set -a` / `set -o allexport` turns allexport on, `+a` / `+o allexport` turns it off, and the words
// after `--` are positional parameters, not options. The last one named wins; none named leaves it be.
export const setsAllexport = (values: (string | undefined)[]): boolean | undefined => {
  let on: boolean | undefined
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? ''
    if (v === '--') {
      break
    }
    if (v === '-o' || v === '+o') {
      if (values[i + 1] === 'allexport') {
        on = v === '-o'
      }
      i += 1
    } else if (ALLEXPORT_FLAG.test(v)) {
      on = true
    } else if (ALLEXPORT_OFF.test(v)) {
      on = false
    }
  }
  return on
}

// What each name a running function's local shadows held in the caller, by the shell it runs in.
type Saved = Map<string, { value: string | undefined; exported: boolean }>
const frames = new WeakMap<Scope, Saved>()
const LOCAL_VARIANTS = new Set(['local', 'declare', 'typeset'])
const GLOBAL_FLAG = /^-\w*g/u

// local, and declare or typeset without -g, inside a function keep each name they set to that call.
const shadowLocals = (w: W, ctx: Ctx, n: Node) => {
  const saved = frames.get(ctx.scope)
  const args = many(n, 'Args')
  if (
    !(saved && LOCAL_VARIANTS.has(str(one(n, 'Variant'), 'Value') ?? '')) ||
    args.some((a) => {
      const v = one(a, 'Value')
      return !one(a, 'Name') && v !== undefined && GLOBAL_FLAG.test(word(w, ctx, v).text)
    })
  ) {
    return
  }
  for (const a of args) {
    const name = str(one(a, 'Name'), 'Value')
    if (name !== undefined && !saved.has(name)) {
      saved.set(name, { value: ctx.scope.env.get(name), exported: ctx.scope.exported.has(name) })
    }
  }
}

// Sets the names an assignment or declaration assigns, and marks the ones it exports.
export const bindNames = (w: W, ctx: Ctx, n: Node, assigns: Map<string, string>) => {
  shadowLocals(w, ctx, n)
  for (const [k, v] of assigns) {
    ctx.scope.env.set(k, v)
  }
  markExported(w, ctx, n, assigns.keys())
}

// A function runs in its caller's shell, and the names its locals shadow come back when it returns.
export const callFunction = (w: W, ctx: Ctx, body: Node, argv: Word[]) => {
  const { scope } = ctx
  const outer = frames.get(scope)
  const saved: Saved = new Map()
  frames.set(scope, saved)
  const callerArgs = scope.positional
  scope.positional = argv.slice(1).map((a) => a.value ?? DYN)
  w.stmt({ ...ctx, depth: ctx.depth + 1 }, body)
  scope.positional = callerArgs
  for (const [name, { value, exported }] of saved) {
    if (value === undefined) {
      scope.env.delete(name)
    } else {
      scope.env.set(name, value)
    }
    if (exported) {
      scope.exported.add(name)
    } else {
      scope.exported.delete(name)
    }
  }
  if (outer) {
    frames.set(scope, outer)
  } else {
    frames.delete(scope)
  }
}
