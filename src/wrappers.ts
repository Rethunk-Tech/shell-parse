// The commands that run another command after their own options (sudo, env, timeout, uv run, ...). No engine imports.
export const SHELL_FLAGS = new Set(['-c', '--command'])
// Whether a `-c CMD` / `--command=CMD` comes before any `--`.
export const hasShellFlag = (words: { value?: string }[], from: number) => {
  const dashes = words.findIndex((w, k) => k >= from && w.value === '--')
  return words
    .slice(from, dashes < 0 ? undefined : dashes)
    .some((w) => SHELL_FLAGS.has(w.value ?? '') || (w.value ?? '').startsWith('--command='))
}
// Commands that run the command after their own options, with the options that take a value, and
// how many words (timeout's duration) sit between those and the command. `sub` is the subcommand that runs it
// (`uv run`, `pnpm exec`); `dashes` means the command follows the first `--` when there is one (`mise exec
// node@20 -- cmd`), the words before it being options and tool names.
export interface WrapperSpec {
  values: string[]
  lead?: number
  sub?: string
  // A second spelling of `sub` (`mise x`).
  alias?: string
  // `-c CMD` / `--command CMD` runs CMD in a shell, so the wrapper has no command words.
  shell?: boolean
  // `workspace NAME` may come before `sub` (`yarn workspace web exec cmd`).
  workspace?: boolean
  dashes?: boolean
  // Tool words (`node@20`) that sit between the options and the command, with no `--` after them.
  tools?: boolean
  // Options that take two words (`bwrap --bind SRC DEST`).
  pairs?: string[]
  // Options that name what `lead` would count (`taskset -c LIST cmd` has no mask word).
  leadUnless?: string[]
}
export const WRAPPERS = new Map<string, WrapperSpec>([
  [
    'uv',
    {
      sub: 'run',
      values: [
        '--with',
        '--with-editable',
        '--with-requirements',
        '--python',
        '-p',
        '--project',
        '--directory',
        '--env-file',
        '--extra',
        '--group',
        '--package',
        '--index',
        '--default-index',
        '--index-url',
        '-i',
        '--extra-index-url',
        '--find-links',
        '-f',
        '--no-install-package',
        '--reinstall-package',
        '--upgrade-package',
        '-P',
        '--cache-dir',
        '--config-file',
        '--exclude-newer',
        '--link-mode',
        '--script',
      ],
    },
  ],
  ['poetry', { sub: 'run', values: ['-C', '--directory', '-P', '--project'] }],
  ['pnpm', { sub: 'exec', values: ['-C', '--dir', '--filter', '-F'] }],
  ['yarn', { sub: 'exec', values: ['--cwd'], workspace: true }],
  [
    'mise',
    {
      sub: 'exec',
      alias: 'x',
      shell: true,
      dashes: true,
      tools: true,
      values: ['-C', '--cd', '-j', '--jobs', '-E', '--env'],
    },
  ],
  ['direnv', { sub: 'exec', values: [], lead: 1 }],
  ['dotenv', { values: ['-e', '-v', '-c', '-p'] }],
  ['op', { sub: 'run', values: ['--env-file', '--account', '--session', '--cache'] }],
  ['chronic', { values: [] }],
  ['sudo', { values: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'] }],
  ['doas', { values: ['-u', '-C'] }],
  ['env', { values: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'] }],
  ['command', { values: [] }],
  ['builtin', { values: [] }],
  ['exec', { values: ['-a'] }],
  ['nohup', { values: [] }],
  ['setsid', { values: [] }],
  ['nice', { values: ['-n', '--adjustment'] }],
  ['ionice', { values: ['-c', '-n', '-p', '--class', '--classdata'] }],
  ['stdbuf', { values: ['-i', '-o', '-e'] }],
  ['time', { values: ['-f', '-o', '--format', '--output'] }],
  ['timeout', { values: ['-s', '-k', '--signal', '--kill-after'], lead: 1 }],
  ['xargs', { values: ['-I', '-n', '-P', '-d', '-L', '-s', '-a', '-E', '--delimiter'] }],
  ['watch', { values: ['-n', '--interval', '-q', '--equexit'] }],
  ['busybox', { values: [] }],
  ['unbuffer', { values: [] }],
  ['strace', { values: ['-o', '-e', '-p', '-s', '-u', '-E', '-P', '-b', '-I'] }],
  ['ltrace', { values: ['-o', '-e', '-p', '-s', '-u', '-n'] }],
  ['valgrind', { values: [] }],
  ['unshare', { values: [] }],
  ['pkexec', { values: ['--user'] }],
  ['setpriv', { values: [] }],
  ['chroot', { values: [], lead: 1 }],
  [
    'taskset',
    { values: ['-c', '--cpu-list'], lead: 1, leadUnless: ['-c', '--cpu-list', '-p', '--pid'] },
  ],
  ['nsenter', { values: ['-t', '--target', '-S', '--setuid', '-G', '--setgid'] }],
  ['firejail', { values: [] }],
  [
    'bwrap',
    {
      values: [
        '--chdir',
        '--uid',
        '--gid',
        '--hostname',
        '--dev',
        '--proc',
        '--tmpfs',
        '--dir',
        '--mqueue',
        '--remount-ro',
        '--unsetenv',
        '--cap-add',
        '--cap-drop',
        '--seccomp',
        '--lock-file',
        '--sync-fd',
        '--userns',
        '--userns2',
        '--pidns',
        '--exec-label',
        '--file-label',
        '--block-fd',
        '--info-fd',
        '--json-status-fd',
        '--args',
        '--perms',
        '--size',
      ],
      pairs: [
        '--bind',
        '--bind-try',
        '--ro-bind',
        '--ro-bind-try',
        '--dev-bind',
        '--dev-bind-try',
        '--symlink',
        '--setenv',
        '--file',
        '--bind-data',
        '--ro-bind-data',
        '--chmod',
        '--arg',
      ],
    },
  ],
  ['systemd-inhibit', { values: ['--what', '--who', '--why', '--mode'] }],
  ['toolbox', { sub: 'run', values: ['-c', '--container', '-d', '--distro', '-r', '--release'] }],
  [
    'distrobox',
    {
      sub: 'enter',
      dashes: true,
      lead: 1,
      leadUnless: ['-n', '--name'],
      values: ['-n', '--name', '-a', '--additional-flags'],
    },
  ],
  [
    'podman',
    {
      sub: 'unshare',
      values: [
        '--root',
        '--runroot',
        '--storage-driver',
        '--storage-opt',
        '--log-level',
        '-c',
        '-r',
      ],
    },
  ],
  ['screen', { values: ['-S', '-dmS', '-DmS', '-t', '-c', '-p', '-e', '-h', '-T', '-s'] }],
  ['chrt', { values: [], lead: 1 }],
  [
    'flock',
    {
      values: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code', '-c', '--command'],
      lead: 1,
    },
  ],
  [
    'systemd-run',
    {
      values: ['-p', '-u', '-E', '-M', '--property', '--unit', '--setenv', '--slice', '--machine'],
    },
  ],
])
