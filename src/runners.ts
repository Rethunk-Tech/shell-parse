// Commands that run another command or script from their own arguments (find -exec, env -S, trap,
// flock, su -c, script -c, parallel, git submodule foreach, git rebase -x). No engine imports.
import type { Call, Piece, Word, Wrapper } from './shellNodes.ts'
import { gitVerb, joinPath } from './shellWords.ts'
import { SHELL_FLAGS } from './wrappers.ts'

const joinedRaw = (words: Word[]) => ({ text: words.map((a) => a.raw).join(' '), base: undefined })
const NPM_EXEC = new Set(['exec', 'x'])
const SCRIPT_C = /^-[a-zA-Z]*c$/u
const RUN_FLAG = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const FD_EXEC = new Set(['-x', '--exec', '-X', '--exec-batch'])
// `-HX rm`: the exec flag ends a short-option cluster; `--exec=rm` carries its first word attached.
const FD_EXEC_CLUSTER = /^-[A-Za-z]*[xX]$/u
const FD_EXEC_ATTACHED = /^--exec(?:-batch)?=(?<first>.*)$/su
const SCRIPT_FLAG = new Set(['-c', '--command', '-x', '--exec'])
const FILTERS = new Set([
  '--env-filter',
  '--tree-filter',
  '--index-filter',
  '--parent-filter',
  '--msg-filter',
  '--commit-filter',
  '--tag-name-filter',
  '--setup',
])
const TRANSPORT = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'archive', 'send-pack'])
// rebase's `-xCMD`, and `-ix CMD` where the group ends in x: the command is the rest of the word or the next one.
const EXEC_ATTACHED = /^-[a-wyzA-Z]*x(?<cmd>.*)$/u
const attachedExec = (words: Word[]) =>
  words.flatMap((a, i) => {
    const cmd = EXEC_ATTACHED.exec(a.value ?? '')?.groups?.cmd
    const next = words[i + 1]
    if (cmd === undefined) {
      return []
    }
    if (cmd === '') {
      return next ? [next.script] : []
    }
    return [{ text: cmd, base: undefined }]
  })
// env's -S takes its script attached too: `-S'git stash'`, `-vS'git stash'`.
const ENV_SPLIT = /^-[iv0]*S(?<script>.+)$/su
const optionValue = (words: Word[], names: Set<string>) =>
  words.flatMap((a, i) => {
    const v = a.value ?? ''
    const attached = names.has('-S') ? ENV_SPLIT.exec(v)?.groups?.script : undefined
    if (attached !== undefined) {
      return [{ text: attached, base: undefined }]
    }
    const eq = v.indexOf('=')
    if (eq > 0 && names.has(v.slice(0, eq))) {
      return [{ text: v.slice(eq + 1), base: undefined }]
    }
    const next = words[i + 1]
    return names.has(v) && next ? [next.script] : []
  })
// The scripts a git subcommand hands a shell: foreach, rebase --exec, bisect run, filter-branch filters, a
// diff tool's command, and a local transport's helper programs.
const gitPieces = (call: Call): Piece[] => {
  const verb = gitVerb(call)
  const rest = call.argv.slice((verb?.at ?? 0) + 1)
  const sub = rest.findIndex((a) => !a.value?.startsWith('-'))
  if (verb?.verb === 'submodule' && rest[sub]?.value === 'foreach') {
    // foreach joins its arguments into one script for sh to run; only the words before the command are options.
    const words = rest.slice(sub + 1)
    const at = words.findIndex((a) => !a.value?.startsWith('-'))
    const command = at < 0 ? [] : words.slice(at)
    const [only] = command
    return [
      command.length === 1 && only
        ? only.script
        : { text: command.map((a) => a.value ?? '').join(' '), base: undefined },
    ]
  }
  if (verb?.verb === 'rebase') {
    return [...optionValue(rest, SCRIPT_FLAG), ...attachedExec(rest)]
  }
  if (verb?.verb === 'bisect' && rest[0]?.value === 'run') {
    return [joinedRaw(rest.slice(1))]
  }
  if (verb?.verb === 'filter-branch') {
    return optionValue(rest, FILTERS)
  }
  if (verb?.verb === 'difftool' || verb?.verb === 'mergetool') {
    return optionValue(rest, new Set(['-x', '--extcmd']))
  }
  if (verb?.verb !== undefined && TRANSPORT.has(verb.verb)) {
    // A local transport runs these through a shell.
    const names = new Set(['--upload-pack', '--receive-pack', '--exec'])
    if (verb.verb === 'clone') {
      names.add('-u')
    }
    return optionValue(rest, names)
  }
  return []
}
// ssh options that take the next word, so it is not the host.
const SSH_VALUE_OPT = /^-[BbcDEeFIiJLlmOopQRSWw]$/u
// localhost, a loopback address, or this machine's own name by substitution.
const LOCAL_HOST =
  /^"?(?:[^@]*@)?(?:localhost|127(?:\.\d+){3}|\[?::1\]?|\$\(hostname[^)]*\)|`hostname[^`]*`|\$\{?HOSTNAME\}?)"?$/u
