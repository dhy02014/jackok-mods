import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { HudAdvisor, HudLimit, HudSnap, HudTool, HudWeekly } from '../types'
import { bandTree, formatReset, kTokens, short } from './band'
import { frontmatterEffort, mergePulled, parseGitStatus, sameJson, targetOf, toLimits } from './derive'
import { slashed } from './platform'
import { clockTime, displayModel, seconds } from './format'
import { t } from './strings'
import { parseWeekly, USAGE_HEADERS, USAGE_URL } from './usage'

// A session state band above the prompt: context, model and effort, cwd and git, rate
// limits and cost, tools, subagents (a tally line; their live rows are the manage-pane
// mod's). Usage is pushed by `session.measure`; threshold, compaction, model-switch and
// failure notices are toasts; /state hides or shows the band.

type Options = { per_model_limits?: boolean }

// Bump a shape tag whenever that value's type changes.
const snap = atom({ plugin: 'state', key: 'snap' } as const, null, { shape: 'v3' })
const git = atom({ plugin: 'state', key: 'git' } as const, null)
const weekly = atom({ plugin: 'state', key: 'weekly' } as const, null)
const effort = atom({ plugin: 'state', key: 'effort' } as const, null)
const alerted = atom({ plugin: 'state', key: 'alerted' } as const, {})
const minute = atom({ plugin: 'state', key: 'minute' } as const, 0)
const tools = atom({ plugin: 'state', key: 'tools' } as const, [])
const toolCounts = atom({ plugin: 'state', key: 'toolCounts' } as const, {})
// Expanded by default; the shape tag resets a session that stored the old collapsed default.
const isExpanded = atom({ plugin: 'state', key: 'isExpanded' } as const, true, { shape: 'v2' })
const isAgentsExpanded = atom({ plugin: 'state', key: 'isAgentsExpanded' } as const, true)
const isHidden = atom({ plugin: 'state', key: 'isHidden' } as const, false)
const isFolded = atom({ plugin: 'state', key: 'isFolded' } as const, false)
const turnTokens = atom({ plugin: 'state', key: 'turnTokens' } as const, null)
const history = atom({ plugin: 'state', key: 'history' } as const, [])
const advisor = atom({ plugin: 'state', key: 'advisor' } as const, { calls: 0, agentCalls: 0 } as HudAdvisor)
const advisorBlink = atom({ plugin: 'state', key: 'advisorBlink' } as const, false)
const agentTally = atom({ plugin: 'state', key: 'agentTally' } as const, {})

const BLINK_MS = 500
// The engine caps a toast at 60 s.
const ADVISOR_TOAST_MS = 60_000

const HISTORY_TURNS = 12
const MINUTE_MS = 60_000
// The OAuth usage endpoint 429s when hammered. One cached answer in `$.store`
// serves every session of the plugin: refetched past these ages (a failure
// retries sooner).
const WEEKLY_TTL_MS = 3 * 60_000
const WEEKLY_FAILURE_TTL_MS = 60_000
const ALERT_LEVELS = [80, 95]

// Tools whose completion can change the working tree or the session's cwd.
const GIT_TOUCHING = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'])

// Writes only when the value changed, so an idle timer tick redraws nothing.
const setIfChanged = async <T,>(value: T, current: T, write: () => Promise<unknown>) => {
  if (JSON.stringify(value) !== JSON.stringify(current)) await write()
}

// A pull started before the last `session.measure` keeps the measured figures:
// both writers update the value in place rather than overwrite a stale read.
// Each figure settles on its own: before the first request (or before the session
// binds) one may be missing, and the band still draws from the rest instead of
// staying empty until the first turn ends. Only a session id is required.
const refreshSnap = async ($: EngineInterface) => {
  const startedAt = await $.clock.now()
  const [usage, model, cwd, sessionId] = await Promise.all([
    $.session.usage().catch(() => undefined),
    $.session.model().catch(() => undefined),
    $.session.cwd().catch(() => undefined),
    $.session.id().catch(() => undefined),
  ])
  const cur = await read($, snap)
  const id = sessionId ?? cur?.sessionId
  if (id === undefined) return
  const pulled: HudSnap = {
    sessionId: id,
    model: model ?? cur?.model ?? '',
    cwd: cwd ?? cur?.cwd ?? '',
    // A read usage is the engine's figures as they are (absent just after a /clear);
    // a failed read keeps the last ones.
    ...(usage !== undefined
      ? {
          ctxPercent: usage.context?.percent,
          ctxTokens: usage.context?.tokens,
          limits: toLimits(usage.rateLimits ?? []),
          usd: usage.cost?.usd,
        }
      : { ctxPercent: cur?.ctxPercent, ctxTokens: cur?.ctxTokens, limits: cur?.limits ?? [], usd: cur?.usd }),
  }
  await update($, snap, cur => {
    const next = mergePulled(pulled, cur, startedAt)
    return sameJson(next, cur) ? cur : next
  })
}

