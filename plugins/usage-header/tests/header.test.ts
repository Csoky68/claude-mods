import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatLocation, mergeLimits, parseMachines, shortenPath } from '../hooks/register'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2099-10-05T14:20:00Z' },
  { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2099-10-09T08:00:00Z' },
]

const HU = { options: { language: 'hu' } }

const HOME = '/Users/csoky'
const ROOT = '/Users/csoky/CLAUDE/Projects/claude-mods'

function engine(on: On, withData = true, env: { ssh?: string; host?: string; rateLimits?: unknown[][] } = {}) {
  mock.store(on)
  on('process.run', ($, e, next) =>
    e.argv[0] === 'scutil' ? ({ value: { exitCode: 0, stdout: `${env.host ?? 'macmini-m4-hub'}\n`, stderr: '' } }) as never : next(e))
  on('env.get', ($, e, next) =>
    e.name === 'HOME' ? ({ value: HOME }) as never : e.name === 'SSH_CONNECTION' ? ({ value: env.ssh }) as never : next(e))
  on('session.root', () => ({ value: ROOT }) as never)
  const responses = env.rateLimits ?? [LIMITS]
  let call = 0
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => e as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: withData ? { window: 1_000_000, tokens: 591_000, percent: 59.1 } : { window: 1_000_000 },
      rateLimits: responses[Math.min(call++, responses.length - 1)],
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

for (const surface of ['terminal', 'desktop'] as const) {
  test(`location row is the last row, even without usage data (${surface})`, HU, async ($, on) => {
    engine(on, false)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface)
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^Hely/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'M4 · helyi · ~/CLAUDE/Projects/claude-mods' })).toBeDefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      const source = String(svg!.props.source)
      expect(source).toMatch(/>Hely<.*>M4 · helyi · ~\/CLAUDE\/Projects\/claude-mods<\/text><\/svg>$/)
      expect(source).toMatch(/még nincs adat/)
      expect(String(svg!.props.alt)).toMatch(/Hely: M4 · helyi · ~\/CLAUDE\/Projects\/claude-mods$/)
    }
    await ui.unmount()
  })
}

test('location over SSH with an unmapped host, in English', { options: { language: 'en' } }, async ($, on) => {
  engine(on, true, { ssh: '100.64.0.1 50000 100.64.0.2 22', host: 'some-box' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Where/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'some-box · SSH · ~/CLAUDE/Projects/claude-mods' })).toBeDefined()
  await ui.unmount()
})

test('a response without five_hour keeps the previous five_hour', HU, async ($, on) => {
  engine(on, true, { rateLimits: [LIMITS, [{ ...LIMITS[1]!, percentUsed: 50 }]] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  await $.session.measure({ changed: ['rateLimits'] } as never)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '5 óra ' })).toBeDefined()
  // The second response arrived (the weekly value moved) and five_hour survived it.
  expect(await ui.find({ type: 'Text', text: ' 50%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 34%' })).toBeDefined()
  await ui.unmount()
})

test('mergeLimits: keeps missing kinds, drops expired ones', HU, async () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  const prev = [
    { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-21T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-20T00:00:00Z' },
  ]
  const merged = mergeLimits(prev, [{ kind: 'seven_day', percentUsed: 5, resetsAt: '2026-10-27T00:00:00Z' }], now)
  expect(merged).toEqual([
    { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-21T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 5, resetsAt: '2026-10-27T00:00:00Z' },
  ])
  expect(mergeLimits(prev, [], now)).toEqual([prev[0]])
})

test('formatLocation: machine map, home tilde and middle ellipsis', HU, async () => {
  const map = parseMachines('macmini-m4-hub=M4,macmini-m1-hub=M1,Csakanyos-MacBook-Pro=MacBook')
  expect(map['csakanyos-macbook-pro']).toBe('MacBook')
  const loc = { machine: 'M1', ssh: true, path: '/Users/csoky/CLAUDE/Projects/Könyvelés asszisztens-dev' }
  expect(formatLocation(loc, 'helyi', HOME, 80)).toBe('M1 · SSH · ~/CLAUDE/Projects/Könyvelés asszisztens-dev')
  expect(formatLocation(loc, 'helyi', HOME, 50)).toBe('M1 · SSH · ~/…/Projects/Könyvelés asszisztens-dev')
  expect(shortenPath('/Users/csoky/a/b/c/d/eeeeeeeeee/ffffffffff', HOME, 25)).toBe('~/…/eeeeeeeeee/ffffffffff')
  expect(shortenPath('/Users/csoky/a/b/c/d/eeeeeeeeee/ffffffffff', HOME, 24)).toBe('…/eeeeeeeeee/ffffffffff')
  expect(shortenPath('/opt/x', HOME, 3)).toBe('/opt/x')
})
