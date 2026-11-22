// Which shell variables reach a child's environment: export, an -x flag on declare, typeset or
// local, and set -a mark them. No engine imports.
import { many, type Node, one, str } from './shellNodes.ts'
import { type Ctx, type W, word } from './shellWords.ts'

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
export const markExported = (w: W, ctx: Ctx, n: Node, assigned: Iterable<string>) => {
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
