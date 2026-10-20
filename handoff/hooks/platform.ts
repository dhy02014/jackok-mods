// Path and argv helpers for POSIX and native Windows. Each plugin keeps its own copy of the
// helpers it uses (a plugin cannot import from another's folder); tests/platform.test.ts
// pins this copy. No `$` here: register.tsx runs the argv these build, because `$.fs` has
// no mkdir, rename or delete.

// A drive-letter or UNC path, in either separator: Windows, where mv and mkdir are cmd's.
export const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)

// `/` separators and no trailing one: the single form a home or cwd takes before git, `$.fs`
// or a comparison sees it. Git for Windows prints `C:/Users/...`, so its output matches as is.
export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/([^:])\/+$/, '$1')

// A drive-letter path folds case: the session may report `c:\...` while USERPROFILE is `C:\...`.
const folded = (p: string) => (/^[A-Za-z]:/.test(p) ? p.toLowerCase() : p)

// Whether `path` is `root` or inside it, whatever either's separators.
export const isUnder = (path: string, root: string) => {
  const p = folded(slashed(path))
  const r = folded(slashed(root))
  return p === r || p.startsWith(`${r}/`)
}

const native = (p: string) => p.replace(/\//g, '\\')

// The argv joiner quotes only a path holding a space, tab or `"`, so cmd would run the rest of
// a path holding one of these as commands (`a&calc`); such a path gets no argv at all.
const CMD_META = /[&|<>^%!"]/

// Moves `from` to `to` and never replaces a file already at `to` (`mv -n`). cmd's `/-y`:
// Microsoft documents that it prompts before overwriting an existing destination; nothing
// answers here, so the run ends at the caller's timeout with the file in place (not measured
// on Windows; the caller's post-move check is what holds). `undefined` when cmd cannot be
// handed the paths safely, which the caller treats as a failed run. mv and mkdir resolve
// through PATH: not every system keeps them in /bin.
export const moveArgv = (from: string, to: string): string[] | undefined => {
  if (!isWindowsPath(to)) return ['mv', '-n', from, to]
  return CMD_META.test(from + to) ? undefined : ['cmd', '/d', '/c', 'move', '/-y', native(from), native(to)]
}

// Creates `dir` and any missing parent, as `mkdir -p` does. `undefined` as for moveArgv.
export const mkdirArgv = (dir: string): string[] | undefined => {
  if (!isWindowsPath(dir)) return ['mkdir', '-p', dir]
  return CMD_META.test(dir) ? undefined : ['cmd', '/d', '/c', 'mkdir', native(dir)]
}
