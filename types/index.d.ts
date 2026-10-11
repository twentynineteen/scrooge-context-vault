export type Fill = { percent: number; tokens: number | null; window: number }
export type Pixels = 'small' | 'big'

declare module 'claude-code' {
  interface PluginState {
    'scrooge-context-vault': { fill: Fill; pixels: Pixels }
  }
}
