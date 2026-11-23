# AGENTS.md

`shell-parse` reads a Bash command as the calls a shell would run, from the JSON syntax tree of
`shfmt --to-json` (mvdan/sh, 3.7.0). It spawns nothing and imports nothing outside `src/`: the caller runs
shfmt and passes each parse in.

## Shape

- A `vX.Y.Z` tag publishes `@rethunk/shell-parse` to npm; bosun installs it from there.
  nomad-hud vendors `src/*.ts` byte for byte through its own `vendor-shell-parse`
  script, pinned to a commit of this repo. Never edit a vendored copy; change it here, commit, then bump the pin.
- Relative imports keep their `.ts` extension (canon); nomad-hud's vendor script strips it, since its mod engine imports without one.
- `shell.ts` (`commandsOf`, `scriptOf`) walks a tree; `shellWords.ts` reads words, redirects, wrappers and git
  verbs (`gitVerb`); `shellNodes.ts` is the tree's shape; `runners.ts` and `shellExport.ts` are helpers of the walk.

## Gate

`gate` runs lint, typecheck and `bun test`; the tests need `shfmt` on PATH.
