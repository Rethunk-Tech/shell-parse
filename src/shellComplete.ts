// Completes a parsed command: parses every script it runs that the first parse did not reach.

import type { Node, Script } from './shellNodes.ts'

const MAX_PASSES = 6

// The loop yields each script text it needs parsed and takes its parse back, so one loop serves a sync and an
// async parser. `missingOf` is the walk that reports the texts not parsed yet.
export function* completing(
  script: Script,
  missingOf: (script: Script) => Set<string>,
): Generator<string, Script, Node | undefined> {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const missing = missingOf(script)
    for (const t of missing) {
      script.nested.set(t, yield t)
    }
    if (missing.size === 0) {
      return script
    }
  }
  // Past the pass cap the rest is unreadable, which the guards treat as unparsed rather than clean.
  for (const t of missingOf(script)) {
    script.nested.set(t, undefined)
  }
  return script
}
