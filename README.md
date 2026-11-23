# shell-parse

Reads a Bash command as the calls a shell would run: each call's program, arguments and redirects,
seen through `sudo`, `env`, `bash -c`, substitutions, functions and git aliases.

```ts
import { commandsOf, scriptOf } from './shell'
import { parseJson } from './shellNodes'

const parse = (text: string) =>
  parseJson(Bun.spawnSync(['shfmt', '--to-json'], { stdin: Buffer.from(text) }).stdout.toString())
const script = scriptOf('cd /a && git -C b log | head', parse)
const calls = script ? commandsOf(script) : []
```

Install `@rethunk-tech/shell-parse` from GitHub Packages (`@rethunk-tech:registry=https://npm.pkg.github.com` in `.npmrc`, with a token that has `read:packages`) and import its modules by path, as `@rethunk-tech/shell-parse/src/shell.ts`. It needs shfmt 3.7.0 at run time.
