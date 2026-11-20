// The script file a call runs from disk: `bash x.sh` and `source x`, or a call named by a path
// (`./ship.sh`) whose shebang names an sh-family shell. No engine imports.
import type { Call, Piece } from './shellNodes.ts'
import { joinPath, SHELLS, scriptFileOf, type W } from './shellWords.ts'

const SH_SHEBANG =
  /^#![ \t]*(?:\S*\/)?(?:env[ \t]+(?:-\S+[ \t]+)*)?(?:bash|sh|zsh|dash)(?:[ \t].*)?$/u

// The file a call named by a path runs, as an absolute path.
export const execFileOf = (call: Call, cwd: string | undefined) => {
  const name = call.argv[0]?.value
  return name?.includes('/') === true && !SHELLS.has(call.name)
    ? joinPath(call.cwd ?? cwd, name)
    : undefined
}
export const isShShebang = (text: string) => SH_SHEBANG.test(text.split('\n', 1)[0] ?? '')

export const fileScriptOf = (w: W, call: Call): Piece | undefined => {
  const file = scriptFileOf(call, w.opts.cwd)
  const read = file === undefined ? undefined : w.script.files?.get(file)
  if (read !== undefined) {
    return { text: read, base: undefined, file }
  }
  const exec = execFileOf(call, w.opts.cwd)
  const body = exec === undefined ? undefined : w.script.files?.get(exec)
  return body !== undefined && isShShebang(body)
    ? { text: body, base: undefined, file: exec }
    : undefined
}