// ssh to this machine runs its command here, past every guard: the command is read as typed.
const sshPieces = (args: Word[]): Piece[] => {
  const at = args.findIndex(
    (a, i) => !(a.raw.startsWith('-') || SSH_VALUE_OPT.test(args[i - 1]?.raw ?? '')),
  )
  const host = args[at]
  if (host === undefined || !LOCAL_HOST.test(host.raw)) {
    return []
  }
  const rest = args.slice(at + 1)
  const command = rest[0]?.raw === '--' ? rest.slice(1) : rest
  // ssh hands the remote shell its arguments joined by spaces, so a quoted argument is the text it holds.
  return [{ text: command.map((w) => w.value ?? w.raw).join(' '), base: undefined }]
}
// gate's flags that take the next word, and the words it claims as its own rather than a command.
const GATE_VALUE_FLAG = /^--?(?:log|tail|timeout|budget|mem|jobs|j)$/u
const GATE_VERBS = new Set([
  'actions-allowed',
  'completion',
  'man',
  'doctor',
  'fix',
  'record',
  'run',
  'quick',
])
// `gate [-C dir] [flags] CMD...` runs CMD; a verb of gate's own, or no command, runs nothing.
const gatePieces = (args: Word[]): Piece[] => {
  let i = 0
  while (i < args.length) {
    const v = args[i]?.value ?? ''
    if (v === '--') {
      return [joinedRaw(args.slice(i + 1))]
    }
    if (!v.startsWith('-')) {
      return GATE_VERBS.has(v) ? [] : [joinedRaw(args.slice(i))]
    }
    i += v === '-C' || GATE_VALUE_FLAG.test(v) ? 2 : 1
  }
  return []
}
// fd's command takes every word after the flag, up to a `;`. `at` indexes the flag in args; `first` is the command's
// first word.
export const fdExec = (args: Word[]): { at: number; first: string | undefined } | undefined => {
  const at = args.findIndex((a) => {
    const v = a.value ?? ''
    return FD_EXEC.has(v) || FD_EXEC_CLUSTER.test(v) || FD_EXEC_ATTACHED.test(v)
  })
  if (at < 0) {
    return
  }
  const attached = FD_EXEC_ATTACHED.exec(args[at]?.raw ?? '')?.groups?.first
  return { at, first: attached ?? args[at + 1]?.value }
}
const fdPieces = (args: Word[]): Piece[] => {
  const exec = fdExec(args)
  if (!exec) {
    return []
  }
  const end = args.findIndex((b, j) => j > exec.at && b.value === ';')
  const words = args.slice(exec.at + 1, end < 0 ? undefined : end)
  const attached = FD_EXEC_ATTACHED.exec(args[exec.at]?.raw ?? '')?.groups?.first
  const text = [...(attached === undefined ? [] : [attached]), ...words.map((a) => a.raw)].join(' ')
  return [{ text, base: undefined }]
}
// tmux options and per-command flags that take a value, so it is not read as the shell command.
const TMUX_VALUE_FLAG = new Set(['-c', '-e', '-F', '-n', '-s', '-t', '-x', '-y', '-N', '-l', '-T'])
const TMUX_BACKGROUND = /^-[A-Za-z]*b/u
const TMUX_WAITS = new Set(['run-shell', 'run', 'if-shell', 'if'])
const TMUX_RUNS = new Set([
  'new-session',
  'new',
  'new-window',
  'neww',
  'split-window',
  'splitw',
  'run-shell',
  'run',
  'respawn-pane',
  'respawnp',
  'respawn-window',
  'respawnw',
  'send-keys',
  'send',
  'if-shell',
  'if',
])
// A tmux command that starts a shell command, or types text into one: the words after its flags.
const tmuxPieces = (args: Word[]): Piece[] => {
  const at = args.findIndex((a) => TMUX_RUNS.has(a.value ?? ''))
  if (at < 0) {
    return []
  }
  const words = args.slice(at + 1).filter((a, i, rest) => {
    const v = a.value ?? ''
    return !(v.startsWith('-') || TMUX_VALUE_FLAG.has(rest[i - 1]?.value ?? ''))
  })
  const verb = args[at]?.value ?? ''
  // run-shell and if-shell hold the client until the command ends, unless -b; the rest start detached.
  const waits =
    TMUX_WAITS.has(verb) && !args.slice(at + 1).some((a) => TMUX_BACKGROUND.test(a.value ?? ''))
  return words.length === 0
    ? []
    : [{ text: words.map((a) => a.value ?? a.raw).join(' '), base: undefined, background: !waits }]
}
const toolPieces = (call: Call, args: Word[]): Piece[] => {
  if (call.name === 'tmux') {
    return tmuxPieces(args)
  }
  if (call.name === 'nix-shell') {
    return optionValue(args, new Set(['--run', '--command']))
  }
  if (call.name === 'fd' || call.name === 'fdfind') {
    return fdPieces(args)
  }
  if (call.name === 'mise') {
    return miseExecPieces(args)
  }
  return call.name === 'gate' ? gatePieces(args) : []
}
// `mise exec|x [TOOL@VER]... -c CMD` runs CMD through a shell (a `--` ends mise's own words).
const miseExecPieces = (args: Word[]): Piece[] => {
  const sub = args.findIndex((a) => a.value === 'exec' || a.value === 'x')
  const end = args.findIndex((a) => a.value === '--')
  return sub < 0 ? [] : optionValue(args.slice(sub + 1, end < 0 ? undefined : end), SHELL_FLAGS)
}
const PNPM_VALUE_FLAG = new Set(['-C', '--dir', '--filter', '-F'])
const PNPM_SHELL_MODE = new Set(['-c', '--shell-mode'])
// `pnpm [opts] exec -c CMD...` runs the command words through a shell; `words` is the wrapper's own, `command` what follows.
const pnpmShellPieces = (words: Word[], command: Word[]): Piece[] => {
  const args = words.slice(1)
  let i = 0
  while (args[i]?.value?.startsWith('-')) {
    i += PNPM_VALUE_FLAG.has(args[i]?.value ?? '') ? 2 : 1
  }
  if (
    args[i]?.value !== 'exec' ||
    !args.slice(i + 1).some((a) => PNPM_SHELL_MODE.has(a.value ?? ''))
  ) {
    return []
  }
  const [only] = command
  return [
    command.length === 1 && only
      ? only.script
      : { text: command.map((w) => w.value ?? w.raw).join(' '), base: undefined },
  ]
}
const wrapperPieces = (w: Wrapper, command: Word[]): Piece[] => {
  if (w.name === 'env') {
    return optionValue(w.words, new Set(['-S', '--split-string']))
  }
  if (w.name === 'flock') {
    return optionValue(w.words, new Set(['-c', '--command']))
  }
  return w.name === 'pnpm' ? pnpmShellPieces(w.words, command) : []
}
export const runnerPieces = (call: Call): Piece[] => {
  const args = call.argv.slice(1)
  const values = args.map((a) => a.value)
  const pieces: Piece[] = []
  pieces.push(...call.wrappers.flatMap((w) => wrapperPieces(w, call.argv)))
  if (call.name === 'env') {
    pieces.push(...optionValue(args, new Set(['-S', '--split-string'])))
  } else if (call.name === 'find') {
    args.forEach((a, i) => {
      if (RUN_FLAG.has(a.value ?? '')) {
        const end = args.findIndex((b, j) => j > i && (b.value === ';' || b.value === '+'))
        pieces.push(joinedRaw(args.slice(i + 1, end < 0 ? undefined : end)))
      }
    })
  } else if (call.name === 'trap') {
    const [handler, ...signals] = values[0] === '--' ? args.slice(1) : args
    if (handler && handler.value !== '-' && signals.length > 0) {
      pieces.push(handler.script)
    }
  } else if (call.name === 'flock' || call.name === 'su' || call.name === 'runuser') {
    pieces.push(...optionValue(args, new Set(['-c', '--command'])))
  } else if (call.name === 'script') {
    // util-linux script runs `-c` through a shell, usually grouped as `-qc CMD` for a pty.
    args.forEach((a, i) => {
      const v = a.value ?? ''
      const next = args[i + 1]
      if (v.startsWith('--command=')) {
        pieces.push({ text: v.slice('--command='.length), base: undefined })
      } else if ((v === '--command' || SCRIPT_C.test(v)) && next) {
        pieces.push(next.script)
      }
    })
  } else if (call.name === 'parallel') {
    const end = values.findIndex((v) => v === ':::' || v === '::::')
    pieces.push(
      joinedRaw(
        args.slice(
          values.findIndex((v) => !v?.startsWith('-')),
          end < 0 ? undefined : end,
        ),
      ),
    )
  } else if (
    call.name === 'npx' ||
    (call.name === 'npm' && NPM_EXEC.has(values.find((v) => !v?.startsWith('-')) ?? ''))
  ) {
    // npx and `npm exec` hand -c's text to a shell.
    pieces.push(...optionValue(args, new Set(['-c', '--call'])))
  } else if (call.name === 'ssh') {
    pieces.push(...sshPieces(args))
  } else if (call.name === 'git') {
    pieces.push(...gitPieces(call))
  }
  pieces.push(...toolPieces(call, args))
  return pieces.filter((p) => p.text.trim() !== '')
}
// `env -C dir cmd` and `env --chdir=dir cmd` run cmd in dir.
const CHDIR_ATTACHED = /^--chdir=(?<dir>.*)$/su
export const wrapperCwd = (wrappers: Wrapper[], cwd: string | undefined) => {
  let at = cwd
  for (const { name, words } of wrappers) {
    if (name !== 'env') {
      continue
    }
    for (const [i, w] of words.entries()) {
      const v = w.value ?? ''
      const spaced = v === '-C' || v === '--chdir'
      const dir = spaced ? words[i + 1]?.value : CHDIR_ATTACHED.exec(v)?.groups?.dir
      if (i > 0 && (spaced || CHDIR_ATTACHED.test(v))) {
        at = dir === undefined || dir === '-' ? undefined : joinPath(at, dir)
      }
    }
  }
  return at
}
