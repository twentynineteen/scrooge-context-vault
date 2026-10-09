export type Fill = { percent: number; tokens: number | null; window: number }
export type Pixels = 'small' | 'big'

declare module 'claude-code' {
  interface PluginState {
    'money-bin': { fill: Fill; pixels: Pixels }
  }
}