// No git on the machine, or a cwd outside a repo: the git part is left out.
const refreshGit = async ($: EngineInterface) => {
  // `--no-optional-locks`: status otherwise refreshes the index under index.lock, which can
  // fail a git command the session runs at the same moment.
  const r = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch']).catch(() => undefined)
  if (r === undefined || r.exitCode !== 0) {
    await update($, git, () => null)
    return
  }
  const next = parseGitStatus(r.stdout)
  await setIfChanged(next, await read($, git), () => update($, git, () => next))
}

// A tool call schedules the refresh instead of awaiting it, so git never holds the call's
// return. A burst shares one run; a call landing while it runs queues exactly one more,
// so the last change is always read.
let gitPending = false
let gitAgain = false

const scheduleGit = ($: EngineInterface) => {
  if (gitPending) {
    gitAgain = true
    return
  }
  gitPending = true
  // On the clock, not in flight: the calling hook's `$` calls abort when its budget ends.
  $.clock.after(1, () =>
    void refreshGit($)
      .catch(ignore)
      .finally(() => {
        gitPending = false
        if (gitAgain) {
          gitAgain = false
          scheduleGit($)
        }
      })
      .catch(ignore),
  )
}

// The credential stays with the engine: `authorize()` hands out an opaque
// handle. Null without a first-party OAuth login (an API key, a 3P provider or
// gateway has no subscription windows).
const fetchWeekly = async ($: EngineInterface): Promise<HudWeekly | null> => {
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') return null
  let text: string
  try {
    const r = await $.http.fetch(USAGE_URL, { headers: USAGE_HEADERS, auth: auth.handle })
    if (!r.ok) return { models: [], error: `http-${r.status}` }
    text = r.text
  } catch {
    return { models: [], error: 'fetch' }
  }
  try {
    return parseWeekly(text)
  } catch {
    return { models: [], error: 'parse' }
  }
}

// Windows has no HOME by default: USERPROFILE stands in.
const homeOf = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home === undefined || home === '' ? undefined : slashed(home)
}

type WeeklyCache = { at: number; data: HudWeekly | null }

// The `per_model_limits` option. While it is off no request leaves the machine and the
// band shows only the limits the engine reports.
let perModelLimits = false

const refreshWeekly = async ($: EngineInterface) => {
  if (!perModelLimits) return
  const now = await $.clock.now()
  const cached = (await $.store.get('weekly')) as WeeklyCache | undefined
  const ttl = cached?.data?.error !== undefined ? WEEKLY_FAILURE_TTL_MS : WEEKLY_TTL_MS
  let next: HudWeekly | null
  if (cached !== undefined && now - cached.at < ttl) {
    next = cached.data
  } else {
    next = await fetchWeekly($)
    await $.store.set('weekly', { at: now, data: next } satisfies WeeklyCache)
  }
  // A failed fetch keeps the last good figures and only marks them stale.
  const prev = await read($, weekly)
  const merged = next?.error !== undefined && prev !== null ? { models: prev.models, error: next.error } : next
  await setIfChanged(merged, prev, () => update($, weekly, () => merged))
}

// One toast per window per threshold crossed; only dropping back under the
// lowest level (a reset, a compaction) re-arms it — a dip from 96 to 94 does not.
const checkAlerts = async ($: EngineInterface, windows: readonly HudLimit[]) => {
  const now = await $.clock.now()
  const seen = await read($, alerted)
  const next = { ...seen }
  for (const w of windows) {
    const crossed = ALERT_LEVELS.filter(l => w.percent >= l).at(-1) ?? 0
    const prev = seen[w.kind] ?? 0
    if (crossed > prev) {
      const label = t.limitLabel[w.kind] ?? w.kind
      const reset = formatReset(w.resetsAt, now)
      $.ui.toast(t.limitToast(label, Math.round(w.percent), reset))
    }
    next[w.kind] = crossed === 0 ? 0 : Math.max(prev, crossed)
  }
  await setIfChanged(next, seen, () => update($, alerted, () => next))
}

const ignore = () => undefined

// Run-scoped: a reload re-reads the definitions, which is what an edited agent
// file wants. Keyed by cwd too, since project definitions differ per worktree.
const effortByType = new Map<string, string | undefined>()

