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
const MAX_BAR = 40
const MAX_LIMIT_BAR = 16

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

// Thin bar split into filled cells, an optional half-cell end and the remaining track.
export function bar(percent: number, width: number): { filled: string; track: string } {
  const exact = (Math.min(100, Math.max(0, percent)) / 100) * width
  let full = Math.floor(exact)
  let half = exact - full >= 0.5
  if (full >= width) {
    full = width
    half = false
  }
  const filled = '━'.repeat(full) + (half ? '╸' : '')
  return { filled, track: '━'.repeat(width - full - (half ? 1 : 0)) }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

const levelColor = (percent: number) => (percent >= WARN_AT ? 'red' : percent >= CAUTION_AT ? 'yellow' : 'green')

const pctText = (percent: number) => `  ${Math.round(percent)}%${percent >= WARN_AT ? ' ⚠' : ''}`

function resetText(kind: string, resetsAt?: string): string {
  if (resetsAt === undefined) return ''
  const at = new Date(resetsAt)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return kind === 'five_hour' ? ` → ${hhmm}` : ` → ${t().days[at.getDay()]} ${hhmm}`
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
    const { Box, Text } = $.ui.resolve(e)
    const c = await read($, context)
    const shown = (await read($, limits)).filter(l => l.kind in t().windows)
    const columns = e.props.bodyColumns || e.viewport?.columns || 80
    // One spare column so the row never touches the edge and wraps.
    const room = columns - LABEL - 1

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
      const pct = pctText(c.percent)
      const amount = `  ${tokens(c.total)} / ${tokens(c.max)}`
      const { filled, track } = bar(c.percent, clamp(room - pct.length - amount.length, 4, MAX_BAR))
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

    // Limit bars share the row: subtract each item's name, percent and reset text plus the gaps.
    const GAP = 4
    const items = shown.map(l => ({
      l,
      name: `${t().windows[l.kind]} `,
      pct: pctText(l.percentUsed),
      reset: resetText(l.kind, l.resetsAt),
    }))
    const fixed = items.reduce((a, i) => a + i.name.length + i.pct.length + i.reset.length, 0) + GAP * Math.max(0, items.length - 1)
    const limitWidth = items.length === 0 ? 0 : clamp(Math.floor((room - fixed) / items.length), 4, MAX_LIMIT_BAR)
    const limitRow =
      items.length === 0 ? null : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
          {label(t().limits)}
          {items.map(({ l, name, pct, reset }) => {
            const { filled, track } = bar(l.percentUsed, limitWidth)
            const color = levelColor(l.percentUsed)
            return (
              <Box key={`limit-${l.kind}`} flexDirection="row">
                <Text>{name}</Text>
                <Text color={color}>{filled}</Text>
                <Text dimColor>{track}</Text>
                <Text color={color} bold>{pct}</Text>
                <Text dimColor>{reset}</Text>
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
