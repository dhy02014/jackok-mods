// Model labels and small number formats for the band and the toasts. Pure: no `$`.

const PREFIX = 'claude-'

const leadingDigits = (s: string) => {
  let n = 0
  while (n < s.length && s.charCodeAt(n) >= 48 && s.charCodeAt(n) <= 57) n++
  return s.slice(0, n)
}

// Family and version out of a model id, wherever the `claude-` part sits in it
// (`eu.anthropic.claude-sonnet-1-2-v1:0`, `vendor/claude-sonnet-1.2`). A minor version is
// one or two digits, so the date of `claude-haiku-1-2-20240101` is never read as one;
// `claude-opus-1` has none.
const versionOf = (id: string): { family: string; version: string } | undefined => {
  for (let at = id.indexOf(PREFIX); at !== -1; at = id.indexOf(PREFIX, at + 1)) {
    const [family = '', major = '', minor = ''] = id.slice(at + PREFIX.length).split(/[-.]/)
    if (family === '' || family !== family.replace(/[^a-z]/g, '')) continue
    const majorDigits = leadingDigits(major)
    if (majorDigits === '') continue
    const minorDigits = majorDigits === major ? leadingDigits(minor) : ''
    const hasMinor = minorDigits.length > 0 && minorDigits.length <= 2
    return { family, version: hasMinor ? `${majorDigits}.${minorDigits}` : majorDigits }
  }
  return undefined
}

// `claude-sonnet-5-5` → `sonnet 5.5`; an id with no such part is shown as it is.
export const modelLabel = (id: string) => {
  const v = versionOf(id)
  return v === undefined ? id : `${v.family} ${v.version}`
}

// The main model's title: `Opus 5.5`, `Opus 5.5[1m]`, `Sonnet[1m]`. The context suffix
// comes off before the label is read, since an id modelLabel cannot parse comes back whole.
export const displayModel = (id: string) => {
  const ctx = /\[(\d+[kmKM])\]$/.exec(id)
  const label = modelLabel(ctx === null ? id : id.slice(0, ctx.index))
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}${ctx !== null ? `[${ctx[1].toLowerCase()}]` : ''}`
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

// Epoch ms → local `HH:MM`, for the advisor toast.
export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
