import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Burn, Context, Git, Limit, Location, Sample, SessionInfo } from '../types'

const context = atom({ plugin: 'usage-header', key: 'context' } as const, null)
const limits = atom({ plugin: 'usage-header', key: 'limits' } as const, [])
const location = atom({ plugin: 'usage-header', key: 'location' } as const, null)
// When off the band is empty; the tool-hub reads this too.
const isOn = atom({ plugin: 'usage-header', key: 'isOn' } as const, true)
const burn = atom({ plugin: 'usage-header', key: 'burn' } as const, {})
const turns = atom({ plugin: 'usage-header', key: 'turns' } as const, [])
const compactAt = atom({ plugin: 'usage-header', key: 'compactAt' } as const, null)
const sessionInfo = atom({ plugin: 'usage-header', key: 'session' } as const, null)

const WARN_AT = 90
const CAUTION_AT = 70
const LABEL = 11
const MAX_BAR = 60
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const MAX_SAMPLES = 50
// A forecast needs readings spanning at least this long.
const MIN_SPAN: Record<string, number> = { five_hour: 10 * MINUTE, seven_day: 6 * HOUR }
// Fallback when the breakdown exposes no autoCompactThreshold: Claude Code's documented default
// reserves ~20k output tokens plus a ~13k autocompact buffer below the window (the /context
// "Autocompact buffer" row reads 33k), so compaction runs at window - 33k.
export const DEFAULT_COMPACT_RESERVE = 33_000

type Lang = 'hu' | 'en'

const STRINGS = {
  hu: {
    context: 'Kontextus',
    limits: 'Limitek',
    windows: { five_hour: '5 óra', seven_day: 'Hét' } as Record<string, string>,
    days: ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo'],
    noData: 'még nincs adat (az első válasz után jelenik meg)',
    where: 'Hely',
    local: 'helyi',
    command: 'Használati sáv a prompt fölött be/ki',
    on: 'Használati sáv bekapcsolva.',
    off: 'Használati sáv kikapcsolva.',
    usage: 'Használat: /hasznalat [be|ki]',
    hint: '[be|ki]',
    units: { d: 'n', h: 'ó', m: 'p' },
    left: (d: string) => `még ${d}`,
    compact: (n: string) => `még ~${n} tömörítésig`,
    turns: (n: number) => `(~${n} kör)`,
    exhaust: (at: string) => `elfogy ~${at} ⚠`,
    enough: 'elég resetig',
    estimate: 'becslés',
    modified: (n: number) => `${n} módosított`,
  },
  en: {
    context: 'Context',
    limits: 'Limits',
    windows: { five_hour: '5h', seven_day: 'Week' } as Record<string, string>,
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    noData: 'no data yet (shows after the first response)',
    where: 'Where',
    local: 'local',
    command: 'Usage band above the prompt on/off',
    on: 'Usage band on.',
    off: 'Usage band off.',
    usage: 'Usage: /hasznalat [on|off]',
    hint: '[on|off]',
    units: { d: 'd', h: 'h', m: 'm' },
    left: (d: string) => `in ${d}`,
    compact: (n: string) => `~${n} until compaction`,
    turns: (n: number) => `(~${n} turns)`,
    exhaust: (at: string) => `runs out ~${at} ⚠`,
    enough: 'lasts until reset',
    estimate: 'estimate',
    modified: (n: number) => `${n} modified`,
  },
}

// The module reloads on every settings change, so deciding once at startup is enough.
let lang: Lang = 'hu'
const t = () => STRINGS[lang]

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

export const DEFAULT_MACHINES = 'macmini-m4-hub=M4,macmini-m1-hub=M1,Csakanyos-MacBook-Pro=MacBook'

// "host=Name,host=Name" -> lower-cased host -> display name.
export function parseMachines(spec: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const pair of spec.split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const host = pair.slice(0, at).trim().toLowerCase()
    const name = pair.slice(at + 1).trim()
    if (host && name) map[host] = name
  }
  return map
}

export const machineName = (host: string, map: Record<string, string>) => map[host.trim().toLowerCase()] ?? host.trim()

