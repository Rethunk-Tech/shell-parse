// What an unquoted variable becomes at the shell's word splitting. No engine imports.

import type { Word } from './shellNodes.ts'
import { DYN } from './shellNodes.ts'

// Default IFS: a character it names makes an unquoted variable several words, so an IFS passed as the
// default splits as the default does.
const DEFAULT_IFS = ' \t\n'
const WHITESPACE = /[ \t\n]+/u
export const splits = (text: string, ifs: string | undefined) =>
  [...text].some((ch) => (ifs ?? DEFAULT_IFS).includes(ch))
// The words a variable of known value splits into at the default IFS; none are known for any other IFS.
export const knownFields = (text: string, ifs: string | undefined) =>
  ifs === undefined && !text.includes(DYN) ? text.split(WHITESPACE).filter(Boolean) : undefined
// `$@` and `$*` in a function: the call site's words, one field each (`"$*"` joins them into one); a word only the
// run knows, or an unquoted one that would split again, leaves the value to the run.
export const positionalAll = (given: string[], star: boolean, quoted: boolean) => {
  if (given.some((g) => g.includes(DYN) || (!quoted && splits(g, undefined)))) {
    return
  }
  const fields = star && quoted ? [given.join(' ')] : given
  return { text: given.join(' '), expands: true, subst: false, splits: fields.length !== 1, fields }
}
// A variable of known value that splits (`P='git status'; $P`) is the words it holds: the walk reads them as
// written. A value only the run knows stays one word that splits.
export const fieldsOf = (wd: Word): Word[] =>
  wd.fields === undefined
    ? [wd]
    : wd.fields.map((f) => ({
        ...wd,
        text: f,
        value: f,
        splits: false,
        fields: undefined,
        script: { text: f, base: undefined },
      }))
