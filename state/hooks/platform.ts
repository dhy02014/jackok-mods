// Path helpers for POSIX and native Windows paths. Each plugin keeps its own copy of the
// helpers it uses (a plugin cannot import from another's folder); tests/platform.test.ts
// pins this copy.

// `/` separators and no trailing one: the single form a home or cwd takes before a comparison sees it.
export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/([^:])\/+$/, '$1')

// A drive-letter path folds case: the session may report `c:\...` while USERPROFILE is `C:\...`.
const folded = (p: string) => (/^[A-Za-z]:/.test(p) ? p.toLowerCase() : p)

// Whether `path` is `root` or inside it, whatever either's separators.
export const isUnder = (path: string, root: string) => {
  const p = folded(slashed(path))
  const r = folded(slashed(root))
  return p === r || p.startsWith(`${r}/`)
}
