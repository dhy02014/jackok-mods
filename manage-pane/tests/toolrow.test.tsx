import { expect, test } from 'claude-code/testing'
import { START, CREATE, UPDATE, LIST, stub } from './helpers'

type Ctx = Parameters<Parameters<typeof test>[1]>[0]

type OnFn = Parameters<Parameters<typeof test>[1]>[1]

const toolRowProps = (tool: string, input: unknown, o: { isErrored?: boolean; isInterrupted?: boolean; isRunning?: boolean } = {}) =>
  ({ tool_use_id: 'tu1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...o }) as const

const resultProps = (tool: string, output: unknown, o: { id?: string; isErrored?: boolean } = {}) =>
  ({ tool_use_id: o.id ?? 'tu1', tool, output, isErrored: o.isErrored ?? false }) as const

const noUndefined = (v: unknown): boolean =>
  v !== undefined && (typeof v !== 'object' || v === null || Object.values(v).every(noUndefined))

const textOf = (output: unknown) => (typeof output === 'string' ? output : (output as { text: string }[])[0].text)

for (const surface of ['terminal', 'desktop'] as const) {
  // The stub beneath the mod records the props the engine would draw its own row from.
  const drawer = ($: Ctx, on: OnFn) => {
    const seen: Record<string, unknown>[] = []
    for (const component of ['ToolUse', 'ToolResult'] as const) {
      on('ui.render', { component }, ($, e) => {
        seen.push(e.props as Record<string, unknown>)
        const { Text } = $.ui.resolve(e)
        return <Text>engine row</Text>
      })
    }
    const mounted = async (component: 'ToolUse' | 'ToolResult', props: Record<string, unknown>) => {
      const ui = await $.ui.mount({ plugin: 'manage-pane', surface, component, requestId: 'tu1', props } as never)
      await ui.unmount()
      return seen[seen.length - 1]
    }
    return {
      use: (props: ReturnType<typeof toolRowProps>) => mounted('ToolUse', props),
      result: (props: ReturnType<typeof resultProps>) => mounted('ToolResult', props),
    }
  }

  test(`${surface}: the header keeps the engine's row with only a count, under the batch field's name`, async ($, on) => {
    stub(on)
    const draw = drawer($, on)
    await $.session.start(START)
    const batch = await draw.use(toolRowProps(CREATE, { tasks: [{ subject: '통합 (라우터)' }, { subject: 'Second' }, { subject: '세 번째' }] }))
    expect(batch?.input).toEqual({ tasks: 3 })
    expect((await draw.use(toolRowProps(CREATE, { subject: 'One', status: 'in_progress' })))?.input).toEqual({ tasks: 1 })
    const updates = await draw.use(toolRowProps(UPDATE, { updates: [{ taskId: '11', status: 'completed' }, { taskId: '12', owner: 'a1' }] }))
    expect(updates?.input).toEqual({ updates: 2 })
    expect((await draw.use(toolRowProps(UPDATE, { taskId: '5', status: 'completed' })))?.input).toEqual({ updates: 1 })
    for (const p of [batch, updates]) expect(noUndefined(p?.input)).toBe(true)
  })

  test(`${surface}: another tool and an input with nothing to show keep the engine's row; errored, interrupted and running keep the count`, async ($, on) => {
    stub(on)
    const draw = drawer($, on)
    await $.session.start(START)
    for (const props of [toolRowProps('Bash', { command: 'ls' }), toolRowProps(CREATE, {}), toolRowProps(UPDATE, { updates: [] })]) {
      expect(await draw.use(props)).toEqual(props)
    }
    for (const o of [{ isErrored: true }, { isInterrupted: true }, { isRunning: true }]) {
      const props = await draw.use(toolRowProps(CREATE, { subject: 'x' }, o))
      expect(props?.input).toEqual({ tasks: 1 })
      expect(props).toMatchObject(o)
    }
  })

  test(`${surface}: task_create's result lists #N subject per line, as created, in the shape it came in`, async ($, on) => {
    stub(on)
    const draw = drawer($, on)
    await $.session.start(START)
    const long = 'z'.repeat(100)
    const created = await $.tool.call({
      tool: CREATE,
      tool_use_id: 'tu1',
      tasks: [{ subject: '파서로 통합 (라우터)' }, { subject: 'Second\n line', status: 'in_progress' }, { subject: long }],
    })
    expect(created).toMatchObject({ result: 'Created #1, #2, #3' })
    const original = 'Created #1, #2, #3'
    const asString = await draw.result(resultProps(CREATE, original))
    const lines = (asString?.output as string).split('\n')
    expect(lines).toEqual(['#1 파서로 통합 (라우터)', '#2 Second line', `#3 ${'z'.repeat(59)}…`])
    // The same text in a content-block array and in a `{ content }` wrapper keeps that shape.
    const blocks = await draw.result(resultProps(CREATE, [{ type: 'text', text: original }]))
    expect(blocks?.output).toEqual([{ type: 'text', text: lines.join('\n') }])
    const wrapped = await draw.result(resultProps(CREATE, { content: original }))
    expect(wrapped?.output).toEqual({ content: lines.join('\n') })
    // A later update renaming the task does not change what that call showed.
    await $.tool.call({ tool: UPDATE, tool_use_id: 'tu2', taskId: '1', subject: 'Renamed' })
    expect(((await draw.result(resultProps(CREATE, original)))?.output as string).split('\n')[0]).toBe('#1 파서로 통합 (라우터)')
    // What the model reads is the engine's own text.
    expect(created).toMatchObject({ result: original })
  })

  test(`${surface}: task_update's result shows the mark the call set and the subject, · when it set no status`, async ($, on) => {
    stub(on)
    const draw = drawer($, on)
    await $.session.start(START)
    await $.tool.call({ tool: CREATE, tool_use_id: 'c', tasks: [{ subject: 'Alpha' }, { subject: 'Beta' }, { subject: 'Gamma' }, { subject: 'Delta' }] })
    const updated = await $.tool.call({
      tool: UPDATE,
      tool_use_id: 'tu1',
      updates: [
        { taskId: '1', status: 'completed' },
        { taskId: '2', status: 'in_progress', subject: '베타 이름' },
        { taskId: '3', owner: 'a1' },
        { taskId: '4', status: 'deleted' },
        { taskId: '1', status: 'pending' },
      ],
    })
    const text = 'Updated task #1 status\nUpdated task #2 status, subject'
    const out = await draw.result(resultProps(UPDATE, text))
    expect((out?.output as string).split('\n')).toEqual(['#1 ✓ Alpha', '#2 ◐ 베타 이름', '#3 · Gamma', '#4 ✗ Delta', '#1 ○ Alpha'])
    expect(JSON.stringify(updated)).not.toContain('✓')
  })

  test(`${surface}: every produced line starts at the same column (no leading whitespace, # first)`, async ($, on) => {
    stub(on)
    const draw = drawer($, on)
    await $.session.start(START)
    await $.tool.call({
      tool: CREATE,
      tool_use_id: 'tu1',
      tasks: Array.from({ length: 12 }, (_, i) => ({ subject: i % 2 === 0 ? `  \t짧은 ${i}` : `a\nb ${'x'.repeat(i * 9)}` })),
    })
    const created = (await draw.result(resultProps(CREATE, 'Created')))?.output as string
    await $.tool.call({
      tool: UPDATE,
      tool_use_id: 'tu2',
      updates: Array.from({ length: 12 }, (_, i) => ({ taskId: String(i + 1), status: ['pending', 'in_progress', 'completed'][i % 3] })),
    })
    const updated = (await draw.result(resultProps(UPDATE, 'Updated', { id: 'tu2' })))?.output as string
    for (const block of [created, updated]) {
      const lines = block.split('\n')
      expect(lines).toHaveLength(12)
      for (const line of lines) expect(line).toMatch(/^#\d+ \S/)
    }
  })

  test(`${surface}: errored results, other tools and a call with no kept lines are untouched`, async ($, on) => {
    stub(on)
    const draw = drawer($, on)
    await $.session.start(START)
    await $.tool.call({ tool: CREATE, tool_use_id: 'tu1', subject: 'Kept' })
    const errored = resultProps(CREATE, 'task_create needs a subject', { isErrored: true })
    expect(await draw.result(errored)).toEqual(errored)
    const other = resultProps('Bash', { stdout: 'x', stderr: '' })
    expect(await draw.result(other)).toEqual(other)
    const otherCall = resultProps(LIST, 'whatever')
    expect(await draw.result(otherCall)).toEqual(otherCall)
    const missing = resultProps(CREATE, 'Created #9', { id: 'after-resume' })
    expect(await draw.result(missing)).toEqual(missing)
    const odd = resultProps(CREATE, { stdout: 'x' })
    expect(await draw.result(odd)).toEqual(odd)
    const noId = await $.tool.call({ tool: UPDATE, taskId: '1', status: 'completed' })
    expect(noId).toMatchObject({ result: 'Updated task #1 status' })
    const noIdRow = resultProps(UPDATE, 'Updated task #1 status', { id: 'undefined' })
    expect(await draw.result(noIdRow)).toEqual(noIdRow)
  })
}
