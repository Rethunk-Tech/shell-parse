// The commands that run another command after their own options (sudo, env, timeout, uv run, ...). No engine imports.
// Commands that run the command after their own options, with the options that take a value, and
// how many words (timeout's duration) sit between those and the command. `sub` is the subcommand that runs it
// (`uv run`, `pnpm exec`); `dashes` means the command follows the first `--` when there is one (`mise exec
// node@20 -- cmd`), the words before it being options and tool names.
export interface WrapperSpec {
  values: string[]
  lead?: number
  sub?: string
  dashes?: boolean
  // Tool words (`node@20`) that sit between the options and the command, with no `--` after them.
  tools?: boolean
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
  ['pnpm', { sub: 'exec', values: ['-C', '--dir', '--filter', '-F', '--shell-mode'] }],
  ['yarn', { sub: 'exec', values: ['--cwd'] }],
  [
    'mise',
    {
      sub: 'exec',
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
