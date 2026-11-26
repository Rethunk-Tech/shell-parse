// The script file a call runs from disk: `bash x.sh` and `source x`, a call named by a path (`./ship.sh`)
// whose shebang names an sh-family shell (or that has none, which sh runs), or a task runner's recipe
// (`make ship`, `npm run ship`, `just ship`) the caller read from the Makefile, package.json or justfile.
// No engine imports.
import type { Call, Piece } from './shellNodes.ts'
import { joinPath, SHELLS, scriptFileOf, type W } from './shellWords.ts'

const SH_SHEBANG =
  /^#![ \t]*(?:\S*\/)?(?:env[ \t]+(?:-\S+[ \t]+)*)?(?:busybox[ \t]+)?(?:bash|sh|zsh|dash|ksh|mksh|ash)(?:[ \t].*)?$/u
// A file with no `#!` is run by the shell that was asked to run it, unless it is a binary.
const BINARY_SNIFF = 512
const TEXT_CONTROLS = new Set([9, 10, 12, 13, 27])
const isBinary = (text: string) =>
  [...text.slice(0, BINARY_SNIFF)].some((ch) => {
    const code = ch.charCodeAt(0)
    return code === 0xff_fd || code === 0x7f || (code < 0x20 && !TEXT_CONTROLS.has(code))
  })

// `uv run x.py` runs the file with Python, whatever its text holds.
const PYTHON_FILE = /\.pyw?$/u
// The file a call named by a path runs, as an absolute path.
export const execFileOf = (call: Call, cwd: string | undefined) => {
  const name = call.argv[0]?.value
  if (name !== undefined && PYTHON_FILE.test(name) && call.wrappers.some((w) => w.name === 'uv')) {
    return
  }
  return name?.includes('/') === true && !SHELLS.has(call.name)
    ? joinPath(call.cwd ?? cwd, name)
    : undefined
}
export const isShShebang = (text: string) => SH_SHEBANG.test(text.split('\n', 1)[0] ?? '')
export const isShScript = (text: string) =>
  isShShebang(text) || !(text.startsWith('#!') || isBinary(text))

