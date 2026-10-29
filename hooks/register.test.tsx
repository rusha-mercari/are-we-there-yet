import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'are-we-there-yet',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DECK = {
  plugin: 'are-we-there-yet',
  component: 'Pane',
  requestId: 'are-we-there-yet',
  props: {
    title: 'Are we there yet?',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('a spawned subagent gets a card in the deck and a line in the band', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.agent.spawn({ prompt: 'find the auth code', description: 'find auth', subagentType: 'Explore' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'auth', agentId: 'a1' } as never)

  for (const surface of SURFACES) {
    const deck = await $.ui.mount({ ...DECK, surface })
    expect(await deck.find({ type: 'Text', text: /1 en route/ })).toBeDefined()
    expect(await deck.find({ type: 'Text', text: /1 steps/ })).toBeDefined()
    expect(await deck.find({ type: 'Text', text: /confidence: low/ })).toBeDefined()

    await deck.press({ key: 'card-a1' })
    expect(await deck.find({ type: 'Text', text: /recent: Grep/ })).toBeDefined()
    await deck.press({ key: 'card-a1' })
    await deck.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /1 en route/ })).toBeDefined()
    await band.unmount()
  }
})

test('learned history and a stale clock still draw the deck', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  // The ticking clock is behind the spawn: elapsed would be negative.
  let clock = 1_000_000
  on('clock.now', () => ({ value: clock }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a2' }))
  on('state.get', (_, e, next) =>
    (e as { key?: string }).key === 'history'
      ? { value: { value: { Explore: { n: 2, avgMs: 40_000, avgSteps: 8 } }, version: 1 } }
      : next(e),
  )
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  clock = 2_000_000
  await $.agent.spawn({ prompt: 'x', description: 'peek', subagentType: 'Explore' } as never)

  const deck = await $.ui.mount({ ...DECK, surface: 'desktop' })
  // Collapsed by default: the header shows, the rows do not.
  expect(await deck.find({ type: 'Text', text: /TRACK RECORD/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /2 trips/ })).toBeUndefined()
  await deck.press({ key: 'toggle-record' })
  expect(await deck.find({ type: 'Text', text: /2 trips/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /1 en route/ })).toBeDefined()
  await deck.unmount()
})

test('a long prose response marks the card almost done', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a3' }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'Here is what I found. '.repeat(20) } as never
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.agent.spawn({ prompt: 'x', description: 'report', subagentType: 'Explore' } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a3' } as never)) {
    // drain
  }

  const deck = await $.ui.mount({ ...DECK, surface: 'desktop' })
  expect(await deck.find({ type: 'Text', text: /almost there, honest/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /1 requests/ })).toBeDefined()
  await deck.unmount()
})

test('a report handed back through SubagentHandback marks the card almost done', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a4' }))
  let isSeenMidStream = false
  const kit = $
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 'tu1', name: 'SubagentHandback' } as never
    // The card is already wrapping up while the report is still streaming.
    const deck = await kit.ui.mount({ ...DECK, surface: 'desktop' })
    isSeenMidStream = (await deck.find({ type: 'Text', text: /almost there, honest/ })) !== undefined
    await deck.unmount()
    yield { kind: 'input', index: 0, json: '{"report":"done"}' } as never
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.agent.spawn({ prompt: 'x', description: 'hand back', subagentType: 'Explore' } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a4' } as never)) {
    // drain
  }
  expect(isSeenMidStream).toBe(true)
})

test('an empty deck naps, and the band leaves the engine its own', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const deck = await $.ui.mount({ ...DECK, surface: 'desktop' })
  expect(await deck.find({ type: 'Text', text: /No agents on the road/ })).toBeDefined()
  await deck.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine')
  await band.unmount()
})
