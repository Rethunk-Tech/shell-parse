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

// Walks of other scripts, kept across commands: the same command text over the same script files, alias and
// function snapshot and options gives the same calls, so a repeat guard of an unchanged script is a lookup. A walk
// that recorded files into the script is kept with them, and a hit records them again.
const KEPT = 16
const ids = new WeakMap<object, number>()
let nextId = 0
const idOf = (o: object | undefined) => {
  if (o === undefined) {
    return 0
  }
  if (!ids.has(o)) {
    nextId += 1
    ids.set(o, nextId)
  }
  return ids.get(o)
}
const envKey = (env: ShellEnv | undefined) =>
  env === undefined
    ? ''
    : JSON.stringify([
        [...env.aliases],
        [...env.functions].map(([k, f]) => [k, f.text]),
        [...(env.gitAliases ?? [])],
      ])
const keptKey = (script: Script, opts: WalkOptions, key: string) =>
  JSON.stringify([
    script.text,
    [...(script.files ?? [])],
    opts.cwd,
    opts.home,
    idOf(opts.known),
    envKey(script.env),
    key,
  ])
interface Recorded {
  files: [string, string][]
  unknown: string[]
  copies: [string, string][]
}
const recorded = (s: Script, was: number[]): Recorded => ({
  files: [...(s.files ?? [])].slice(was[0]),
  unknown: [...(s.unknown ?? [])].slice(was[1]),
  copies: [...(s.copies ?? [])].slice(was[2]),
})
const sizes = (s: Script) => [s.files?.size ?? 0, s.unknown?.size ?? 0, s.copies?.size ?? 0]
const replay = (s: Script, r: Recorded) => {
  s.files ??= new Map()
  s.unknown ??= new Set()
  s.copies ??= new Map()
  for (const [k, v] of r.files) {
    s.files.set(k, v)
  }
  for (const k of r.unknown) {
    s.unknown.add(k)
  }
  for (const [k, v] of r.copies) {
    s.copies.set(k, v)
  }
}

export const memoWalk = <T>(walk: (script: Script, opts: WalkOptions) => T) => {
  interface Walked {
    key: string
    env: ShellEnv | undefined
    out: T
  }
  const recent = new Map<string, { out: T; added: Recorded }>()
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
    const kept = script.files?.size ? keptKey(script, opts, walkKey(script, opts)) : undefined
    const seen = kept === undefined ? undefined : recent.get(kept)
    if (seen !== undefined) {
      recent.delete(kept as string)
      recent.set(kept as string, seen)
      replay(script, seen.added)
      byPlace.set(place, { key: walkKey(script, opts), env: script.env, out: seen.out })
      return seen.out
    }
    const before = sizes(script)
    const out = walk(script, opts)
    if (kept !== undefined) {
      recent.set(kept, { out, added: recorded(script, before) })
      if (recent.size > KEPT) {
        recent.delete(recent.keys().next().value as string)
      }
    }
    byPlace.set(place, { key: walkKey(script, opts), env: script.env, out })
    return out
  }
}
