// Every string the person reads. English only, whatever Claude Code's `language` setting is.

export const t = {
  commandDescription: 'Show or hide the state band',
  bandHidden: 'State band hidden.',
  bandShown: 'State band shown.',
  limitToast: (label: string, percent: number, reset: string) => `${label} ${percent}% used${reset !== '' ? ` (resets in ${reset})` : ''}`,
  advisorToast: (isSub: boolean, took: string | undefined, at: string) =>
    `advisor consulted${isSub ? ' (subagent)' : ''}${took !== undefined ? ` · ${took}` : ''} · ${at}`,
  compactToast: (before: string, after: string) => `Context compacted: ${before} → ${after}`,
  modelSwitchToast: (from: string, to: string, usd: string) => `Model switched ${from} → ${to}: cache rewrite about $${usd}`,
  failureToast: (label: string, details: string | undefined) => `Request failed: ${label}${details !== undefined ? ` (${details})` : ''}`,
  failure: {
    rate_limit: 'usage limit reached',
    overloaded: 'API overloaded',
    billing_error: 'billing error',
    authentication_failed: 'authentication failed',
  } as Record<string, string>,
  copiedId: (id: string) => `Session id copied: ${id}`,
  copyIdFailed: (reason: string) => `Could not copy the session id (${reason})`,
  copiedCwd: (cwd: string) => `Path copied: ${cwd}`,
  copyCwdFailed: (reason: string) => `Could not copy the path (${reason})`,
  band: {
    context: 'Context',
    usage: 'usage',
    sub: 'sub',
    subagent: 'subagent',
    // The usage line's labels, by rate-limit kind.
    limits: { five_hour: 'Session', seven_day: 'Weekly', spend_limit: 'Spend' } as Record<string, string>,
  },
  // The limit toast's labels, short.
  limitLabel: { five_hour: '5h', seven_day: '7d', spend_limit: 'spend', context: 'ctx' } as Record<string, string>,
}

export type BandLabels = (typeof t)['band']
