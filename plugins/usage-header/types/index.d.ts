// Context window usage: tokens used, window size, percent (local estimate, no model call).
export type Context = { total: number; max: number; percent: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// Tool-hub request: the toggle button writes it, the mod picks it up in its state.set hook.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'usage-header': { context: Context | null; limits: Limit[]; isOn: boolean }
  }
}
