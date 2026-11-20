// Commands parsed by the real shfmt.
import { commandsOf, scriptOf } from '../src/shell.ts'
import { parseJson, type ShellEnv, type WalkOptions } from '../src/shellNodes.ts'

export const parse = (text: string) =>
  parseJson(Bun.spawnSync(['shfmt', '--to-json'], { stdin: Buffer.from(text) }).stdout.toString())

export const sh = (command: string, env?: ShellEnv) => {
  const script = scriptOf(command, parse, env)
  if (!script) {
    throw new Error(`shfmt refused: ${command}`)
  }
  return script
}
export const calls = (command: string, opts: WalkOptions = { cwd: '/s', home: '/h' }) =>
  commandsOf(sh(command), opts)
