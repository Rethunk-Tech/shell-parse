// What an alias stands for: the names `alias` and `hash -p` bind, and the words an expansion hands on.

import type { Call } from './shellNodes.ts'
import { DYN, type Word } from './shellNodes.ts'
import type { Ctx, Scope, W } from './shellWords.ts'

// `alias name=value` words bind the name for the calls after it, as `hash -p path name` does; a value only
// the run knows binds DYN.
export const defineAliases = (scope: Scope, call: Call) => {
  const args = call.argv.slice(1)
  if (call.name === 'hash') {
    const at = args.findIndex((a) => a.value === '-p')
    const [path, name] = args.slice(at + 1)
    if (at >= 0 && name?.value !== undefined) {
      scope.aliases.set(name.value, path?.value ?? DYN)
    }
    return
  }
  for (const a of call.name === 'alias' ? args : []) {
    const eq = a.text.indexOf('=')
    if (eq > 0) {
      scope.aliases.set(a.text.slice(0, eq), a.text.slice(eq + 1))
    }
  }
}
const BLANK_END = /\s$/u
// An alias whose value only the run knows stands for a program no one can name: a brace list is a word that splits.
const UNKNOWN_ALIAS = '{alias,value}'
// An alias that ends in a blank hands the next word to alias expansion too.
export const aliasText = (w: W, ctx: Ctx, alias: string, args: Word[]) => {
  const seen = new Set<string>()
  const words: string[] = []
  let value = alias
  let i = 0
  while (words.length === i) {
    words.push(value.includes(DYN) ? UNKNOWN_ALIAS : value)
    const name = args[i]?.value
    const next =
      name === undefined || seen.has(name) || args[i]?.raw !== name || !BLANK_END.test(value)
        ? undefined
        : (ctx.scope.aliases.get(name) ?? w.script.env?.aliases.get(name))
    if (name !== undefined && next !== undefined) {
      seen.add(name)
      value = next
      i += 1
    }
  }
  return [...words, ...args.slice(i).map((a) => a.raw)].join(' ')
}
