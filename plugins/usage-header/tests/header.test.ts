import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  DEFAULT_COMPACT_RESERVE, compactionLeft, dropUntil, forecast, formatCost, formatLocation, formatSpan, limitParts,
  mergeLimits, parseMachines, recordSample, recordTurn, shortenPath, whereParts,
} from '../hooks/register'
import type { Part } from '../hooks/register'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2099-10-05T14:20:00Z' },
  { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2099-10-09T08:00:00Z' },
]

const HU = { options: { language: 'hu' } }

const HOME = '/Users/csoky'
const ROOT = '/Users/csoky/CLAUDE/Projects/claude-mods'

type Env = {
  ssh?: string; host?: string; rateLimits?: unknown[][]
  git?: { branch: string; porcelain: string }; contexts?: number[]; startedAt?: number; usd?: number; threshold?: number
  /** The /mods switchboard file's text; absent: no file. Read through `.text` so a test can change it. */
  switches?: { text?: string }
  /** installed_plugins.json's text; absent: no file (and no plugin cache either). */
  installed?: string
}

const INSTALLED = `${'/Users/csoky'}/.claude/plugins/installed_plugins.json`
const BOTH = JSON.stringify({ version: 2, plugins: { 'mods@csoky-private': [{}], 'chat-inventory@csoky-private': [{}], 'usage-header@claude-mods': [{}] } })

const SWITCHES = `${'/Users/csoky'}/.claude/mods/switches.json`

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } }) as never

