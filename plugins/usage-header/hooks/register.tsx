import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Context, Limit, Location } from '../types'

const context = atom({ plugin: 'usage-header', key: 'context' } as const, null)
const limits = atom({ plugin: 'usage-header', key: 'limits' } as const, [])
// When off the band is empty; the tool-hub reads this too.
const location = atom({ plugin: 'usage-header', key: 'location' } as const, null)
const isOn = atom({ plugin: 'usage-header', key: 'isOn' } as const, true)

const WARN_AT = 90
const CAUTION_AT = 70
const LABEL = 11
const MAX_BAR = 60

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
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return kind === 'five_hour' ? ` → ${hhmm}` : ` → ${t().days[at.getDay()]} ${hhmm}`
}

export type SvgRow = { label: string; percent: number; detail: string }

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Remote surfaces (desktop, mobile, vscode): the whole band as one SVG, so a proportional font
// cannot misalign the bars. Dark theme by default, light overrides via prefers-color-scheme.
export const SVG_W = 560
const ROW_H = 22
const PAD = 4
const BAR_X = 76
const BAR_W = 300
const BAR_H = 8
type TextRow = { label: string; text: string }
export function bandSvg(rows: SvgRow[], noData?: TextRow, info?: TextRow): string {
  const count = rows.length + (noData ? 1 : 0) + (info ? 1 : 0)
  const height = Math.max(1, count) * ROW_H + PAD * 2
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
    parts.push(`<text class="m" x="${BAR_X + BAR_W + 66}" y="${y}" dominant-baseline="central">${esc(row.detail)}</text>`)
  })
  if (info) {
    const y = PAD + (count - 1) * ROW_H + ROW_H / 2
    parts.push(`<text class="t" x="0" y="${y}" dominant-baseline="central" font-weight="600">${esc(info.label)}</text>`)
    parts.push(`<text class="m" x="${BAR_X}" y="${y}" dominant-baseline="central">${esc(info.text)}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${height}" width="${SVG_W}" height="${height}">${style}${parts.join('')}</svg>`
}

let lastRaw = ''
let home = ''

async function refresh($: EngineInterface): Promise<void> {
  // Local estimate without the per-category breakdown: no model call.
  const usage = await $.session.usage()
  await update($, context, prev => toContext(usage.context) ?? prev)
  const raw = JSON.stringify(usage.rateLimits)
  if (raw !== lastRaw) {
    lastRaw = raw
    $.ui.log(raw, { to: 'debug' })
  }
  await update($, limits, prev => mergeLimits(prev, usage.rateLimits, Date.now()))
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

// Machine and mode once per session; the path again at every turn end (no model call).
async function refreshLocation($: EngineInterface, machines: Record<string, string> | null): Promise<void> {
  const path = await currentPath($).catch(() => '')
  if (machines === null) {
    await update($, location, prev => (prev === null ? null : { ...prev, path }))
    return
  }
  home = (await $.env.get('HOME')) ?? ''
  const ssh = Boolean((await $.env.get('SSH_CONNECTION'))?.trim())
  const machine = machineName(await hostName($), machines)
  await update($, location, () => ({ machine, ssh, path }))
}

async function setOn($: EngineInterface, wanted: boolean): Promise<void> {
  await update($, isOn, () => wanted)
  await $.store.set('isOn', wanted)
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language
  const machines = parseMachines(typeof options.machineNames === 'string' ? options.machineNames : DEFAULT_MACHINES)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    lang = await pickLanguage($, options.language)
    const saved = (await $.store.get('isOn')) !== false
    await update($, isOn, () => saved)
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

  // At turn end and when limits move: refresh from the local estimate, no API call.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const moved = e.changed.includes('context') || e.changed.includes('rateLimits')
    if (await read($, isOn)) {
      await refreshLocation($, null).catch(() => undefined)
      if (moved) await refresh($)
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
    const columns = e.props.bodyColumns || e.viewport?.columns || 0

    // Every remote surface table carries Svg; the terminal's does not (its resolve may still list the key).
    if (e.surface !== 'terminal' && 'Svg' in ui && ui.Svg) {
      const { Svg } = ui
      const rows: SvgRow[] = []
      if (c !== null) rows.push({ label: t().context, percent: c.percent, detail: `${tokens(c.total)} / ${tokens(c.max)}` })
      for (const l of shown) rows.push({ label: t().windows[l.kind]!, percent: l.percentUsed, detail: resetText(l.kind, l.resetsAt).trim() })
      const noData = c === null ? { label: t().context, text: t().noData } : undefined
      // ~6.5 px per character of the 12.5 px font in the space right of the label column.
      const info = loc === null ? undefined : { label: t().where, text: formatLocation(loc, t().local, home, Math.floor((SVG_W - BAR_X) / 6.5)) }
      const alt = [
        ...(noData ? [`${noData.label}: ${noData.text}`] : []),
        ...rows.map(r => `${r.label} ${pctLabel(r.percent)} ${r.detail.replace(' / ', '/')}`.trim()),
        ...(info ? [`${info.label}: ${info.text}`] : []),
      ].join(' · ')
      // Columns are character cells; at ~7 px each this keeps the drawing inside the slot.
      const width = columns > 0 ? Math.min(SVG_W, Math.floor(columns * 7)) : undefined
      return (
        <Box flexDirection="column">
          {below}
          <Svg key="usage-band" source={bandSvg(rows, noData, info)} alt={alt} width={width} />
        </Box>
      )
    }

    const cols = columns || 80
    const label = (text: string) => <Text bold>{text.padEnd(LABEL)}</Text>

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
      // One spare column so the row never reaches the edge and wraps.
      const width = clamp(cols - LABEL - 1 - pct.length - amount.length, 4, MAX_BAR)
      const { filled, track } = blocks(c.percent, width)
      const color = levelColor(c.percent)
      contextRow = (
        <Box flexDirection="row">
          {label(t().context)}
          <Text color={color}>{filled}</Text>
          <Text dimColor>{track}</Text>
          <Text color={color} bold>{pct}</Text>
          <Text dimColor>{amount}</Text>
        </Box>
      )
    }

    const limitWidth = Math.max(6, Math.min(20, Math.floor((cols - LABEL) / 2) - 26))
    const limitRow =
      shown.length === 0 ? null : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {label(t().limits)}
          {shown.map(l => {
            const { filled, track } = blocks(l.percentUsed, limitWidth)
            const color = levelColor(l.percentUsed)
            return (
              <Box key={`limit-${l.kind}`} flexDirection="row">
                <Text>{`${t().windows[l.kind]} `}</Text>
                <Text color={color}>{filled}</Text>
                <Text dimColor>{track}</Text>
                <Text color={color} bold>{` ${pctLabel(l.percentUsed)}`}</Text>
                <Text dimColor>{resetText(l.kind, l.resetsAt)}</Text>
              </Box>
            )
          })}
        </Box>
      )

    const whereRow =
      loc === null ? null : (
        <Box flexDirection="row">
          {label(t().where)}
          <Text dimColor>{formatLocation(loc, t().local, home, cols - LABEL - 1)}</Text>
        </Box>
      )

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