// The effort an agent type's definition pins (`effort:` frontmatter), project
// definitions over user ones. Neither `agent.spawn` nor `$.agent.list()` carries the
// Agent tool's per-call `effort` (measured 2.1.294), so a per-call override shows as
// the frontmatter value. Reads flat `<type>.md` files only.
const agentEffort = async ($: EngineInterface, type: string) => {
  const cwd = await $.session.cwd()
  const key = `${cwd}\0${type}`
  if (effortByType.has(key)) return effortByType.get(key)
  let found: string | undefined
  if (/^[A-Za-z0-9_-]+$/.test(type)) {
    const home = await homeOf($)
    for (const dir of [`${cwd}/.claude/agents`, ...(home !== undefined ? [`${home}/.claude/agents`] : [])]) {
      const path = `${dir}/${type}.md`
      if (!(await $.fs.exists(path))) continue
      found = frontmatterEffort(await $.fs.read(path))
      break
    }
  }
  effortByType.set(key, found)
  return found
}

// Each step stands alone: a failed pull must not skip the minute redraw or the weekly fetch.
const tick = async ($: EngineInterface) => {
  await refreshSnap($).catch(ignore)
  await update($, minute, n => n + 1).catch(ignore)
  await refreshWeekly($).catch(ignore)
}

// A start whose pulls all failed retries on the clock until the band has a snap,
// for at most START_RETRIES tries; the first turn's pull covers anything later.
const START_RETRY_MS = 1_000
const START_RETRIES = 10

const startRetry = ($: EngineInterface) => {
  let left = START_RETRIES
  const timer = $.clock.every(START_RETRY_MS, () =>
    void (async () => {
      left--
      await Promise.allSettled([refreshSnap($), refreshGit($)])
      if ((await read($, snap)) !== null || left <= 0) timer.cancel()
    })().catch(ignore),
  )
}

// A /clear starts the state over under a new session id, with no session.start and in no
// fixed order with its session.end: the band, drawing a session it has not loaded, pulls
// the snap, git and weekly figures itself, once per session id, on the clock (a render
// hook's `$` calls abort when its budget ends). Their writes draw the band again.
let healedFor: string | null | undefined
let isHealing = false

const heal = ($: EngineInterface, sessionId: string | undefined) => {
  const key = sessionId ?? null
  if (isHealing || key === healedFor) return
  isHealing = true
  $.clock.after(1, () =>
    void Promise.allSettled([refreshSnap($), refreshGit($), refreshWeekly($)]).finally(async () => {
      isHealing = false
      // Keyed by what the pull found: a snap still missing is tried again on the next draw.
      healedFor = (await read($, snap).catch(() => null))?.sessionId ?? undefined
    }),
  )
}

// The advisor dot blinks on its own timer, which runs only while a call is in flight.
let blinkTimer: { cancel: () => void } | undefined

const blinkTick = async ($: EngineInterface) => {
  if ((await read($, advisor)).inFlight === undefined) {
    blinkTimer?.cancel()
    blinkTimer = undefined
    await update($, advisorBlink, () => false)
  } else {
    await update($, advisorBlink, v => !v)
  }
}

const syncBlink = async ($: EngineInterface) => {
  const live = (await read($, advisor)).inFlight !== undefined
  if (live && blinkTimer === undefined) {
    await update($, advisorBlink, () => true)
    blinkTimer = $.clock.every(BLINK_MS, () => void blinkTick($).catch(ignore))
  } else if (!live && blinkTimer !== undefined) {
    blinkTimer.cancel()
    blinkTimer = undefined
    await update($, advisorBlink, () => false)
  }
}