export type Runner = 'make' | 'npm' | 'just'
export interface Recipe {
  runner: Runner
  // The Makefile, package.json or justfile the recipe is read from, and the key its text is kept under in
  // Script.files: `<file>#<target>`, an empty target meaning the default one.
  file: string
  target: string
  // The make variables the command line sets (`*` when -e lets the environment override the Makefile).
  vars: string[]
  // The file names the runner tries in `dir` (make: GNUmakefile, makefile, Makefile), and whether it then
  // tries each parent directory (npm and just do).
  names: string[]
  dir: string
  up: boolean
  // The directory the runner runs in, which an included makefile's relative path is read from.
  cwd: string
  // Text make reads before any file (--eval).
  evals: string[]
  // The workspace a package manager's -w / --filter names (a package name or path), whose package.json holds the script.
  workspace?: string
  key: string
}
export const MAKES = new Set(['make', 'gmake'])
export const NPMS = new Set(['npm', 'bun', 'pnpm', 'yarn'])
const NPM_LIFECYCLE = new Set(['test', 't', 'tst', 'start', 'stop', 'restart'])
const recipe = (
  runner: Runner,
  file: string,
  target: string,
  where: Partial<Recipe> = {},
): Recipe => {
  const { vars = [], evals = [] } = where
  const extra = [...vars, ...evals.map((e) => `--eval=${e}`)]
  const dir = where.dir ?? file.slice(0, file.lastIndexOf('/') || 1)
  return {
    runner,
    file,
    target,
    vars,
    names: where.names ?? [file.slice(file.lastIndexOf('/') + 1)],
    dir,
    up: where.up ?? false,
    cwd: where.cwd ?? dir,
    evals,
    ...(where.workspace === undefined ? {} : { workspace: where.workspace }),
    key: `${file}#${target}${extra.length > 0 ? `#${extra.join(',')}` : ''}${where.workspace === undefined ? '' : `@${where.workspace}`}`,
  }
}
const MAKE_VAR_WORD = /^(?<name>[A-Za-z_][\w.-]*)=/u
const MAKE_ENV_FLAG = /^-[^-]*e|^--environment-overrides$/u
const MAKE_NAMES = ['GNUmakefile', 'makefile', 'Makefile']
// Flags whose value is the next word (or attached: -Cdir, --file=x), and those whose number is optional.
const MAKE_FLAG_VALUES: Record<string, string[]> = {
  C: ['-C', '--directory'],
  f: ['-f', '--file', '--makefile'],
  E: ['-E', '--eval'],
  skip: [
    '-o',
    '--old-file',
    '--assume-old',
    '-W',
    '--what-if',
    '--new-file',
    '--assume-new',
    '-I',
    '--include-dir',
  ],
}
const MAKE_OPTIONAL_NUMBER = new Set(['-j', '--jobs', '-l', '--load-average', '--max-load'])
const DIGITS = /^\d/u
// The make flag a word is: its kind (C, f, E or skip), its value, and whether the value was the next word.
const makeFlag = (v: string, next: string) => {
  for (const [kind, names] of Object.entries(MAKE_FLAG_VALUES)) {
    for (const n of names) {
      const long = n.startsWith('--')
      if (v === n) {
        return { kind, value: next, used: 1 }
      }
      if (long ? v.startsWith(`${n}=`) : v.startsWith(n) && v.length > n.length) {
        return { kind, value: v.slice(n.length + (long ? 1 : 0)), used: 0 }
      }
    }
  }
  return
}
// A make word that is no flag: a variable it sets (`*` for -e), or a target.
const makeWord = (v: string) => {
  if (MAKE_ENV_FLAG.test(v)) {
    return { vars: ['*'], targets: [] as string[] }
  }
  if (MAKE_VAR_WORD.test(v)) {
    return { vars: [MAKE_VAR_WORD.exec(v)?.groups?.name ?? ''], targets: [] }
  }
  return v.startsWith('-') || v.includes('=')
    ? { vars: [], targets: [] }
    : { vars: [], targets: [v] }
}
// What a make command line says: the directory, makefiles, --eval texts, variables and targets.
const makeCommandLine = (words: string[], dir: string) => {
  let where = dir
  const files: string[] = []
  const evals: string[] = []
  const targets: string[] = []
  const vars: string[] = []
  for (let i = 0; i < words.length; i++) {
    const v = words[i] ?? ''
    const next = words[i + 1] ?? ''
    const flag = makeFlag(v, next)
    if (flag?.kind === 'C') {
      where = joinPath(where, flag.value) ?? where
    }
    if (flag?.kind === 'f') {
      files.push(flag.value)
    }
    if (flag?.kind === 'E') {
      evals.push(flag.value)
    }
    const word = flag ? { vars: [], targets: [] } : makeWord(v)
    targets.push(...word.targets)
    vars.push(...word.vars)
    i += flag?.used ?? (MAKE_OPTIONAL_NUMBER.has(v) && DIGITS.test(next) ? 1 : 0)
  }
  return { where, files, evals, targets, vars }
}
const makeRecipes = (words: string[], dir: string): Recipe[] => {
  const { where, files, evals, targets, vars } = makeCommandLine(words, dir)
  return (files.length > 0 ? files : [undefined]).flatMap((file) => {
    const source = joinPath(where, file ?? 'Makefile')
    const named = file === undefined ? undefined : source
    return source === undefined
      ? []
      : (targets.length > 0 ? targets : ['']).map((t) =>
          recipe('make', source, t, {
            vars,
            evals,
            names: named === undefined ? MAKE_NAMES : [named.slice(named.lastIndexOf('/') + 1)],
            dir: named === undefined ? where : named.slice(0, named.lastIndexOf('/') || 1),
            cwd: where,
          }),
        )
  })
}
const JUST_NAMES = ['justfile', 'Justfile', '.justfile']
const justRecipes = (words: string[], dir: string): Recipe[] => {
  let file: string | undefined
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
  const source = joinPath(dir, file ?? 'justfile')
  return source === undefined
    ? []
    : (targets.length > 0 ? targets : ['']).map((t) =>
        recipe('just', source, t, {
          names: file === undefined ? JUST_NAMES : [file.slice(file.lastIndexOf('/') + 1)],
          dir: file === undefined ? dir : source.slice(0, source.lastIndexOf('/') || 1),
          up: file === undefined,
        }),
      )
}
// Each package manager's options that take the next word, and the ones that name the directory it runs in.
const NPM_VALUE_FLAGS: Record<string, string[]> = {
  npm: ['--prefix', '-C', '--workspace', '-w', '--userconfig', '--cache', '--registry'],
  pnpm: ['-C', '--dir', '--filter', '-F', '--workspace-dir', '--config'],
  yarn: ['--cwd', '--cache-folder', '--registry'],
  bun: ['--cwd', '--filter', '-c', '--config', '--env-file', '--preload', '-r', '--registry'],
}
const NPM_DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd'])
const NPM_WORKSPACE_FLAGS = new Set(['-w', '--workspace', '--filter', '-F'])
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn'])
// The scripts a package manager runs besides the one named, for the verbs that run a package's lifecycle.
const NPM_LIFECYCLE_VERBS: Record<string, string[]> = {
  install: ['install', 'prepare'],
  pack: ['pack', 'prepare'],
  publish: ['publish', 'prepublishOnly', 'pack', 'prepare'],
  version: ['version'],
  rebuild: ['install', 'prepare'],
}
const NPM_VERB_ALIASES: Record<string, string> = {
  i: 'install',
  in: 'install',
  ins: 'install',
  inst: 'install',
  insta: 'install',
  instal: 'install',
  add: 'install',
  ci: 'install',
  ic: 'install',
  'clean-install': 'install',
  it: 'install',
  'install-test': 'install',
  update: 'install',
  up: 'install',
  upgrade: 'install',
  link: 'install',
  ln: 'install',
  rb: 'rebuild',
  'install-ci-test': 'install',
  cit: 'install',
}
// Bun's own commands: any other first word is a package.json script.
const BUN_COMMANDS = new Set(
  'run x install i add a remove rm update upgrade test build init create c link unlink pm repl publish outdated why audit info patch exec completions help feedback'.split(
    ' ',
  ),
)
// A package manager's leading options: where they point it, and the words from its command on.
const npmOptions = (name: string, words: string[], dir: string) => {
  let where = dir
  const workspaces: string[] = []
  let i = 0
  const valued = NPM_VALUE_FLAGS[name] ?? []
  while (i < words.length && words[i]?.startsWith('-')) {
    const [flag = '', attached] = (words[i] ?? '').split('=')
    if (valued.includes(flag)) {
      if (NPM_WORKSPACE_FLAGS.has(flag) && (attached ?? words[i + 1]) !== undefined) {
        workspaces.push(attached ?? words[i + 1] ?? '')
      }
      where = NPM_DIR_FLAGS.has(flag)
        ? (joinPath(where, attached ?? words[i + 1] ?? '') ?? where)
        : where
      i += attached === undefined ? 2 : 1
    } else {
      i += 1
    }
  }
  return { where, workspaces, words: words.slice(i) }
}
// The scripts a package manager command runs.
const npmTargets = (name: string, [head, ...rest]: string[]) => {
  const valued = NPM_VALUE_FLAGS[name] ?? []
  const lifecycle = NPM_LIFECYCLE_VERBS[NPM_VERB_ALIASES[head ?? ''] ?? head ?? '']
  if (head === undefined) {
    return []
  }
  if (NPM_RUN.has(head)) {
    const at = rest.findIndex((w, k) => !(w.startsWith('-') || valued.includes(rest[k - 1] ?? '')))
    return at < 0 ? [] : [rest[at] ?? '']
  }
  if (lifecycle !== undefined) {
    return lifecycle
  }
  if (name === 'npm') {
    return NPM_LIFECYCLE.has(head) ? [head === 't' || head === 'tst' ? 'test' : head] : []
  }
  return name === 'bun' && (BUN_COMMANDS.has(head) || head.includes('/') || head.includes('.'))
    ? []
    : [head]
}
const npmRecipes = (name: string, words: string[], dir: string): Recipe[] => {
  const opts = npmOptions(name, words, dir)
  // `yarn workspace NAME SCRIPT` names the workspace like -w does.
  if (name === 'yarn' && opts.words[0] === 'workspace' && opts.words[1] !== undefined) {
    opts.workspaces.push(opts.words[1])
    opts.words = opts.words.slice(2)
  }
  const source = joinPath(opts.where, 'package.json')
  return source === undefined
    ? []
    : [...new Set(npmTargets(name, opts.words))].flatMap((t) =>
        (opts.workspaces.length > 0 ? opts.workspaces : [undefined]).map((workspace) =>
          recipe('npm', source, t, { up: true, workspace }),
        ),
      )
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

// A file's text: what was read or written, or the source a copy or link of it names.
const readOf = (w: W, file: string) => {
  let at = file
  for (let hops = 0; hops < 8; hops++) {
    const text = w.script.files?.get(at)
    const next = w.script.copies?.get(at)
    if (text !== undefined || next === undefined) {
      return text
    }
    at = next
  }
  return
}
export const fileScriptOf = (w: W, call: Call): Piece | undefined => {
  const file = scriptFileOf(call, w.opts.cwd)
  const read = file === undefined ? undefined : readOf(w, file)
  if (read !== undefined) {
    return { text: read, base: undefined, file }
  }
  const exec = execFileOf(call, w.opts.cwd)
  const body = exec === undefined ? undefined : w.script.files?.get(exec)
  if (body !== undefined && isShScript(body)) {
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
// The patterns a workspace root lists: package.json `workspaces` (an array, or `{packages}`) and
// pnpm-workspace.yaml `packages:`. `!` exclusions are dropped.
const PNPM_PACKAGES = /^packages:[ \t]*\n(?<body>(?:[ \t]+-.*\n?|[ \t]*#.*\n?|[ \t]*\n)*)/mu
const PNPM_ITEM = /^[ \t]+-[ \t]*['"]?(?<p>[^'"#\n]+?)['"]?[ \t]*(?:#.*)?$/gmu
export const workspacePatterns = (packageJson: string, pnpmYaml: string): string[] => {
  let listed: unknown
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const ws = (parsed as { workspaces?: unknown } | null)?.workspaces
    listed = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages
  } catch {
    listed = undefined
  }
  const fromJson = Array.isArray(listed)
    ? listed.filter((p): p is string => typeof p === 'string')
    : []
  const block = PNPM_PACKAGES.exec(pnpmYaml)?.groups?.body ?? ''
  const fromYaml = [...block.matchAll(PNPM_ITEM)].map((m) => m.groups?.p ?? '')
  return [...fromJson, ...fromYaml].filter((p) => p !== '' && !p.startsWith('!'))
}
const SELECTOR_DECOR = /^\.\.\.|\.\.\.$|^\.\/|\/$/gu
const WORKSPACE_GLOB = /[*?[\]{}!]/u
// Whether a package of this name or at this root-relative path is what a -w / --filter selector names.
// `...name` and `name...` (pnpm's dependency selectors) name the package itself; a glob or exclusion names no one.
export const selectsWorkspace = (selector: string, name: string | undefined, relDir: string) => {
  const s = selector.replace(SELECTOR_DECOR, '')
  return s !== '' && !WORKSPACE_GLOB.test(s) && (s === name || s === relDir)
}
