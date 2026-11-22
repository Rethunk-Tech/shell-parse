# Changelog

## [Unreleased]

### Fixed

- A `$'\U...'` escape past the last code point keeps its text instead of throwing out of the walk.
- `bash -c "$CMD"` and `eval "$CMD"` run the value the variable holds, not the source word: a known variable's command is walked, and a multi-word `eval` joins the words' values.
- A compound pipeline stage (`(echo CMD) | sh`, `{ printf ...; } | bash`) feeds its written-out output to the next stage, so the shell's script is walked.
- A shell's `--rcfile FILE` / `--init-file FILE` (`--rcfile=FILE`) takes its value, so `bash --rcfile x -c CMD` runs CMD instead of reading the rc file as its script.
- An unquoted brace list or range (`{git,stash}`) and an unquoted variable that holds a blank, or any variable once IFS is set, read as a word only the run knows, since the shell expands them into several words.
- `env -S'git stash'` and `env -vS'git stash'`, with the script attached to the flag, are read as the script they run.
- An alias that ends in a blank hands the next word to alias expansion; an alias whose value only the run knows reads as a program no one can name; `hash -p PATH NAME` binds NAME as an alias does.
- git's own programs (`/usr/libexec/git-core/git-reset`, `git-stash`) read as `git reset`, `git stash`.
- Text that arithmetic, `let`, `[[ ]]`, `declare`, `printf -v`, `read` or `${x@P}` evaluates is walked for the `$(...)` it holds.
- `commandsOf` keeps its last 48 walks across scripts, keyed by command text, script file contents, alias and function snapshot and options, so a repeat guard of an unchanged 108 KB script is a lookup; an edited file is walked again.
- A script whose functions call each other in a tree no longer walks every call's body again without limit: past 10,000 expansions a body is walked once, where it is declared. A 100 KB script of such helpers took 22 s to walk.
- A command tmux starts (`new-session`, `new-window`, `split-window`, `send-keys`, and `run-shell` or `if-shell` with `-b`) is read as detached, so its calls carry `background`.
- bwrap's three-word `--overlay RWSRC WORKDIR DEST` and its single-value `--overlay-src`, `--tmp-overlay`, `--ro-overlay`, `--argv0`, `--add-seccomp-fd` and `--userns-block-fd` no longer hide the command bwrap runs.
- `cp`, `mv` and `ln` with more than two operands track each source into `DIR/<name>` of the last one.
- A shell given `-s` or a stdin path (`bash -s ARGS <<EOF`, `bash /dev/stdin`) reads its commands from stdin even when a file of that operand name is on record, so its heredoc is walked.
- `gate push` runs `push` as a program, so it is no longer read as one of gate's own verbs; `actions-allowed` is.

### Added

- A script a command writes with `tee`, `cp`, `mv`, `ln` or `base64 -d` is read as the body it will hold; a file whose content only the run knows is listed in `Script.unknown` and a copy of a file on disk in `Script.copies`.
- `taskset`, `nsenter`, `firejail`, `bwrap`, `systemd-inhibit`, `toolbox run`, `distrobox enter`, `podman unshare` and `screen` run the command after their options; `fish -c`, `tmux new-session|new-window|send-keys` and `nix-shell --run` hand their text to a shell.
- A script read by path binds `$0` and `BASH_SOURCE` (also `${BASH_SOURCE[0]}`) to its own path, so `$(dirname "$0")` resolves. A sourced file binds only `BASH_SOURCE`.
- `printf` and `echo -e` output is decoded (escapes, `%s` and `%b`) before a shell that reads it from a pipe is parsed, and `Call.opaqueStdin` marks a shell fed by any other pipe producer.

- The Bash command reader, extracted from nomad-hud's guards: `commandsOf`, `scriptOf`, `gitVerb` and the word readers.
