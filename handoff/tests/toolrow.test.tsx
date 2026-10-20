import { expect, test } from 'claude-code/testing'

const CARD = 'mcp__handoff__card'

let n = 0
const row = (tool: string, input: unknown, o: { isRunning?: boolean; isErrored?: boolean; isInterrupted?: boolean } = {}) =>
  ({
    component: 'ToolUse',
    requestId: `toolu_${n++}`,
    props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...o },
  }) as const

const noUndefined = (v: unknown): boolean =>
  v !== undefined && (typeof v !== 'object' || v === null || Object.values(v).every(noUndefined))

for (const surface of ['terminal', 'desktop'] as const) {
  // The stub beneath the mod records the props the engine would draw its own row from.
  const setup = ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
    const seen: Record<string, unknown>[] = []
    on('ui.render', { component: 'ToolUse' }, ($, e) => {
      seen.push(e.props as Record<string, unknown>)
      const { Text } = $.ui.resolve(e)
      return <Text>engine row</Text>
    })
    return async (r: ReturnType<typeof row>) => {
      const ui = await $.ui.mount({ plugin: 'handoff', surface, ...r })
      await ui.unmount()
      return seen[seen.length - 1]
    }
  }

  test(`${surface}: card create, update and close hand the engine no input fields at all`, async ($, on) => {
    const draw = setup($, on)
    const BODY = 'LONG-BODY-TEXT '.repeat(40)

    const create = await draw(row(CARD, { title: '시험 카드', next: 'card 행 표시 확인용', body: BODY, summary: 'S' }))
    const update = await draw(row(CARD, { slug: 'port-band', next: 'x', status: 'hold', body: BODY, doc: 3 }))
    const done = await draw(row(CARD, { slug: '2026-10-18-card', status: 'done' }))
    const odd = await draw(row(CARD, 'not an object'))

    for (const p of [create, update, done, odd]) {
      expect(p?.input).toEqual({})
      expect(noUndefined(p?.input)).toBe(true)
    }
    expect(JSON.stringify(update)).not.toContain('LONG-BODY')
  })

  test(`${surface}: another tool is untouched; errored, interrupted and running card rows keep their flags`, async ($, on) => {
    const draw = setup($, on)
    const bash = row('Bash', { command: 'ls' })
    expect(await draw(bash)).toEqual(bash.props)
    for (const o of [{ isErrored: true }, { isInterrupted: true }, { isRunning: true }]) {
      const props = await draw(row(CARD, { slug: 'a', status: 'done' }, o))
      expect(props?.input).toEqual({})
      expect(props).toMatchObject(o)
    }
  })
}
