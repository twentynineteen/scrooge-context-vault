import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'scrooge-context-vault',
  props: {
    title: "Scrooge's Context Vault",
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
  const ui = await $.ui.mount({ plugin: 'scrooge-context-vault', surface: 'terminal', ...PANE })
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

test('the diveAt setting moves the dive', { options: { diveAt: 60 } }, async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure(measure(55))
  const ui = await $.ui.mount({ plugin: 'scrooge-context-vault', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /dives in at 60%/ })).toBeDefined()

  await $.session.measure(measure(65))
  expect(await ui.find({ type: 'Text', text: /swimming in it/ })).toBeDefined()
})

test('the apps draw the bin as an animated SVG with the figures', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(90))
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'scrooge-context-vault', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('<svg')
    expect(drawn).toContain('animateTransform')
    expect(drawn).toContain('swimming in the coins')
    await ui.unmount()
  }
})

test('the apps show the bin above the message box, over what else draws there', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, (b, e) => {
    const { Text } = b.ui.resolve(e)

    return <Text>session 0m 10s</Text>
  })
  await $.session.measure(measure(85))
  const ui = await $.ui.mount({
    plugin: 'scrooge-context-vault',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: 'session 0m 10s' })).toBeDefined()
  // The figures are drawn inside the strip, not in a row of their own.
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('85% · 170k of 200k · /compact to drain')
  expect(drawn).toContain('swimming in the coins')
})

test('redrawing the band without a fill change keeps the same SVG, so its animation runs on', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, (b, e) => b.ui.resolve(e).Box({}))
  await $.session.measure(measure(85))
  const band = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  }
  const ui = await $.ui.mount({ plugin: 'scrooge-context-vault', surface: 'desktop', component: 'AbovePrompt', props: band })
  const first = JSON.stringify(await ui.drawn())
  await ui.redraw({ ...band, isWorking: true })
  await ui.redraw({ ...band, isWorking: false })
  expect(JSON.stringify(await ui.drawn())).toBe(first)
})
