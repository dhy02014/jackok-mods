import { mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

export const PANE_PROPS = {
  title: 'Tasks',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

export const START = { cwd: '/home/u/proj', surface: 'terminal', isInteractive: true } as const

export const HOME = '/home/u'

export const dirOf = (sid: string) => `${HOME}/.claude/tasks/${sid}`

export const CREATE = 'mcp__manage-pane__task_create'

export const UPDATE = 'mcp__manage-pane__task_update'

export const LIST = 'mcp__manage-pane__task_list'

// A Windows path as the in-memory disk keys it: `C:\Users\u\x` → `/Users/u/x`. The POSIX test
// host hands `$.fs` a drive path resolved against the mod folder, which argv never is: drop that too.
// A second drive marker means the mod glued two absolute paths together: fail, never key it.
export const norm = (path: string) => {
  if ((path.match(/[A-Za-z]:[\\/]/g) ?? []).length > 1) throw new Error(`doubled path: ${path}`)
  return path.replace(/\\/g, '/').replace(/^(?:.*\/)?[A-Za-z]:(?=\/)/, '')
}

// argv reaches the stub as the mod built it, never resolved against the mod folder.
export const argvNorm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')

export type StoredBoard = { at: number; lastId: number; tasks: Record<string, unknown>[] }

// The engine's side: panes, the session id, `$.store` as a map of JSON copies, and a file
// system in memory where `mv` and `rm`, and `cmd`'s `move` and `del`, act as they would on disk.
export const stub = (
  on: On,
  o: {
    files?: Record<string, string>
    store?: Record<string, unknown>
    isWriteRefused?: boolean
    env?: Record<string, string>
    language?: string
    isMoveRefused?: boolean
    /** The store refuses a write while it holds more lists than this. */
    boardCap?: number
  } = {},
) => {
  const env: Record<string, string> = o.env ?? { HOME }
  const store = new Map<string, unknown>(Object.entries(o.store ?? {}))
  const storeSets: string[] = []
  const boards = () => [...store.keys()].filter(k => k.startsWith('board:'))
  on('store.get', ($, e) => ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }))
  on('store.set', ($, e) => {
    if (o.boardCap !== undefined && boards().length > o.boardCap) return { deny: 'store full' }
    storeSets.push(e.key)
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  if (o.language !== undefined) on('settings.read', () => ({ value: { language: o.language } }))
  const opened: string[] = []
  const titles: string[] = []
  const panes = new Set<string>()
  const files = new Map(Object.entries(o.files ?? {}))
  const writes: string[] = []
  const argvs: string[][] = []
  const registered: { name: string; isDeferred?: boolean; required?: unknown }[] = []
  const specText: string[] = []
  const session = { id: 'sid-1' }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: session.id }))
  on('session.id', () => ({ value: session.id }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  const described: string[] = []
  on('command.register', ($, e) => {
    described.push(String(e.description))
    return { value: { command: 'pane' } }
  })
  on('tool.register', ($, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred, required: e.inputSchema.required })
    specText.push(e.description + JSON.stringify(e.inputSchema))
    return { value: { tool: `mcp__manage-pane__${e.name}` } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    titles.push(String(e.title))
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: 'Tasks', isShown: true, isPlaced: true })) as never }))
  on('fs.write', ($, e) => {
    if (o.isWriteRefused === true) return { deny: 'EACCES' }
    writes.push(e.path)
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => (files.has(norm(e.path)) ? { value: files.get(norm(e.path))! } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    return {
      value: [...files.keys()]
        .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    let exitCode = 0
    const isCmd = argv[0] === 'cmd'
    const [from, to] = isCmd ? [argvNorm(argv[5] ?? ''), argvNorm(argv[6] ?? '')] : [argv[2]!, argv[3]!]
    if (argv[0] === 'mv' && o.isMoveRefused === true) {
      exitCode = 1
    } else if ((argv[0] === 'mv' || (isCmd && argv[3] === 'move')) && files.has(from)) {
      files.set(to, files.get(from)!)
      files.delete(from)
    } else if (argv[0] === 'rm') {
      files.delete(argv[2]!)
    } else if (isCmd && argv[3] === 'del') {
      files.delete(argvNorm(argv[6]!))
    } else {
      exitCode = 1
    }
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // A task as the store holds it for the session.
  const json = (sid: string, id: string) =>
    (store.get(`board:${sid}`) as StoredBoard | undefined)?.tasks.find(t => t.id === id)
  // A task as the CLI-format mirror wrote it.
  const file = (sid: string, id: string) => {
    const text = files.get(`${dirOf(sid)}/${id}.json`)
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)
  }
  return { opened, titles, panes, files, writes, argvs, registered, specText, session, json, file, store, storeSets, described, boards }
}

export const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({ plugin: 'manage-pane', surface: 'terminal', component: 'Pane', requestId: 'manage-pane', props: PANE_PROPS })

// What the model reads: the plugin's text, or the error a refusal became.
export const said = (r: { result?: unknown; text?: string; deny?: string }) => String(r.deny ?? r.text ?? r.result)

export const SID2_BOARD = {
  'board:sid-2': {
    at: 1,
    lastId: 3,
    tasks: [{ id: '3', subject: 'Resumed work', description: '', status: 'in_progress', blocks: [], blockedBy: [] }],
  },
}

export const DEFS: Record<string, string> = {
  [`${HOME}/.claude/agents/explorer.md`]: '---\nname: explorer\neffort: medium\n---\nbody\n',
  [`${HOME}/.claude/agents/checker.md`]: '---\nname: checker\neffort: high\n---\nbody\n',
  [`${HOME}/.claude/agents/isolated.md`]: '---\nname: isolated\nisolation: worktree\n---\nbody\n',
}

// The task stub plus what subagents need: a clock, agent definitions on disk, spawns
// numbered a1, a2, ... and the built-in tools their calls go to.
export const agentStub = (
  on: On,
  out: { files?: Map<string, string>; json?: (sid: string, id: string) => Record<string, unknown> | undefined; titles?: string[] } = {},
  o: { env?: Record<string, string>; files?: Record<string, string>; language?: string; agentId?: (n: number) => string } = {},
) => {
  const clock = mock.clock(on, { now: 0 })
  const s = stub(on, { files: o.files ?? DEFS, env: o.env, language: o.language })
  on('session.cwd', () => ({ value: START.cwd }))
  on('fs.exists', ($, e) => ({ value: s.files.has(norm(e.path)) }))
  on('turn.complete', () => ({ text: '' }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: (n += 1, o.agentId?.(n) ?? `a${n}`) }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as never)
  out.files = s.files
  out.json = s.json
  out.titles = s.titles
  return clock
}

export const mountRows = ($: Parameters<Parameters<typeof test>[1]>[0], bodyRows: number, bodyColumns: number = PANE_PROPS.bodyColumns) =>
  $.ui.mount({
    plugin: 'manage-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'manage-pane',
    props: { ...PANE_PROPS, bodyColumns, scroll: { offset: 0, bodyRows } },
  })

export const done = (agentId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId }) as const

export const contextOf = (r: { context?: readonly string[] }) => r.context ?? []

export const AGENT_DONE = {
  status: 'completed',
  agentId: 'a1',
  content: [{ type: 'text', text: 'report' }],
  totalToolUseCount: 0,
  totalDurationMs: 1,
  totalTokens: 1,
  usage: {} as never,
  prompt: 'p',
} as const

// The Agent tool in Claude Code's place; `ran` counts the calls that got past every hook.
export const agentTool = (on: On) => {
  const seen = { ran: 0 }
  on('tool.call', { tool: 'Agent' }, () => {
    seen.ran++
    return { result: { status: 'async_launched', agentId: 'ax', description: 'x', prompt: 'p', outputFile: '/o' } } as never
  })
  return seen
}

export type Fire = Parameters<Parameters<typeof test>[1]>[0]

export const agentCall = ($: Fire, description: string, agentId?: string) =>
  $.tool.call({ tool: 'Agent', prompt: 'p', description, subagent_type: 'checker', ...(agentId !== undefined ? { agentId } : {}) } as never)

export const spawn = ($: Fire, description: string) => $.agent.spawn({ prompt: 'p', subagentType: 'explorer', description } as never)

export const listOf = async ($: Fire) => String((await $.tool.call({ tool: LIST })).result)

// The main conversation as the model is sent it; a test shortens it to stand for a compaction.
export const instructionStub = (on: On) => {
  const convo = { messages: [] as unknown[] }
  on('session.messages', () => ({ value: convo.messages }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  return convo
}

export const reminder = (...paths: string[]) => `<system-reminder>\n${paths.map(p => `Contents of ${p}:\n\nbody`).join('\n\n')}\n</system-reminder>`

export const opening = (...paths: string[]) => ({ role: 'user', content: [{ type: 'text', text: reminder(...paths) }, { type: 'text', text: 'hi' }] })

export const afterRead = (...paths: string[]) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'file body' }, { type: 'text', text: reminder(...paths) }] }],
})

export const reply = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }

export const MEASURE = { context: { window: 1 }, rateLimits: [], changed: ['context'] } as never

export const mountPrompt = async ($: Parameters<typeof mountPane>[0]) => {
  const ui = await mountPane($)
  await ui.press({ key: 'pane-tab:prompt' })
  return ui
}

// The Prompt tab's body in reading order: a directory header, then each file (sizes and the
// total left out; `sizes` reads those).
export const SIZE = /^\d+(\.\d)?[BK]$|^total /

export const prompt = async (ui: Awaited<ReturnType<typeof mountPane>>) => {
  if ((await ui.find({ key: 'pane-instructions' })) === undefined) return []
  const texts = (await ui.findAll({ type: 'Text', text: /\S/ })).map(t => t.text)
  return texts.slice(texts.findIndex(t => /^─+$/.test(t)) + 1).filter(t => t !== 'None loaded yet.')
}

export const rows = async (ui: Awaited<ReturnType<typeof mountPane>>) => (await prompt(ui)).filter(t => !SIZE.test(t))

export const sizes = async (ui: Awaited<ReturnType<typeof mountPane>>) => (await prompt(ui)).filter(t => SIZE.test(t))
