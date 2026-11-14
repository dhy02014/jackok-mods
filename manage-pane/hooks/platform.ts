// Path helpers for POSIX and native Windows. Each plugin keeps its own copy of the helpers it
// uses (a plugin cannot import from another's folder); tests/platform.test.ts pins this copy.
// No `$` here.

// A drive-letter or UNC path, in either separator.
export const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)

// `/` separators and no trailing one: the single form a home or cwd takes before `$.fs`
// or a comparison sees it.
export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/([^:])\/+$/, '$1')
