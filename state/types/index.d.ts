export type HudLimit = { kind: string; percent: number; resetsAt?: string }

/** Figures read from the engine: `session.measure` pushes, a few events pull. */
export type HudSnap = {
  sessionId: string
  model: string
  cwd: string
  ctxPercent?: number
  ctxTokens?: number
  limits: HudLimit[]
  usd?: number
  /** When `session.measure` last wrote the usage figures; a pull started before it keeps them. */
  measuredAt?: number
}

export type HudGit = { branch: string; ahead: number; behind: number; changed: number }

/** Per-model weekly windows from the OAuth usage endpoint, which the engine does not expose. */
export type HudWeekly = { models: { name: string; percent: number; resetsAt?: string }[]; error?: string }

export type HudTool = { id: string; name: string; target: string; isDone: boolean }

/** Advisor server-tool calls this conversation. */
export type HudAdvisor = {
  calls: number
  agentCalls: number
  lastMs?: number
  lastAt?: number
  /** The call the API is running now: set when its `server_tool_use` row appends, cleared by its result row or the step's end. */
  inFlight?: { id: string; startedAt: number; agentId?: string }
}

declare module 'claude-code' {
  interface PluginState {
    state: {
      // Shaped (the module's own type, in scope here): a reload whose code changed
      // these types reads an old value as absent.
      snap: Shaped<HudSnap | null>
      git: HudGit | null
      weekly: HudWeekly | null
      /** The main loop's effort as the last model request named it. */
      effort: string | null
      /** Highest alert threshold already toasted, per window (`context`, `five_hour`, ...). */
      alerted: Record<string, number>
      /** Bumped by the minute timer so countdowns redraw while idle. */
      minute: number
      /** The last 300 main-loop tool calls, for the running rows. */
      tools: HudTool[]
      /** Completed main-loop tool calls per tool name over the whole conversation. */
      toolCounts: Record<string, number>
      /** Subagents spawned over the conversation, keyed `<type>\t<resolved model id>\t<definition effort>`. */
      agentTally: Record<string, number>
      /** Tokens the main loop's requests in the latest user turn sent uncached or wrote to the cache, plus generated: the ▲ figure. Subagents' requests are not counted; null before the first turn. */
      turnTokens: number | null
      /** Context tokens at the end of each main-loop turn, oldest first, last 12. */
      history: number[]
      advisor: HudAdvisor
      /** The live advisor dot's phase, toggled on a timer only while a call is in flight. */
      advisorBlink: boolean
      /** The band's expanded view; on by default. */
      isExpanded: Shaped<boolean>
      /** The agents line's expanded view (runs by model and effort); on by default. */
      isAgentsExpanded: boolean
      /** /state hides the whole band for the session; shown by default. */
      isHidden: boolean
      /** Pressing the rule's title folds the band to its rule row; unfolded by default. */
      isFolded: boolean
    }
  }
}