function engine(on: On, withData = true, env: Env = {}) {
  mock.store(on)
  on('process.run', ($, e, next) => {
    if (e.argv[0] === 'scutil') return run(`${env.host ?? 'macmini-m4-hub'}\n`)
    if (e.argv[0] === 'git' && e.argv[1] === 'rev-parse') return env.git ? run(`${env.git.branch}\n`) : run('', 128)
    if (e.argv[0] === 'git' && e.argv[1] === 'status') return env.git ? run(env.git.porcelain) : run('', 128)
    return next(e)
  })
  on('env.get', ($, e, next) =>
    e.name === 'HOME' ? ({ value: HOME }) as never : e.name === 'SSH_CONNECTION' ? ({ value: env.ssh }) as never : next(e))
  on('session.root', () => ({ value: ROOT }) as never)
  // The switchboard file is always faked: the real one on this machine never leaks into a test.
  // So is every other path (installed_plugins.json, the plugin cache, ~/.claude/mods).
  on('fs.exists', ($, e) =>
    ({ value: e.path === SWITCHES ? env.switches?.text !== undefined : e.path === INSTALLED ? env.installed !== undefined : false }) as never)
  on('fs.read', ($, e) => {
    const text = e.path === SWITCHES ? env.switches?.text : e.path === INSTALLED ? env.installed : undefined
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  const responses = env.rateLimits ?? [LIMITS]
  let call = 0
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => e as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  const contexts = env.contexts ?? [591_000]
  let ctxCall = 0
  const startedAt = env.startedAt ?? Date.now() - 80 * 60_000
  on('session.usage', ($, e) => {
    if ((e as { breakdown?: string }).breakdown)
      return ({ value: { startedAt, context: { window: 1_000_000, breakdown: env.threshold === undefined ? undefined : { autoCompactThreshold: env.threshold, isAutoCompactEnabled: true } }, rateLimits: [] } }) as never
    const tok = contexts[Math.min(ctxCall++, contexts.length - 1)]!
    return ({
      value: {
        startedAt,
        context: withData ? { window: 1_000_000, tokens: tok, percent: tok / 10_000 } : { window: 1_000_000 },
        rateLimits: responses[Math.min(call++, responses.length - 1)],
        ...(env.usd === undefined ? {} : { cost: { usd: env.usd } }),
      },
    }) as never
  })
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
      expect(String(svg!.props.alt)).toMatch(/^Kontextus 59% 591k\/1M · még ~376k tömörítésig · 5 óra 34% → \d\d:\d\d · még \d+n \d+ó · Hét 93% ⚠ → /)
      expect(Number(svg!.props.width)).toBeLessThanOrEqual(840)
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
      expect(source).toMatch(/>Hely<.*>M4 · helyi · ~\/CLAUDE\/Projects\/claude-mods · 1ó 20p<\/text><\/svg>$/)
      expect(source).toMatch(/még nincs adat/)
      expect(String(svg!.props.alt)).toMatch(/Hely: M4 · helyi · ~\/CLAUDE\/Projects\/claude-mods · 1ó 20p$/)
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

const MIN = 60_000
const H = 60 * MIN

test('countdown and duration formatting', HU, async () => {
  expect(formatSpan(2 * H + 15 * MIN, 'hu')).toBe('2ó 15p')
  expect(formatSpan(3 * 24 * H + 8 * H + 20 * MIN, 'hu')).toBe('3n 8ó')
  expect(formatSpan(9 * MIN, 'hu')).toBe('9p')
  expect(formatSpan(2 * H + 15 * MIN, 'en')).toBe('2h 15m')
  expect(formatSpan(3 * 24 * H + 8 * H, 'en')).toBe('3d 8h')
  expect(formatSpan(-5 * MIN, 'hu')).toBe('0p')
  expect(formatCost(4.1)).toBe('≈ $4.10')
  const now = Date.parse('2026-10-21T10:00:00Z')
  const parts = limitParts({ kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-21T12:15:00Z' }, [], now, 'hu')
  expect(parts.map(p => p.text)).toEqual(['még 2ó 15p'])
  expect(limitParts({ kind: 'seven_day', percentUsed: 5, resetsAt: '2026-10-24T18:00:00Z' }, [], now, 'en').map(p => p.text)).toEqual(['in 3d 8h'])
})

test('forecast: runs out before reset, lasts, not enough data, window reset clears', HU, async () => {
  const t0 = Date.parse('2026-10-21T10:00:00Z')
  const reset = t0 + 5 * H
  // 10% per 30 min from 34% at t0+60m: 100% at t0 + 60m + 198m = t0 + 4h18m < reset.
  const rising = [{ t: t0, p: 14 }, { t: t0 + 30 * MIN, p: 24 }, { t: t0 + 60 * MIN, p: 34 }]
  expect(forecast(rising, reset, 10 * MIN)).toEqual({ kind: 'exhaust', at: t0 + 60 * MIN + 198 * MIN })
  const slow = [{ t: t0, p: 30 }, { t: t0 + 60 * MIN, p: 32 }]
  expect(forecast(slow, reset, 10 * MIN)).toEqual({ kind: 'enough' })
  expect(forecast([{ t: t0, p: 10 }, { t: t0 + 5 * MIN, p: 20 }], reset, 10 * MIN)).toBeNull()
  expect(forecast([{ t: t0, p: 10 }], reset, 10 * MIN)).toBeNull()
  // The week needs 6 hours of readings.
  expect(forecast(slow, reset, 6 * H)).toBeNull()
  const parts = limitParts({ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(reset).toISOString() }, rising, t0 + 60 * MIN, 'hu')
  expect(parts[1]).toMatchObject({ text: expect.stringMatching(/^elfogy ~\d\d:\d\d ⚠$/), color: 'yellow', estimate: true })
  expect(limitParts({ kind: 'five_hour', percentUsed: 32, resetsAt: new Date(reset).toISOString() }, slow, t0 + 60 * MIN, 'hu')[1]!.text).toBe('elég resetig')

  let history = recordSample({}, { kind: 'five_hour', percentUsed: 10, resetsAt: 'A' }, t0)
  history = recordSample(history, { kind: 'five_hour', percentUsed: 12, resetsAt: 'A' }, t0 + 5 * MIN)
  expect(history.five_hour!.samples).toHaveLength(2)
  history = recordSample(history, { kind: 'five_hour', percentUsed: 1, resetsAt: 'B' }, t0 + 6 * MIN)
  expect(history.five_hour).toEqual({ resetsAt: 'B', samples: [{ t: t0 + 6 * MIN, p: 1 }] })
  for (let i = 0; i < 60; i++) history = recordSample(history, { kind: 'five_hour', percentUsed: i, resetsAt: 'B' }, t0 + i * 2 * MIN)
  expect(history.five_hour!.samples).toHaveLength(50)
})

test('compaction remaining and turns', HU, async () => {
  expect(compactionLeft(591_000, 1_000_000 - DEFAULT_COMPACT_RESERVE, [])).toEqual({ left: 376_000, turns: null })
  expect(compactionLeft(591_000, 967_000, [531_000, 561_000, 591_000])).toEqual({ left: 376_000, turns: 12 })
  expect(compactionLeft(980_000, 967_000, [])).toBeNull()
  expect(recordTurn([500, 600], 700)).toEqual([500, 600, 700])
  expect(recordTurn([500, 600], 100)).toEqual([100])
})

test('context row: compaction remaining and turns after three turn-end samples (terminal)', HU, async ($, on) => {
  engine(on, true, { contexts: [531_000, 531_000, 561_000, 591_000], threshold: 967_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  for (let i = 0; i < 3; i++) await $.session.measure({ changed: ['context'] } as never)
  const ui = await mount($, 'terminal', 160)
  expect(await ui.find({ type: 'Text', text: ' · még ~376k tömörítésig' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' (~12 kör)' })).toBeDefined()
  await ui.unmount()
})

test('location row: git branch, uncommitted count, duration and cost (terminal)', HU, async ($, on) => {
  engine(on, true, { git: { branch: 'main', porcelain: ' M a.ts\n?? b.ts\n M c.ts\n' }, usd: 4.1 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal', 160)
  expect(await ui.find({ type: 'Text', text: 'M4 · helyi · ~/CLAUDE/Projects/claude-mods' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · main' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · 3 módosított' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · 1ó 20p' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ≈ $4.10' })).toBeDefined()
  await ui.unmount()
})

test('not a git repo, no cost: those parts are omitted', HU, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal', 160)
  expect(await ui.find({ type: 'Text', text: /módosított|\$/ })).toBeUndefined()
  await ui.unmount()
})

test('narrow width drops cost, then turns, then countdown', HU, async () => {
  const parts: Part[] = [
    { text: 'még ~376k tömörítésig', sep: ' · ', rank: 7 },
    { text: '(~12 kör)', sep: ' ', rank: 2 },
    { text: 'még 2ó 15p', sep: ' · ', rank: 3 },
    { text: 'elfogy ~19:50 ⚠', sep: ' · ', rank: 4 },
    { text: '≈ $4.10', sep: ' · ', rank: 1 },
  ]
  const order: string[][] = []
  dropUntil(parts, kept => (order.push(kept.map(p => p.text)), false))
  expect(order[1]).not.toContain('≈ $4.10')
  expect(order[1]).toContain('(~12 kör)')
  expect(order[2]).not.toContain('(~12 kör)')
  expect(order[2]).toContain('még 2ó 15p')
  expect(order[3]).not.toContain('még 2ó 15p')
  expect(order[3]).toContain('elfogy ~19:50 ⚠')
  const w = whereParts({ machine: 'M4', ssh: false, path: '/x', git: { branch: 'main', dirty: 0 } }, { startedAt: 0, usd: 1 }, 20 * MIN, 'en')
  expect(w.map(p => p.text)).toEqual(['main', '20m', '≈ $1.00'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`narrow band keeps the location's duration but drops its cost first (${surface})`, HU, async ($, on) => {
    engine(on, true, { git: { branch: 'main', porcelain: ' M a.ts\n' }, usd: 4.1 })
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface, surface === 'terminal' ? 88 : 80)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).not.toMatch(/≈ \$4\.10/)
    expect(drawn).toMatch(/1ó 20p/)
    expect(drawn).toMatch(/main/)
    await ui.unmount()
  })
}

for (const [label, text] of [
  ['off', '{ "usage-header": false }'],
  ['hidden', '{ "usage-header:hidden": true }'],
] as const) {
  test(`the /mods switchboard: ${label} in switches.json draws nothing`, HU, async ($, on) => {
    engine(on, true, { switches: { text } })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    const ui = await mount($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /%/ }), 'no band').toBeUndefined()
    expect(await ui.find({ key: 'engine' }), 'the rest still draws').toBeDefined()
    await ui.unmount()
  })
}

test('the switchboard is polled: turned off, then on again, within 5 seconds', HU, async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const switches: { text?: string } = { text: '{"cache-clock": false}' }
  engine(on, true, { switches })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: ' 59%' }), 'on: another key does not matter').toBeDefined()
  await ui.unmount()

  switches.text = '{"cache-clock": false, "usage-header": false}'
  await clock.advance(5000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /%/ }), 'off after one poll').toBeUndefined()
  await ui.unmount()

  // A half-written file keeps the last decision.
  switches.text = '{"usage-header'
  await clock.advance(5000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /%/ }), 'still off').toBeUndefined()
  await ui.unmount()

  delete switches.text
  await clock.advance(5000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: ' 59%' }), 'no file: on again').toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Mods and Inventory buttons in the band; a press writes the open request (${surface})`, HU, async ($, on) => {
    engine(on, true, { installed: BOTH, git: { branch: 'main', porcelain: '' }, usd: 49.36 })
    // The request is a state write: every write of the key is seen here, before the kit stores it.
    const requests: unknown[] = []
    on('state.set', ($, e, next) => {
      if (e.plugin === 'usage-header' && e.key === 'openPane') requests.push(e.value)
      return next(e)
    })
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface, 140)
    const mods = await ui.find({ key: 'open-mods' })
    const inv = await ui.find({ key: 'open-inventory' })
    expect(mods?.type).toBe('Button')
    expect(mods?.props.label).toBe('Modok')
    expect(inv?.props.label).toBe('Inventory')
    if (surface === 'desktop') {
      // The drawing gives the button column its room: 140 columns * 7 px - the column.
      const svg = await ui.find({ type: 'Svg' })
      expect(Number(svg!.props.width)).toBeLessThanOrEqual(140 * 7 - 104)
    } else {
      // Terminal: at the end of the location row, nothing dropped at 140 columns.
      expect(JSON.stringify(await ui.drawn())).toMatch(/≈ \$49\.36/)
    }
    // Nothing is written before a press.
    expect(requests).toEqual([])
    await ui.press({ key: 'open-inventory' })
    expect(requests).toEqual([{ pane: 'inventory', n: 1 }])
    await ui.press({ key: 'open-mods' })
    expect(requests).toEqual([{ pane: 'inventory', n: 1 }, { pane: 'mods', n: 2 }])
    await ui.unmount()
  })

  test(`no buttons when neither mod is installed (${surface})`, HU, async ($, on) => {
    engine(on, true, { installed: JSON.stringify({ version: 2, plugins: { 'usage-header@claude-mods': [{}] } }) })
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface, 140)
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  })

  test(`a mod switched off in switches.json loses its button (${surface})`, HU, async ($, on) => {
    engine(on, true, { installed: BOTH, switches: { text: '{ "chat-inventory": false }' } })
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface, 140)
    expect(await ui.find({ key: 'open-mods' })).toBeDefined()
    expect(await ui.find({ key: 'open-inventory' })).toBeUndefined()
    await ui.unmount()
  })
}

test('terminal: narrow width drops the buttons first, the location row still fits', HU, async ($, on) => {
  engine(on, true, { installed: BOTH, git: { branch: 'main', porcelain: '' } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal', 80)
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toMatch(/main/)
  await ui.unmount()
})

test('English labels', { options: { language: 'en' } }, async ($, on) => {
  engine(on, true, { installed: BOTH })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal', 140)
  expect((await ui.find({ key: 'open-mods' }))?.props.label).toBe('Mods')
  await ui.unmount()
})
