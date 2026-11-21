// Decoding of $'...' and printf %b escapes. No engine imports.
// $'...' words carry C escapes bash decodes before the call runs: `git $'\x70ush'` is a push.
const ANSI_C =
  /\\(?:x(?<hex>[0-9a-fA-F]{1,2})|[uU](?<uni>[0-9a-fA-F]{1,8})|(?<oct>[0-7]{1,3})|c(?<ctl>.)|(?<one>.))/gsu
const ANSI_C_ONE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}
const HEX = 16
const OCTAL = 8
const CONTROL_BIT = 0x40
export const ansiC = (text: string) =>
  text.replace(ANSI_C, (all, ...rest) => {
    const g = rest.at(-1) as Record<string, string | undefined>
    if (g.hex !== undefined) {
      return String.fromCharCode(Number.parseInt(g.hex, HEX))
    }
    if (g.uni !== undefined) {
      return String.fromCodePoint(Number.parseInt(g.uni, HEX))
    }
    if (g.oct !== undefined) {
      return String.fromCharCode(Number.parseInt(g.oct, OCTAL))
    }
    if (g.ctl !== undefined) {
      return String.fromCharCode(
        (g.ctl.toUpperCase().charCodeAt(0) + CONTROL_BIT) % (2 * CONTROL_BIT),
      )
    }
    return ANSI_C_ONE[g.one ?? ''] ?? g.one ?? all
  })