// HOME prefix -> "~"; longer than `max`: middle ellipsis that keeps the last two segments.
export function shortenPath(path: string, home: string, max: number): string {
  let p = path
  if (home && (p === home || p.startsWith(home.endsWith('/') ? home : `${home}/`))) p = `~${p.slice(home.replace(/\/$/, '').length)}`
  if (p.length <= max) return p
  const segs = p.split('/')
  if (segs.length <= 3) return p
  const tail = segs.slice(-2).join('/')
  const head = `${segs[0]}/…/${tail}`
  return head.length <= max ? head : `…/${tail}`
}

// "M4 · helyi · ~/CLAUDE/Projects/claude-mods", the path shortened to fit `width` characters.
export function formatLocation(loc: Location, localWord: string, home: string, width: number): string {
  const prefix = [loc.machine, loc.ssh ? 'SSH' : localWord].filter(Boolean).join(' · ')
  return `${prefix} · ${shortenPath(loc.path, home, Math.max(8, width - prefix.length - 3))}`
}

// Keep the last known value per kind (a response may omit a window); drop only what has reset.
export function mergeLimits(prev: readonly Limit[], incoming: readonly Limit[], now: number): Limit[] {
  const byKind = new Map<string, Limit>()
  for (const l of [...prev, ...incoming]) byKind.set(l.kind, l)
  return [...byKind.values()].filter(l => l.resetsAt === undefined || !(Date.parse(l.resetsAt) < now))
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(n)
}

// A span as its two largest units: "3n 8ó", "2ó 15p", "15p" (en: "3d 8h", "2h 15m", "15m").
export function formatSpan(ms: number, l: Lang): string {
  const u = STRINGS[l].units
  const total = Math.max(0, Math.round(ms / MINUTE))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) return `${d}${u.d} ${h}${u.h}`
  if (h > 0) return `${h}${u.h} ${m}${u.m}`
  return `${m}${u.m}`
}

export const formatCost = (usd: number) => `≈ $${usd.toFixed(2)}`

const hhmm = (ms: number) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

// Appends a reading to the window's history; a new resetsAt starts a fresh history.
export function recordSample(history: Burn, limit: Limit, now: number): Burn {
  const prev = history[limit.kind]
  const samples = prev !== undefined && prev.resetsAt === limit.resetsAt ? prev.samples : []
  const last = samples[samples.length - 1]
  if (last !== undefined && last.p === limit.percentUsed && now - last.t < MINUTE) return history
  const next = [...samples, { t: now, p: limit.percentUsed }].slice(-MAX_SAMPLES)
  return { ...history, [limit.kind]: { resetsAt: limit.resetsAt, samples: next } }
}

export type Forecast = { kind: 'exhaust'; at: number } | { kind: 'enough' }

// Least-squares slope over the window's readings, anchored at the latest one. Null when the
// readings span less than `minSpan` (not enough data to say anything).
export function forecast(samples: readonly Sample[], resetsAt: number, minSpan: number): Forecast | null {
  if (samples.length < 2) return null
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  if (last.t - first.t < minSpan) return null
  const n = samples.length
  const mt = samples.reduce((a, s) => a + s.t, 0) / n
  const mp = samples.reduce((a, s) => a + s.p, 0) / n
  let num = 0
  let den = 0
  for (const s of samples) {
    num += (s.t - mt) * (s.p - mp)
    den += (s.t - mt) ** 2
  }
  const slope = den > 0 ? num / den : 0
  if (slope <= 0) return { kind: 'enough' }
  const at = last.t + (100 - last.p) / slope
  return at < resetsAt ? { kind: 'exhaust', at } : { kind: 'enough' }
}

// Tokens left until auto-compaction, and how many turns that is at the average growth per turn
// (null below three turn-end samples or without growth).
export function compactionLeft(used: number, threshold: number, samples: readonly number[]): { left: number; turns: number | null } | null {
  const left = threshold - used
  if (!(left > 0)) return null
  const recent = samples.slice(-10)
  if (recent.length < 3) return { left, turns: null }
  const growth = (recent[recent.length - 1]! - recent[0]!) / (recent.length - 1)
  return { left, turns: growth > 0 ? Math.floor(left / growth) : null }
}

// Turn-end context sizes; a drop (compaction, /clear) starts the series over.
export function recordTurn(samples: readonly number[], total: number): number[] {
  const last = samples[samples.length - 1]
  if (last !== undefined && total < last) return [total]
  if (last === total) return [...samples]
  return [...samples, total].slice(-20)
}

