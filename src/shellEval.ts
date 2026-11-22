// Text a shell evaluates as code: arithmetic, a test, a declared name and `${x@P}` run the `$(...)` they hold,
// even when it sits in single quotes or in a variable.

import { type Call, type Node, one, str, walkNodes } from './shellNodes.ts'
import type { Ctx, W } from './shellWords.ts'

export const EVALED = /\$\(|`/u
const IDENT = /[A-Za-z_]\w*/gu
const evalTexts = (ctx: Ctx, node: Node): string[] => {
  const value = str(node, 'Value') ?? ''
  if (node.Type === 'SglQuoted') {
    return [value]
  }
  if (node.Type === 'ParamExp') {
    return [ctx.scope.env.get(str(one(node, 'Param'), 'Value') ?? '') ?? '']
  }
  return node.Type === 'Lit'
    ? (value.match(IDENT) ?? []).map((x) => ctx.scope.env.get(x) ?? '')
    : []
}
export const evaluated = (w: W, ctx: Ctx, n: unknown) =>
  walkNodes(n, (node) => {
    for (const t of evalTexts(ctx, node)) {
      if (EVALED.test(t)) {
        w.nest(ctx, t)
      }
    }
    return false
  })

export const READS = new Set(['read', 'mapfile', 'readarray'])
export const READ_VALUES = new Set(['-d', '-i', '-n', '-N', '-p', '-t', '-u'])
// The names read and printf -v assign are evaluated for the subscripts they hold.
export const evaluatedNames = (w: W, ctx: Ctx, call: Call) => {
  const args = call.argv.slice(1)
  const targets =
    call.name === 'printf' && args[0]?.value === '-v'
      ? args.slice(1, 2)
      : args.filter((_, i) => READS.has(call.name) && !READ_VALUES.has(args[i - 1]?.value ?? ''))
  for (const t of targets) {
    if (EVALED.test(t.value ?? '')) {
      w.nest(ctx, t.value ?? '')
    }
  }
}
