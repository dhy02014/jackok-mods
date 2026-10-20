import type { PaneTask } from '../types'
import type { Patch } from './tasks'
import { asStatus, str, strings } from './tasks'

// What a task tool's input and the plugin's options become: the new task, the patch, a flag.
// Plain values in, no `$`.

// An option may arrive as a boolean or as its string; anything else is the manifest's default.
export const flag = (v: unknown, fallback: boolean) =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : fallback

export const newTask = (id: number, subject: string, e: Record<string, unknown>): PaneTask => ({
  id: String(id),
  subject,
  description: '',
  status: e.status === 'in_progress' ? 'in_progress' : 'pending',
  activeForm: str(e.activeForm),
  blocks: [],
  blockedBy: [],
})

export const patchOf = (id: string, e: Record<string, unknown>): Patch => ({
  id,
  status: e.status === 'deleted' ? 'deleted' : asStatus(e.status),
  subject: str(e.subject),
  activeForm: str(e.activeForm),
  owner: typeof e.owner === 'string' ? e.owner : undefined,
  addBlockedBy: strings(e.addBlockedBy),
})