export const register: Register = (on, options) => {
  perModelLimits = (options as Options | undefined)?.per_model_limits === true

  // Awaited before the first prompt: register and arm first, never block on the network.
  on('session.start', async ($, e, next) => {
    // A timer from before a reload may never fire, and would hold the guard shut.
    gitPending = false
    gitAgain = false
    await $.command.register({ name: 'state', description: t.commandDescription }).catch(ignore)
    $.clock.every(MINUTE_MS, () => void tick($).catch(ignore))
    await Promise.allSettled([refreshSnap($), refreshGit($)])
    const started = await next(e)
    // The session is bound once core's start ran: pull again so the band draws
    // before the first prompt, and keep retrying briefly while it is still empty.
    await Promise.allSettled([refreshSnap($), refreshGit($)])
    if ((await read($, snap)) === null) startRetry($)
    void refreshWeekly($).catch(ignore)
    return started
  })

  // A /clear goes on under a new session id with no session.start: drop the old
  // conversation's state. State writes only; the hook's budget is short.
  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (e.reason === 'clear') {
      await Promise.all([
        update($, history, () => []),
        update($, tools, () => []),
        update($, toolCounts, () => ({})),
        update($, agentTally, () => ({})),
        update($, turnTokens, () => null),
        update($, alerted, () => ({})),
        update($, advisor, () => ({ calls: 0, agentCalls: 0 })),
      ])
      // On the clock, not in flight: this hook's `$` calls abort when its budget ends.
      $.clock.after(1, () => void refreshSnap($).catch(ignore))
    }
    return done
  })

  // `/state` hides or shows the whole band; the band's own button switches detail and summary.
  on('command.run', { command: 'state' }, async $ => {
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? t.bandHidden : t.bandShown }
  })

  // Pushed after each main-thread turn and on a whole-point rate-limit move.
  on('session.measure', async ($, e, next) => {
    // A start whose pull failed left nothing to merge into: pull once more.
    if ((await read($, snap)) === null) await refreshSnap($).catch(ignore)
    const now = await $.clock.now()
    // The session id moves on a /clear; the figures are the engine's at this
    // moment, so an absent fill (just cleared) stays absent rather than stale.
    const sessionId = await $.session.id().catch(() => undefined)
    await update($, snap, cur =>
      cur === null
        ? cur
        : {
            ...cur,
            sessionId: sessionId ?? cur.sessionId,
            ctxPercent: e.context.percent,
            ctxTokens: e.context.tokens,
            limits: e.rateLimits.length > 0 ? toLimits(e.rateLimits) : cur.limits,
            usd: e.cost?.usd ?? cur.usd,
            measuredAt: now,
          },
    )
    const merged = await read($, snap)
    if (merged !== null) {
      const ctx = merged.ctxPercent
      await checkAlerts($, [...merged.limits, ...(ctx !== undefined ? [{ kind: 'context', percent: ctx }] : [])])
    }
    return next(e)
  })

  // Effort as the request actually carried it, after any downgrade for the model.
  // Advisor calls run server-side inside the request: no tool.call fires, so the
  // step's result is the only place they show.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const v = e.effort === undefined ? null : String(e.effort)
      if (v !== (await read($, effort))) await update($, effort, () => v)
    }
    const res = yield* next(e)
    // A stream cut short appends no result row: the step's end clears this loop's live call.
    await update($, advisor, a => (a.inFlight !== undefined && a.inFlight.agentId === e.agentId ? { ...a, inFlight: undefined } : a)).catch(ignore)
    await syncBlink($).catch(ignore)
    // Cache reads are left out: every step re-reads the whole conversation, so
    // they would count the same context once per step.
    const u = res.usage
    if (e.agentId === undefined && u !== null) {
      const spent = u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, turnTokens, n => (n ?? 0) + spent).catch(ignore)
    }
    const calls = (res.serverToolUses ?? []).filter(u => u.name === 'advisor')
    if (calls.length > 0) {
      const last = calls.at(-1)!
      const ms = last.endedAt !== undefined ? last.endedAt - last.startedAt : undefined
      const isMain = e.agentId === undefined
      await update($, advisor, a => ({
        ...a,
        calls: a.calls + (isMain ? calls.length : 0),
        agentCalls: a.agentCalls + (isMain ? 0 : calls.length),
        lastMs: ms,
        lastAt: last.endedAt ?? last.startedAt,
      })).catch(ignore)
      // The toast alone tells of the call, held the longest the engine allows; the band keeps no notice.
      const at = last.endedAt ?? last.startedAt
      $.ui.toast(t.advisorToast(!isMain, ms !== undefined ? seconds(ms) : undefined, clockTime(at)), {
        timeoutMs: ADVISOR_TOAST_MS,
      })
    }
    return res
  })

  // The only live sign of an advisor call: the engine appends each response block
  // as its own row while the response streams, so the `server_tool_use` row lands
  // when the API starts the call and its `advisor_tool_result` row when it answers.
  // State writes only; the row passes on unchanged.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    for (const block of e.message.content) {
      if (block.type === 'server_tool_use' && block.name === 'advisor' && typeof block.id === 'string') {
        const live = { id: block.id, startedAt: await $.clock.now(), agentId: e.agentId }
        await update($, advisor, a => ({ ...a, inFlight: live })).catch(ignore)
      } else if (block.type === 'advisor_tool_result') {
        const id = block.tool_use_id
        await update($, advisor, a => (a.inFlight?.id === id ? { ...a, inFlight: undefined } : a)).catch(ignore)
      }
    }
    await syncBlink($).catch(ignore)
    return next(e)
  })

  // Each spawn counts under its type and resolved model for the agents line; the live rows
  // are the manage-pane mod's, in its pane. A resume is the same agent, already counted.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.agentId !== undefined) {
      const effort = (await agentEffort($, e.subagentType).catch(() => undefined)) ?? ''
      const key = `${e.subagentType}\t${ran.model ?? ''}\t${effort}`
      await update($, agentTally, c => ({ ...c, [key]: (c[key] ?? 0) + 1 })).catch(ignore)
      await refreshSnap($).catch(ignore)
    }
    return ran
  })

  // ▲ counts the user turn's own requests: it starts over with each prompt, never with a
  // subagent's or teammate's turn, which `turn.start` also hears.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, turnTokens, () => 0)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A subagent's calls stay off the main tool list; the manage-pane mod draws them.
    if (e.agentId !== undefined) return next(e)

    const row: HudTool = { id: e.tool_use_id, name: String(e.tool), target: targetOf(e), isDone: false }
    await update($, tools, list => [...list, row].slice(-300))
    const ran = await next(e)
    await update($, tools, list => list.map(t => (t.id === row.id ? { ...t, isDone: true } : t)))
    await update($, toolCounts, c => ({ ...c, [row.name]: (c[row.name] ?? 0) + 1 }))
    if (GIT_TOUCHING.has(String(e.tool))) scheduleGit($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      await refreshGit($).catch(ignore)
      return done
    }
    await Promise.allSettled([refreshSnap($), refreshGit($)])
    // One point per main-loop turn; turns with no reading add none.
    const tokens = (await read($, snap))?.ctxTokens
    if (tokens !== undefined) {
      await update($, history, list => [...list, tokens].slice(-HISTORY_TURNS))
    }
    return done
  })

  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && ran.skip === undefined) {
      const { tokensBefore, tokensAfter } = ran
      if (tokensBefore !== undefined && tokensAfter !== undefined) {
        $.ui.toast(t.compactToast(kTokens(tokensBefore), kTokens(tokensAfter)))
      }
    }
    return ran
  })

  // A switch forfeits the warm cache; say what re-caching costs, as the engine estimates it.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.prompt_cache_warm && e.estimated_cache_write_usd >= 0.01) {
      $.ui.toast(t.modelSwitchToast(displayModel(e.from_model), displayModel(e.to_model), e.estimated_cache_write_usd.toFixed(2)))
    }
    await refreshSnap($).catch(ignore)
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    const label = t.failure[e.error]
    if (label !== undefined) $.ui.toast(t.failureToast(label, e.error_details !== undefined ? short(e.error_details, 60) : undefined))
    return next(e)
  })

  // Reads every atom the band shows (each read subscribes the band to it); the tree is ./band.tsx.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Keep what other mods draw in the band below the state band.
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, isHidden))) return below

    const s = await read($, snap)
    heal($, s?.sessionId)
    if (s === null) return below
    await read($, minute) // subscribes the band to the minute tick
    return bandTree(
      $.ui.resolve(e),
      {
        labels: t.band,
        snap: s,
        git: await read($, git),
        // Per-model rows saved while the option was on stay off the band once it is off.
        weekly: perModelLimits ? await read($, weekly) : null,
        effort: await read($, effort),
        advisor: await read($, advisor),
        blink: await read($, advisorBlink),
        tools: await read($, tools),
        toolCounts: await read($, toolCounts),
        agentTally: await read($, agentTally),
        isExpanded: await read($, isExpanded),
        turnTokens: await read($, turnTokens),
        history: await read($, history),
        now: await $.clock.now(),
        home: await homeOf($),
        columns: e.props.bodyColumns,
        isFolded: await read($, isFolded),
        onToggleFold: () => update($, isFolded, v => !v),
        onToggle: () => update($, isExpanded, v => !v),
        isAgentsExpanded: await read($, isAgentsExpanded),
        onToggleAgents: () => update($, isAgentsExpanded, v => !v),
        onCopyId: async (surface?: RenderSurface) => {
          const r = await $.ui.copy({ text: s.sessionId, surface })
          $.ui.toast(r.isCopied ? t.copiedId(s.sessionId) : t.copyIdFailed(String(r.reason)))
        },
        onCopyCwd: async (surface?: RenderSurface) => {
          const r = await $.ui.copy({ text: s.cwd, surface })
          $.ui.toast(r.isCopied ? t.copiedCwd(s.cwd) : t.copyCwdFailed(String(r.reason)))
        },
      },
      below,
    )
  })
}
