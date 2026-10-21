import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-05T14:20:00Z' },
  { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2026-10-09T08:00:00Z' },
]

const HU = { options: { language: 'hu' } }

function engine(on: On, withData = true) {
  mock.store(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => e as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: withData ? { window: 1_000_000, tokens: 591_000, percent: 59.1 } : { window: 1_000_000 },
      rateLimits: LIMITS,
    },
  }) as never)
}

async function mount($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop', bodyColumns = 120) {
  return $.ui.mount({
    plugin: 'usage-header', surface, component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } as never,
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`context and the two limits (${surface})`, HU, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface)
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^Kontextus/ })).toBeDefined()
      // 120 columns: bar capped at 60 cells; 59.1% -> 35 filled, 25 track.
      expect(await ui.find({ type: 'Text', text: /^█{35}$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^░{25}$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' 59%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' 591k/1M' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5 óra ' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' 93% ⚠' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /→ (V|H|K|Sze|Cs|P|Szo) \d\d:\d\d/ })).toBeDefined()
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg).toBeDefined()
      const source = String(svg!.props.source)
      for (const part of ['Kontextus', '5 óra', 'Hét', '59%', '34%', '93% ⚠', '591k / 1M'])
        expect(source.includes(part)).toBe(true)
      expect(source).toMatch(/→ \d\d:\d\d/)
      expect(source).toMatch(/→ (V|H|K|Sze|Cs|P|Szo) \d\d:\d\d/)
      expect(source).toMatch(/prefers-color-scheme: light/)
      expect(String(svg!.props.alt)).toMatch(/^Kontextus 59% 591k\/1M · 5 óra 34% → \d\d:\d\d · Hét 93% ⚠ → /)
      expect(svg!.props.width).toBe(560)
      // No text rows besides the drawing on desktop.
      expect(await ui.find({ type: 'Text', text: /Kontextus/ })).toBeUndefined()
    }
    // No hairline glyphs anywhere, on either surface.
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/[━╸─]/)
    await ui.unmount()
  })
}

test('no category legend and no divider row', HU, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal')
  for (const name of [/Rendszerprompt/, /Üzenetek/, /Szabad/, /Tömörítési/, /Eszközök/, /Memória/, /■/, /▒/])
    expect(await ui.find({ type: 'Text', text: name })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /─/ })).toBeUndefined()
  await ui.unmount()
})

test('narrow width (60 columns): the terminal context row fits on one line', HU, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal', 60)
  // 60 - label 11 - spare 1 - " 59%" 4 - " 591k/1M" 8 = 36 cells; 59.1% -> 21 filled + 15 track; row 59 < 60.
  expect(await ui.find({ type: 'Text', text: /^█{21}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^░{15}$/ })).toBeDefined()
  await ui.unmount()
})

test('desktop before the first response: one no-data row in the drawing', HU, async ($, on) => {
  engine(on, false)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  const ui = await mount($, 'desktop')
  const source = String((await ui.find({ type: 'Svg' }))!.props.source)
  expect(source).toMatch(/még nincs adat/)
  await ui.unmount()
})

test('before the first response: no data label', HU, async ($, on) => {
  engine(on, false)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /még nincs adat/ })).toBeDefined()
  await ui.unmount()
})

test('/hasznalat ki: the band disappears, be: it comes back', HU, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  expect((await $.command.run({ command: 'hasznalat', args: 'ki' } as never)).text).toBe('Használati sáv kikapcsolva.')
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'hasznalat', args: 'be' } as never)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: ' 59%' })).toBeDefined()
  await ui.unmount()
})

test('English too', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Context/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Week ' })).toBeDefined()
  await ui.unmount()
})