// Before the first response the percentage is unknown: no data yet.
export function toContext(u: SessionContextUsage): Context | null {
  if (u.percent === undefined || !(u.window > 0)) return null
  return { total: u.tokens ?? Math.round((u.percent / 100) * u.window), max: u.window, percent: u.percent }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

const levelColor = (percent: number) => (percent >= WARN_AT ? 'red' : percent >= CAUTION_AT ? 'yellow' : 'green')

const pctLabel = (percent: number) => `${Math.round(percent)}%${percent >= WARN_AT ? ' ⚠' : ''}`

// Terminal block bar: filled cells in the level colour, the rest as a dim track.
export function blocks(percent: number, width: number): { filled: string; track: string } {
  const full = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return { filled: '█'.repeat(full), track: '░'.repeat(width - full) }
}

function resetText(kind: string, resetsAt?: string): string {
  if (resetsAt === undefined) return ''
  const at = new Date(resetsAt)
  return kind === 'five_hour' ? ` → ${hhmm(at.getTime())}` : ` → ${t().days[at.getDay()]} ${hhmm(at.getTime())}`
}

// An optional text after a row. `rank` says what goes first when space is short
// (1 cost, 2 turns, 3 countdown, then forecast, duration, git); absent = never dropped.
export type Part = { text: string; sep: string; rank?: number; color?: string; estimate?: boolean }

export const partsLength = (parts: readonly Part[]) => parts.reduce((a, p) => a + p.sep.length + p.text.length, 0)

// Drops whole ranks, lowest first, until `fits` holds or nothing droppable is left.
export function dropUntil(parts: Part[], fits: (kept: Part[]) => boolean): Part[] {
  let kept = parts
  const ranks = [...new Set(parts.map(p => p.rank).filter((r): r is number => r !== undefined))].sort((a, b) => a - b)
  for (const rank of ranks) {
    if (fits(kept)) break
    kept = kept.filter(p => p.rank !== rank)
  }
  return kept
}

export const RANK = { cost: 1, turns: 2, countdown: 3, forecast: 4, duration: 5, git: 6, compact: 7 }

export type SvgRow = { label: string; percent: number; detail: string; extra: Part[] }

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Remote surfaces (desktop, mobile, vscode): the whole band as one SVG, so a proportional font
// cannot misalign the bars. Dark theme by default, light overrides via prefers-color-scheme.
export const SVG_W = 560
const ROW_H = 22
const PAD = 4
const BAR_X = 76
const BAR_W = 300
const BAR_H = 8
const DETAIL_X = BAR_X + BAR_W + 66
// The second (muted) column starts after the widest detail ("→ Sze 03:00", "591k / 1M").
const EXTRA_X = DETAIL_X + 86
// Average advance of a 12.5 px system-ui character, used to size the canvas.
const CH = 6.6

// Some renderers do not inherit dominant-baseline into a tspan, so it is repeated there.
const tspans = (parts: readonly Part[], first: boolean) =>
  parts
    .map((p, i) => `${i === 0 && first ? '' : esc(p.sep)}${p.color ? `<tspan class="${p.color}" dominant-baseline="central">${esc(p.text)}</tspan>` : esc(p.text)}`)
    .join('')

export const svgCanvasWidth = (rows: readonly SvgRow[], infoText: string | undefined) =>
  Math.ceil(
    Math.max(
      SVG_W,
      ...rows.map(r => (r.extra.length === 0 ? 0 : EXTRA_X + partsLength(r.extra) * CH + 8)),
      infoText === undefined ? 0 : BAR_X + infoText.length * CH + 8,
    ),
  )

type TextRow = { label: string; text: string; extra?: Part[] }
const fullText = (row: TextRow) => `${row.text}${(row.extra ?? []).map(p => p.sep + p.text).join('')}`
export function bandSvg(rows: SvgRow[], noData?: TextRow, info?: TextRow): string {
  const count = rows.length + (noData ? 1 : 0) + (info ? 1 : 0)
  const height = Math.max(1, count) * ROW_H + PAD * 2
  const width = svgCanvasWidth(rows, info === undefined ? undefined : fullText(info))
  const style =
    '<style>' +
    'text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12.5px}' +
    '.t{fill:#e6e6e6}.m{fill:#9a9a9a}.tr{fill:rgba(255,255,255,0.12)}' +
    '.green{fill:#3fb950}.yellow{fill:#d29922}.red{fill:#f85149}' +
    '@media (prefers-color-scheme: light){.t{fill:#1f2328}.m{fill:#656d76}.tr{fill:rgba(0,0,0,0.10)}' +
    '.green{fill:#1a7f37}.yellow{fill:#9a6700}.red{fill:#cf222e}}' +
    '</style>'
  const parts: string[] = []
  if (noData) {
    const y = PAD + ROW_H / 2
    parts.push(`<text class="t" x="0" y="${y}" dominant-baseline="central" font-weight="600">${esc(noData.label)}</text>`)
    parts.push(`<text class="m" x="${BAR_X}" y="${y}" dominant-baseline="central">${esc(noData.text)}</text>`)
  }
  rows.forEach((row, i) => {
    const y = PAD + (i + (noData ? 1 : 0)) * ROW_H + ROW_H / 2
    const level = levelColor(row.percent)
    const p = Math.min(100, Math.max(0, row.percent))
    const fill = p <= 0 ? 0 : Math.max(BAR_H, (p / 100) * BAR_W)
    parts.push(`<text class="t" x="0" y="${y}" dominant-baseline="central" font-weight="600">${esc(row.label)}</text>`)
    parts.push(`<rect class="tr" x="${BAR_X}" y="${y - BAR_H / 2}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>`)
    if (fill > 0)
      parts.push(`<rect class="${level}" x="${BAR_X}" y="${y - BAR_H / 2}" width="${fill.toFixed(1)}" height="${BAR_H}" rx="${BAR_H / 2}"/>`)
    parts.push(`<text class="${level}" x="${BAR_X + BAR_W + 12}" y="${y}" dominant-baseline="central" font-weight="700">${esc(pctLabel(row.percent))}</text>`)
    parts.push(`<text class="m" x="${DETAIL_X}" y="${y}" dominant-baseline="central">${esc(row.detail)}</text>`)
    if (row.extra.length > 0)
      parts.push(`<text class="m" x="${EXTRA_X}" y="${y}" dominant-baseline="central">${tspans(row.extra, true)}</text>`)
  })
  if (info) {
    const y = PAD + (count - 1) * ROW_H + ROW_H / 2
    parts.push(`<text class="t" x="0" y="${y}" dominant-baseline="central" font-weight="600">${esc(info.label)}</text>`)
    parts.push(`<text class="m" x="${BAR_X}" y="${y}" dominant-baseline="central">${esc(info.text)}${tspans(info.extra ?? [], false)}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${style}${parts.join('')}</svg>`
}

let lastRaw = ''
let home = ''
// The window the compaction threshold was read for; read again when the model's window changes.
let compactWindow = 0

async function refresh($: EngineInterface): Promise<void> {
  // Status-line figures only: free, no model call.
  const usage = await $.session.usage()
  const ctx = toContext(usage.context)
  await update($, context, prev => ctx ?? prev)
  await update($, sessionInfo, () => ({ startedAt: usage.startedAt, ...(usage.cost ? { usd: usage.cost.usd } : {}) }))
  const raw = JSON.stringify(usage.rateLimits)
  if (raw !== lastRaw) {
    lastRaw = raw
    $.ui.log(raw, { to: 'debug' })
  }
  const now = Date.now()
  const merged = mergeLimits(await read($, limits), usage.rateLimits, now)
  await update($, limits, () => merged)
  const before = await read($, burn)
  let history = before
  for (const l of usage.rateLimits) if (l.kind in MIN_SPAN) history = recordSample(history, l, now)
  if (history !== before) {
    // Forget windows that have reset or are no longer reported.
    const live = Object.fromEntries(Object.entries(history).filter(([kind]) => merged.some(l => l.kind === kind)))
    await update($, burn, () => live)
    await $.store.set('burn', live)
  }
  if (usage.context.window > 0 && usage.context.window !== compactWindow) {
    compactWindow = usage.context.window
    await refreshCompaction($, usage.context.window)
  }
}

// The threshold comes from the local 'summary' breakdown (estimated locally, no request sent).
async function refreshCompaction($: EngineInterface, window: number): Promise<void> {
  let at: number | null = window - DEFAULT_COMPACT_RESERVE
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (b !== undefined) at = b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? at) : null
  } catch {
    // Keep the documented default.
  }
  await update($, compactAt, () => at)
}

async function hostName($: EngineInterface): Promise<string> {
  for (const argv of [['scutil', '--get', 'LocalHostName'], ['hostname', '-s']]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5000 })
      if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
    } catch {
      // Try the next command.
    }
  }
  return ''
}

