import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Context } from '../types'

const context = atom({ plugin: 'usage-header', key: 'context' } as const, null)
const limits = atom({ plugin: 'usage-header', key: 'limits' } as const, [])
// When off the band is empty; the tool-hub reads this too.
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
export function bandSvg(rows: SvgRow[], noData?: { label: string; text: string }): string {
  const height = Math.max(1, rows.length + (noData ? 1 : 0)) * ROW_H + PAD * 2
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${height}" width="${SVG_W}" height="${height}">${style}${parts.join('')}</svg>`
}

async function refresh($: EngineInterface): Promise<void> {
  // Local estimate without the per-category breakdown: no model call.
  const usage = await $.session.usage()
  await update($, context, prev => toContext(usage.context) ?? prev)
  await update($, limits, () => usage.rateLimits)
}

async function setOn($: EngineInterface, wanted: boolean): Promise<void> {
  await update($, isOn, () => wanted)
  await $.store.set('isOn', wanted)
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    lang = await pickLanguage($, options.language)
    const saved = (await $.store.get('isOn')) !== false
    await update($, isOn, () => saved)
    await $.command.register({ name: 'hasznalat', description: t().command, argumentHint: t().hint, immediate: true })
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
    if (moved && (await read($, isOn))) await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const below = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const c = await read($, context)
    const shown = (await read($, limits)).filter(l => l.kind in t().windows)
    const columns = e.props.bodyColumns || e.viewport?.columns || 0

    // Every remote surface table carries Svg; the terminal's does not (its resolve may still list the key).
    if (e.surface !== 'terminal' && 'Svg' in ui && ui.Svg) {
      const { Svg } = ui
      const rows: SvgRow[] = []
      if (c !== null) rows.push({ label: t().context, percent: c.percent, detail: `${tokens(c.total)} / ${tokens(c.max)}` })
      for (const l of shown) rows.push({ label: t().windows[l.kind]!, percent: l.percentUsed, detail: resetText(l.kind, l.resetsAt).trim() })
      const noData = c === null ? { label: t().context, text: t().noData } : undefined
      const alt = [
        ...(noData ? [`${noData.label}: ${noData.text}`] : []),
        ...rows.map(r => `${r.label} ${pctLabel(r.percent)} ${r.detail.replace(' / ', '/')}`.trim()),
      ].join(' · ')
      // Columns are character cells; at ~7 px each this keeps the drawing inside the slot.
      const width = columns > 0 ? Math.min(SVG_W, Math.floor(columns * 7)) : undefined
      return (
        <Box flexDirection="column">
          {below}
          <Svg key="usage-band" source={bandSvg(rows, noData)} alt={alt} width={width} />
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

    return (
      <Box flexDirection="column">
        {below}
        {contextRow}
        {limitRow}
      </Box>
    )
  })
}
