export type PaneTaskStatus = 'pending' | 'in_progress' | 'completed'

/** One task of the session's list, as the task_create/task_update tools left it. */
export type PaneTask = {
  /** A decimal string, minted per session from 1 and never reused. */
  id: string
  subject: string
  description: string
  status: PaneTaskStatus
  /** The spinner text; shown while `in_progress`. */
  activeForm?: string
  /** The agent id the caller assigned it to with task_update; never inferred. */
  owner?: string
  /** The owner's run as it stood when the task was completed; drawn in place of the live record. */
  ownerRun?: PaneOwnerRun
  /** Ids this task blocks; the mirror of the other tasks' `blockedBy`. */
  blocks: string[]
  blockedBy: string[]
}

/** An owner's run frozen on a completed task: its agent type and how long it ran. */
export type PaneOwnerRun = { type: string; ms: number; model?: string; effort?: string }

/** The task list of one session id, and the highest id it has minted. */
export type PaneBoard = {
  /** The session the list belongs to; null after a /clear until the next call. */
  sessionId: string | null
  /** High-water mark: the next id is one past this (and past what `$.store` holds for the session). */
  lastId: number
  /** The tasks in creation order; a deleted one is dropped. */
  tasks: PaneTask[]
}

/** One tool call of a subagent, as its pane line shows it. */
export type PaneCall = {
  /** The call's place in the agent's sequence (1, 2, ...): side-by-side calls are told apart by it. */
  seq: number
  tool: string
  /** What the call acts on, shortened: a file's name, a command's first line, a pattern. */
  target: string
  /** True while the call is in flight. */
  isCalling: boolean
}

/** One subagent this session spawned, keyed by agent id. */
export type PaneAgent = {
  type: string
  model: string
  effort?: string
  /** The agent's working directory, absolute; absent while unknown (an isolated agent's worktree). */
  dir?: string
  /** Set when it runs in a worktree of its own, whose path no event gives while it runs. */
  isWorktree?: true
  description: string
  /** The open task its `#N` named at spawn, claimed or not: drawn under it beside the task's owner. */
  taskId?: string
  isRunning: boolean
  startedAt: number
  /** When its turn completed; absent while it runs. */
  endedAt?: number
  /** Calls made so far. */
  calls: number
  /** The last few calls, newest first. */
  recent: PaneCall[]
}

/** One instruction file the context carried this conversation, keyed by its absolute path. */
export type PaneInstruction = {
  /** Where its copy rides: `context` at a message's top level (the first message's instructions), `nested` inside a tool result (a nested CLAUDE.md or a path-scoped rule a read pulled in). */
  kind: string
  /** How many copies of it the model has been sent: the live window's, plus those earlier windows held before each compaction. */
  count: number
  /** The order it was first loaded in, so the pane lists them as they arrived. */
  order: number
  /** Its body's size in UTF-8 bytes as the newest copy carried it, from its framing line to the next framing or the reminder's close. Absent on an entry kept before sizes were measured. */
  bytes?: number
}

declare module 'claude-code' {
  interface PluginState {
    'manage-pane': {
      // Shaped (the module's own type, in scope here): a reload whose code changed it reads an old value as absent.
      board: Shaped<PaneBoard>
      /** The in-progress mark's blink phase: true lit, false dim; false while no task is in progress. */
      blink: boolean
      agents: Shaped<Record<string, PaneAgent>>
      /** The count row's [open] filter hides the completed tasks from the pane; [all] (the default) shows them. */
      isDoneHidden: boolean
      instructions: Shaped<Record<string, PaneInstruction>>
      /** The copies a compaction or a rewind took out of the window, banked when a scan finds the conversation shorter; the pane adds the live window's to them. */
      instructionsBase: Shaped<Record<string, PaneInstruction>>
      /** The last scan: how many messages the conversation held and each file's copies in it. */
      instructionsLast: Shaped<{ messages: number; live: Record<string, { kind: string; count: number; bytes?: number }> }>
      /** The result lines of each task call, by tool_use_id (the newest 200), drawn under its transcript row. */
      toolRows: Shaped<Record<string, string[]>>
      /** The tab the pane shows: `task` (tasks and their agents, the default) or `prompt` (the instruction files). */
      tab: 'task' | 'prompt'
    }
  }
}