async function currentPath($: EngineInterface): Promise<string> {
  try {
    return await $.session.root()
  } catch {
    return await $.session.cwd()
  }
}

// Branch and uncommitted entry count of the project root; null outside a repo.
async function gitState($: EngineInterface, cwd: string): Promise<Git | null> {
  if (!cwd) return null
  try {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 2000 })
    if (head.exitCode !== 0 || !head.stdout.trim()) return null
    const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 2000 })
    const dirty = status.exitCode === 0 ? status.stdout.split('\n').filter(line => line.trim()).length : 0
    return { branch: head.stdout.trim(), dirty }
  } catch {
    return null
  }
}

// Machine and mode once per session; path and git again at every turn end (no model call).
async function refreshLocation($: EngineInterface, machines: Record<string, string> | null): Promise<void> {
  const path = await currentPath($).catch(() => '')
  const git = await gitState($, path)
  if (machines === null) {
    await update($, location, prev => (prev === null ? null : { ...prev, path, git }))
    return
  }
  home = (await $.env.get('HOME')) ?? ''
  const ssh = Boolean((await $.env.get('SSH_CONNECTION'))?.trim())
  const machine = machineName(await hostName($), machines)
  await update($, location, () => ({ machine, ssh, path, git }))
}

async function setOn($: EngineInterface, wanted: boolean): Promise<void> {
  await update($, isOn, () => wanted)
  await $.store.set('isOn', wanted)
}

