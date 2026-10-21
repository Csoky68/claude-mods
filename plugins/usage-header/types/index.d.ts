// Context window usage: tokens used, window size, percent (local estimate, no model call).
export type Context = { total: number; max: number; percent: number }
// Git state of the project root: current branch and the number of uncommitted entries.
export type Git = { branch: string; dirty: number }
// Where the session runs: display machine name, SSH or local, project path (full, shortened when drawn).
export type Location = { machine: string; ssh: boolean; path: string; git?: Git | null }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
// One reading of a rate-limit window: when (ms) and how full (percent).
export type Sample = { t: number; p: number }
// Per-kind reading history of the current reset window (cleared when resetsAt changes).
export type Burn = Record<string, { resetsAt?: string; samples: Sample[] }>
// Session start (ms) and the API-equivalent cost so far, when the host reports one.
export type SessionInfo = { startedAt: number; usd?: number }

// Tool-hub request: the toggle button writes it, the mod picks it up in its state.set hook.
export type HubRequest = { tool: string; on: boolean; n: number }

// A band button's open request: the mods / chat-inventory plugins hook state.set on it and open
// their own pane. `n` grows with every press, so pressing twice is two requests.
export type PaneName = 'mods' | 'inventory'
export type PaneRequest = { pane: PaneName; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'usage-header': {
      context: Context | null
      limits: Limit[]
      location: Location | null
      isOn: boolean
      burn: Burn
      turns: number[]
      compactAt: number | null
      session: SessionInfo | null
      /** True while the /mods switchboard turns the band off or hides it. */
      muted: boolean
      /** Last open request of the band's Mods / Inventory buttons; null before the first press. */
      openPane: PaneRequest | null
      /** The panes whose mod is installed and not switched off: their buttons are drawn. */
      panes: PaneName[]
    }
  }
}
