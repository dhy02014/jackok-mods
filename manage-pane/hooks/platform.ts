// Path and argv helpers for POSIX and native Windows. Each plugin keeps its own copy of the
// helpers it uses (a plugin cannot import from another's folder); tests/platform.test.ts
// pins this copy. No `$` here: register.tsx runs the argv these build, only for the
// optional CLI-format mirror, since `$.fs` has no rename or delete.

// A drive-letter or UNC path, in either separator: Windows, where there is no mv or rm.
// On POSIX, mv and rm resolve through PATH: not every system keeps them in /bin.
export const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)

// `/` separators and no trailing one: the single form a home or cwd takes before `$.fs`
// or a comparison sees it.
export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/([^:])\/+$/, '$1')

const native = (p: string) => p.replace(/\//g, '\\')

// The argv joiner quotes only a path holding a space, tab or `"`, so cmd would run the rest of
// a path holding one of these as commands (`a&calc`); such a path gets no argv at all.
const CMD_META = /[&|<>^%!"]/

// Renames `from` over `to`; `undefined` when cmd cannot be handed the paths safely, which the
// caller treats as a failed run.
export const moveArgv = (from: string, to: string): string[] | undefined => {
  if (!isWindowsPath(to)) return ['mv', '-f', from, to]
  return CMD_META.test(from + to) ? undefined : ['cmd', '/d', '/c', 'move', '/y', native(from), native(to)]
}

// Deletes `path`; a missing file is not an error on either side. `undefined` as for moveArgv.
export const removeArgv = (path: string): string[] | undefined => {
  if (!isWindowsPath(path)) return ['rm', '-f', path]
  return CMD_META.test(path) ? undefined : ['cmd', '/d', '/c', 'del', '/f', '/q', native(path)]
}
