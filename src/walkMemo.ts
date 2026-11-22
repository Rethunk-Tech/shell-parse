import type { Script, ShellEnv, WalkOptions } from './shellNodes.ts'

// A walk depends only on its script and options, and a consumer walks one command many times (each guard,
// each completion pass); a long script costs a tenth of a second a walk, so a repeat is served from here.
// The key holds every input that changes between walks: the nested and file maps only grow, and the walk
// itself records the files the command writes, so the key is taken after it.
const walkKey = (script: Script, opts: WalkOptions) =>
  JSON.stringify([
    opts.vars,
    script.nested.size,
    script.files?.size,
    script.unknown?.size,
    script.copies?.size,
  ])

export const memoWalk = <T>(walk: (script: Script, opts: WalkOptions) => T) => {
  interface Walked {
    key: string
    env: ShellEnv | undefined
    out: T
  }
  const walked = new WeakMap<Script, Map<WalkOptions['known'], Map<string, Walked>>>()
  return (script: Script, opts: WalkOptions) => {
    const byKnown = walked.get(script) ?? new Map<WalkOptions['known'], Map<string, Walked>>()
    walked.set(script, byKnown)
    const byPlace = byKnown.get(opts.known) ?? new Map<string, Walked>()
    byKnown.set(opts.known, byPlace)
    const place = JSON.stringify([opts.cwd, opts.home])
    const hit = byPlace.get(place)
    if (hit && hit.env === script.env && hit.key === walkKey(script, opts)) {
      return hit.out
    }
    const out = walk(script, opts)
    byPlace.set(place, { key: walkKey(script, opts), env: script.env, out })
    return out
  }
}
