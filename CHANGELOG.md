# Changelog

## [Unreleased]

### Fixed

- A shell given `-s` or a stdin path (`bash -s ARGS <<EOF`, `bash /dev/stdin`) reads its commands from stdin even when a file of that operand name is on record, so its heredoc is walked.
- `gate push` runs `push` as a program, so it is no longer read as one of gate's own verbs; `actions-allowed` is.

### Added

- A script a command writes with `tee`, `cp`, `mv`, `ln` or `base64 -d` is read as the body it will hold; a file whose content only the run knows is listed in `Script.unknown` and a copy of a file on disk in `Script.copies`.
- `taskset`, `nsenter`, `firejail`, `bwrap`, `systemd-inhibit`, `toolbox run`, `distrobox enter`, `podman unshare` and `screen` run the command after their options; `fish -c`, `tmux new-session|new-window|send-keys` and `nix-shell --run` hand their text to a shell.
- A script read by path binds `$0` and `BASH_SOURCE` (also `${BASH_SOURCE[0]}`) to its own path, so `$(dirname "$0")` resolves. A sourced file binds only `BASH_SOURCE`.
- `printf` and `echo -e` output is decoded (escapes, `%s` and `%b`) before a shell that reads it from a pipe is parsed, and `Call.opaqueStdin` marks a shell fed by any other pipe producer.

- The Bash command reader, extracted from nomad-hud's guards: `commandsOf`, `scriptOf`, `gitVerb` and the word readers.
