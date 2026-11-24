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

// In `[[ ]]` only the operands of the arithmetic comparisons (-eq -ne -le -ge -lt -gt) and of -v are evaluated as
// code; a string comparison or `=~` reads its operands as text. Operator codes are shfmt's.
const ARITH_TESTS = new Set([116, 117, 118, 119, 120, 121])
const VAR_TEST = 110
const evaluatedTest = (w: W, ctx: Ctx, t: Node | undefined) => {
  const op = t?.Op
  if (t?.Type === 'BinaryTest') {
    const each = ARITH_TESTS.has(op as number) ? evaluated : evaluatedTest
    each(w, ctx, one(t, 'X'))
    each(w, ctx, one(t, 'Y'))
  } else if (t?.Type === 'UnaryTest') {
    ;(op === VAR_TEST ? evaluated : evaluatedTest)(w, ctx, one(t, 'X'))
  } else if (t?.Type === 'ParenTest') {
    evaluatedTest(w, ctx, one(t, 'X'))
  }
}

// Arithmetic, `let` or `[[ ]]`: the code it evaluates.
export const evaluatedClause = (w: W, ctx: Ctx, node: Node) =>
  node.Type === 'TestClause' ? evaluatedTest(w, ctx, one(node, 'X')) : evaluated(w, ctx, node)

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
