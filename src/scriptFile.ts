// The script file a call runs from disk: `bash x.sh` and `source x`, a call named by a path (`./ship.sh`)
// whose shebang names an sh-family shell, or a task runner's recipe (`make ship`, `npm run ship`,
// `just ship`) the caller read from the Makefile, package.json or justfile. No engine imports.
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

export type Runner = 'make' | 'npm' | 'just'
export interface Recipe {
  runner: Runner
  // The Makefile, package.json or justfile the recipe is read from, and the key its text is kept under in
  // Script.files: `<file>#<target>`, an empty target meaning the default one.
  file: string
  target: string
  key: string
}
const MAKES = new Set(['make', 'gmake'])
const NPMS = new Set(['npm', 'bun', 'pnpm', 'yarn'])
const NPM_LIFECYCLE = new Set(['test', 't', 'start', 'stop', 'restart'])
const MAKE_VALUE_FLAGS = new Set(['-j', '-l', '-o', '-W', '-I', '-E'])
const recipe = (runner: Runner, file: string, target: string): Recipe => ({
  runner,
  file,
  target,
  key: `${file}#${target}`,
})
const makeRecipes = (words: string[], dir: string): Recipe[] => {
  let where = dir
  let file: string | undefined
  const targets: string[] = []
  for (let i = 0; i < words.length; i++) {
    const v = words[i] ?? ''
    const next = words[i + 1] ?? ''
    if (v === '-C' || v === '--directory') {
      where = joinPath(where, next) ?? where
      i += 1
    } else if (v === '-f' || v === '--file' || v === '--makefile') {
      file = next
      i += 1
    } else if (MAKE_VALUE_FLAGS.has(v)) {
      i += 1
    } else if (!(v.startsWith('-') || v.includes('='))) {
      targets.push(v)
    }
  }
  const source = joinPath(where, file ?? 'Makefile')
  return source === undefined
    ? []
    : (targets.length > 0 ? targets : ['']).map((t) => recipe('make', source, t))
}
const justRecipes = (words: string[], dir: string): Recipe[] => {
  let file = 'justfile'
  const targets: string[] = []
  for (let i = 0; i < words.length; i++) {
    const v = words[i] ?? ''
    if (v === '-f' || v === '--justfile') {
      file = words[i + 1] ?? file
      i += 1
    } else if (v === '-d' || v === '--working-directory') {
      i += 1
    } else if (!v.startsWith('-')) {
      targets.push(v)
    }
  }
  const source = joinPath(dir, file)
  return source === undefined
    ? []
    : (targets.length > 0 ? targets : ['']).map((t) => recipe('just', source, t))
}
const npmRecipes = (name: string, words: string[], dir: string): Recipe[] => {
  const source = joinPath(dir, 'package.json')
  const [head] = words
  const first = (from: string[]) => from.find((w) => !w.startsWith('-'))
  let target: string | undefined
  if (head === 'run' || (name === 'npm' && head === 'run-script')) {
    target = first(words.slice(1))
  } else if (name === 'npm') {
    if (head !== undefined && NPM_LIFECYCLE.has(head)) {
      target = head === 't' ? 'test' : head
    }
  } else if (name !== 'bun') {
    target = first(words)
  }
  return source === undefined || target === undefined ? [] : [recipe('npm', source, target)]
}
// The recipes a task runner call runs, by the target words it names; none when a word is only known at run time.
export const recipesOf = (call: Call, cwd: string | undefined): Recipe[] => {
  const dir = call.cwd ?? cwd
  const words = call.argv.slice(1).map((a) => a.value)
  if (dir === undefined || words.some((v) => v === undefined)) {
    return []
  }
  const known = words as string[]
  if (MAKES.has(call.name)) {
    return makeRecipes(known, dir)
  }
  if (call.name === 'just') {
    return justRecipes(known, dir)
  }
  return NPMS.has(call.name) ? npmRecipes(call.name, known, dir) : []
}

export const fileScriptOf = (w: W, call: Call): Piece | undefined => {
  const file = scriptFileOf(call, w.opts.cwd)
  const read = file === undefined ? undefined : w.script.files?.get(file)
  if (read !== undefined) {
    return { text: read, base: undefined, file }
  }
  const exec = execFileOf(call, w.opts.cwd)
  const body = exec === undefined ? undefined : w.script.files?.get(exec)
  if (body !== undefined && isShShebang(body)) {
    return { text: body, base: undefined, file: exec }
  }
  const found = recipesOf(call, w.opts.cwd)
  const texts = found
    .map((r) => w.script.files?.get(r.key))
    .filter((t) => t !== undefined && t !== '')
  return texts.length > 0
    ? { text: texts.join('\n'), base: undefined, file: found[0]?.file }
    : undefined
}