// The optional texts of each row, built once for both surfaces.
export function contextParts(c: Context, threshold: number | null, turnSamples: readonly number[], l: Lang): Part[] {
  if (threshold === null) return []
  const left = compactionLeft(c.total, threshold, turnSamples)
  if (left === null) return []
  const s = STRINGS[l]
  const parts: Part[] = [{ text: s.compact(tokens(left.left)), sep: ' · ', rank: RANK.compact }]
  if (left.turns !== null) parts.push({ text: s.turns(left.turns), sep: ' ', rank: RANK.turns })
  return parts
}

export function limitParts(limit: Limit, samples: readonly Sample[], now: number, l: Lang): Part[] {
  if (limit.resetsAt === undefined) return []
  const s = STRINGS[l]
  const resetsAt = Date.parse(limit.resetsAt)
  const parts: Part[] = [{ text: s.left(formatSpan(resetsAt - now, l)), sep: ' · ', rank: RANK.countdown }]
  const minSpan = MIN_SPAN[limit.kind]
  const f = minSpan === undefined ? null : forecast(samples, resetsAt, minSpan)
  if (f?.kind === 'exhaust')
    parts.push({ text: s.exhaust(hhmm(f.at)), sep: ' · ', rank: RANK.forecast, color: f.at - now <= 30 * MINUTE ? 'red' : 'yellow', estimate: true })
  else if (f?.kind === 'enough') parts.push({ text: s.enough, sep: ' · ', rank: RANK.forecast, estimate: true })
  return parts
}

export function whereParts(loc: Location, info: SessionInfo | null, now: number, l: Lang): Part[] {
  const s = STRINGS[l]
  const parts: Part[] = []
  if (loc.git) {
    parts.push({ text: loc.git.branch, sep: ' · ', rank: RANK.git })
    if (loc.git.dirty > 0) parts.push({ text: s.modified(loc.git.dirty), sep: ' · ', rank: RANK.git })
  }
  if (info !== null) {
    parts.push({ text: formatSpan(now - info.startedAt, l), sep: ' · ', rank: RANK.duration })
    if (info.usd !== undefined) parts.push({ text: formatCost(info.usd), sep: ' · ', rank: RANK.cost })
  }
  return parts
}

