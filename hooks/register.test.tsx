import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'money-bin',
  props: {
    title: 'Money Bin',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const measure = (percent: number) => ({
  context: { percent, tokens: percent * 2000, window: 200_000 },
  rateLimits: [],
  changed: ['context' as const],
})

test('the bin shows the context fill and Scrooge dives in at 80%', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.measure(measure(42))
  const ui = await $.ui.mount({ plugin: 'money-bin', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Raster', key: 'bin' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /84\.0k of 200k tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /dives in at 80%/ })).toBeDefined()

  await $.session.measure(measure(85))
  expect(await ui.find({ type: 'Text', text: '85%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /swimming in it/ })).toBeDefined()

  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
  expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /dives in at 80%/ })).toBeDefined()
})

test('the apps draw the bin as an animated SVG with the figures', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(90))
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'money-bin', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('<svg')
    expect(drawn).toContain('animateTransform')
    expect(drawn).toContain('swimming in the coins')
    await ui.unmount()
  }
})
