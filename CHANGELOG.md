# Changelog

## [Unreleased]

### Fixed

- `gate push` runs `push` as a program, so it is no longer read as one of gate's own verbs; `actions-allowed` is.

### Added

- A script read by path binds `$0` and `BASH_SOURCE` (also `${BASH_SOURCE[0]}`) to its own path, so `$(dirname "$0")` resolves. A sourced file binds only `BASH_SOURCE`.
- `printf` and `echo -e` output is decoded (escapes, `%s` and `%b`) before a shell that reads it from a pipe is parsed, and `Call.opaqueStdin` marks a shell fed by any other pipe producer.

- The Bash command reader, extracted from nomad-hud's guards: `commandsOf`, `scriptOf`, `gitVerb` and the word readers.