const altParts = (parts: readonly Part[]) => parts.map(p => `${p.sep}${p.text}${p.estimate ? ` (${t().estimate})` : ''}`).join('')

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language
  const machines = parseMachines(typeof options.machineNames === 'string' ? options.machineNames : DEFAULT_MACHINES)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    lang = await pickLanguage($, options.language)
    const saved = (await $.store.get('isOn')) !== false
    await update($, isOn, () => saved)
    // Readings survive reloads; refresh() drops windows that have reset since.
    const stored = await $.store.get('burn')
    if (stored !== null && typeof stored === 'object') await update($, burn, () => stored as Burn)
    await $.command.register({ name: 'hasznalat', description: t().command, argumentHint: t().hint, immediate: true })
    await refreshLocation($, machines).catch(() => undefined)
    await refresh($)
    return result
  })

  on('command.run', { command: 'hasznalat' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t().usage }
    await setOn($, wanted)
    if (wanted) await refresh($)
    return { text: wanted ? t().on : t().off }
  })

  // The tool-hub button toggles without a command (so no command line is left in the transcript).
  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'header') await setOn($, e.value.on).catch(() => undefined)
    return done
  })

  // At turn end and when limits move: refresh from the local figures, no API call.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const moved = e.changed.includes('context') || e.changed.includes('rateLimits')
    if (await read($, isOn)) {
      await refreshLocation($, null).catch(() => undefined)
      if (moved) await refresh($)
      if (e.changed.includes('context')) {
        const c = await read($, context)
        if (c !== null) await update($, turns, prev => recordTurn(prev, c.total))
      }
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const below = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const c = await read($, context)
    const now = Date.now()
    const shown = mergeLimits([], await read($, limits), now).filter(l => l.kind in t().windows)
    const loc = await read($, location)
    const history = await read($, burn)
    const info = await read($, sessionInfo)
    const ctxParts = c === null ? [] : contextParts(c, await read($, compactAt), await read($, turns), lang)
    const limParts = shown.map(l => limitParts(l, history[l.kind]?.samples ?? [], now, lang))
    const locParts = loc === null ? [] : whereParts(loc, info, now, lang)
    const columns = e.props.bodyColumns || e.viewport?.columns || 0

    // Every remote surface table carries Svg; the terminal's does not (its resolve may still list the key).
    if (e.surface !== 'terminal' && 'Svg' in ui && ui.Svg) {
      const { Svg } = ui
      // Columns are character cells; at ~7 px each this keeps the drawing inside the slot.
      const slot = columns > 0 ? Math.floor(columns * 7) : 900
      // Each row sheds its own texts, lowest rank first, until it fits the slot.
      const fitsExtra = (k: Part[]) => k.length === 0 || EXTRA_X + partsLength(k) * CH + 8 <= slot
      const keep = (parts: Part[]) => {
        const kept = dropUntil(parts, fitsExtra)
        return fitsExtra(kept) ? kept : []
      }
      const rows: SvgRow[] = []
      if (c !== null) rows.push({ label: t().context, percent: c.percent, detail: `${tokens(c.total)} / ${tokens(c.max)}`, extra: keep(ctxParts) })
      shown.forEach((l, i) =>
        rows.push({ label: t().windows[l.kind]!, percent: l.percentUsed, detail: resetText(l.kind, l.resetsAt).trim(), extra: keep(limParts[i]!) }))
      let where: TextRow | undefined
      if (loc !== null) {
        // Characters right of the label column; keep ~24 for the path before shedding other texts.
        const room = Math.floor((Math.min(slot, 900) - BAR_X - 8) / CH)
        const prefix = [loc.machine, loc.ssh ? 'SSH' : t().local].filter(Boolean).join(' · ').length + 3
        const extra = dropUntil(locParts, k => prefix + 24 + partsLength(k) <= room)
        where = { label: t().where, text: formatLocation(loc, t().local, home, room - partsLength(extra)), extra }
      }
      const noData = c === null ? { label: t().context, text: t().noData } : undefined
      const alt = [
        ...(noData ? [`${noData.label}: ${noData.text}`] : []),
        ...rows.map(r => `${r.label} ${pctLabel(r.percent)} ${r.detail.replace(' / ', '/')}`.trim() + altParts(r.extra)),
        ...(where ? [`${where.label}: ${where.text}${altParts(where.extra ?? [])}`] : []),
      ].join(' · ')
      const source = bandSvg(rows, noData, where)
      const canvas = Number(/viewBox="0 0 (\d+)/.exec(source)?.[1] ?? SVG_W)
      const width = columns > 0 ? Math.min(canvas, slot) : undefined
      return (
        <Box flexDirection="column">
          {below}
          <Svg key="usage-band" source={source} alt={alt} width={width} />
        </Box>
      )
    }

    const cols = columns || 80
    // One spare column so no row reaches the edge and wraps.
    const lineRoom = cols - 1
    const label = (text: string) => <Text bold>{text.padEnd(LABEL)}</Text>
    const extras = (parts: readonly Part[], key: string) =>
      parts.map((p, i) => (
        <Text key={`${key}-${i}`} color={p.color} dimColor={p.color === undefined}>{`${p.sep}${p.text}`}</Text>
      ))

    let contextRow
    if (c === null) {
      contextRow = (
        <Box flexDirection="row">
          {label(t().context)}
          <Text dimColor>{t().noData}</Text>
        </Box>
      )
    } else {
      const pct = ` ${pctLabel(c.percent)}`
      const amount = ` ${tokens(c.total)}/${tokens(c.max)}`
      const width = clamp(lineRoom - LABEL - pct.length - amount.length, 4, MAX_BAR)
      const base = LABEL + width + pct.length + amount.length
      const kept = dropUntil(ctxParts, k => base + partsLength(k) <= lineRoom)
      const { filled, track } = blocks(c.percent, width)
      const color = levelColor(c.percent)
      contextRow = (
        <Box flexDirection="row">
          {label(t().context)}
          <Text color={color}>{filled}</Text>
          <Text dimColor>{track}</Text>
          <Text color={color} bold>{pct}</Text>
          <Text dimColor>{amount}</Text>
          {base + partsLength(kept) <= lineRoom ? extras(kept, 'ctx') : null}
        </Box>
      )
    }

    const limitWidth = Math.max(6, Math.min(20, Math.floor((cols - LABEL) / 2) - 26))
    const GAP = 3
    const limitBase =
      LABEL +
      shown.reduce((a, l) => a + `${t().windows[l.kind]} `.length + limitWidth + ` ${pctLabel(l.percentUsed)}`.length + resetText(l.kind, l.resetsAt).length, 0) +
      GAP * Math.max(0, shown.length - 1)
    const limTagged = limParts.flatMap((ps, i) => ps.map(p => ({ ...p, item: i })))
    const limKept = dropUntil(limTagged, k => limitBase + partsLength(k) <= lineRoom) as typeof limTagged
    const limFits = limitBase + partsLength(limKept) <= lineRoom
    const limitRow =
      shown.length === 0 ? null : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
          {label(t().limits)}
          {shown.map((l, i) => {
            const { filled, track } = blocks(l.percentUsed, limitWidth)
            const color = levelColor(l.percentUsed)
            return (
              <Box key={`limit-${l.kind}`} flexDirection="row">
                <Text>{`${t().windows[l.kind]} `}</Text>
                <Text color={color}>{filled}</Text>
                <Text dimColor>{track}</Text>
                <Text color={color} bold>{` ${pctLabel(l.percentUsed)}`}</Text>
                <Text dimColor>{resetText(l.kind, l.resetsAt)}</Text>
                {limFits ? extras(limKept.filter(p => p.item === i), `lim${i}`) : null}
              </Box>
            )
          })}
        </Box>
      )

    let whereRow = null
    if (loc !== null) {
      // Keep at least ~24 characters for the path before dropping the location's other texts.
      const prefix = [loc.machine, loc.ssh ? 'SSH' : t().local].filter(Boolean).join(' · ').length + 3
      const kept = dropUntil(locParts, k => LABEL + prefix + 24 + partsLength(k) <= lineRoom)
      whereRow = (
        <Box flexDirection="row">
          {label(t().where)}
          <Text dimColor>{formatLocation(loc, t().local, home, lineRoom - LABEL - partsLength(kept))}</Text>
          {extras(kept, 'loc')}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {below}
        {contextRow}
        {limitRow}
        {whereRow}
      </Box>
    )
  })
}
