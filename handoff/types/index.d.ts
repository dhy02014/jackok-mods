export type HandoffStatus = 'open' | 'hold'

/** Which cards the band lists. */
export type HandoffFilter = 'all' | HandoffStatus

/** One card of a workspace's handoff/, as its frontmatter reads. */
export type HandoffCard = {
  /** The file's name in the card folder: `YYYY-MM-DD-<slug>.md`. */
  file: string
  title: string
  status: HandoffStatus
  next: string
  /** One line of the key points; the band and `list` leave it out. */
  summary?: string
  /** A `~`-prefixed path to the detailed doc. */
  doc?: string
  body: string
  /** The file's mtime as the listing gave it, never written to the file: what a card's age counts from. */
  mtimeMs?: number
}

/** Where the session stands and the cards of its workspace. */
export type HandoffView = {
  /** The workspace whose handoff/ holds the cards: the repo's main checkout (also from a worktree), or the session's directory without git or outside a repo; null only before the first refresh. */
  root: string | null
  cwd: string
  cards: HandoffCard[]
}

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      view: Shaped<HandoffView>
      /** /handoff hides the whole band for the session; shown by default. */
      isHidden: boolean
      /** Pressing the header's title folds the band to its header row; unfolded by default. */
      isFolded: boolean
      /** The last row's [more]/[less] button shows every card instead of the first few. */
      isExpanded: boolean
      /** Expanded, the first card row of the paged window; reset on collapse/expand and on a filter change. */
      offset: number
      /** The band's filter buttons and `/handoff open|hold|all`. */
      filter: HandoffFilter
      /** The session id whose first prompt already carried the pointer line; null after a /clear. */
      announcedFor: string | null
      /** The session id that wrote or closed a card: its /clear and /exit are not held. */
      touchedFor: string | null
      /** The session id whose /clear or /exit was already held once. */
      warnedFor: string | null
      /** The result lines of each card and list call, by tool_use_id (the newest 200), drawn under its transcript row. */
      toolRows: Shaped<Record<string, string[]>>
    }
  }
}
