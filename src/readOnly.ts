// The programs and subcommands that only read, shared by every consumer of the call reader. No engine imports.

export const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
])
export const READ_ONLY_RGIT = new Set([
  'diff',
  'show',
  'blame',
  'log',
  'context',
  'symbols',
  'find',
])
export const SEARCH_PROGRAMS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'fd',
  'fdfind',
])
export const READ_PROGRAMS = new Set([
  'cat',
  'head',
  'tail',
  'bat',
  'jq',
  'wc',
  'stat',
  'file',
  'uniq',
  'cut',
  'tr',
  'column',
  'nl',
])
export const LIST_PROGRAMS = new Set(['ls', 'tree', 'du'])
