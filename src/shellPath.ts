// A path with `.` and `..` resolved, as the kernel walks it.
const normalize = (path: string) => {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '..') {
      parts.pop()
    } else if (p !== '' && p !== '.') {
      parts.push(p)
    }
  }
  return `/${parts.join('/')}`
}
export const joinPath = (base: string | undefined, path: string) => {
  if (path.startsWith('/')) {
    return normalize(path)
  }
  return base === undefined || path.startsWith('~') ? undefined : normalize(`${base}/${path}`)
}

const CDPATH_EXEMPT = /^(?:\/|\.\.?(?:\/|$))/u
const STACK_INDEX = /^[+-]\d+$/u
// An option of cd or pushd; `-` and `-N` name a directory (the previous one, a stack entry).
export const isCdFlag = (v: string | undefined) =>
  v?.startsWith('-') === true && v !== '-' && !STACK_INDEX.test(v)
/** Where `cd`/`pushd` to value leaves the shell: unknown for `-`, a directory-stack index, or a relative name
 * while CDPATH is set, which searches other directories first. */
export const cdTo = (
  scope: { cwd: string | undefined; env: Map<string, string> },
  assigns: Map<string, string>,
  value: string | undefined,
) =>
  value === undefined ||
  value === '-' ||
  STACK_INDEX.test(value) ||
  (!CDPATH_EXEMPT.test(value) && (scope.env.has('CDPATH') || assigns.has('CDPATH')))
    ? undefined
    : joinPath(scope.cwd, value)
