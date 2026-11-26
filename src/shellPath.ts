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
