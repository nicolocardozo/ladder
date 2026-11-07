import type { BlueApi } from './index'

declare global {
  interface Window {
    /** Assente quando il renderer gira nel browser con `pnpm dev:web`. */
    blue?: BlueApi
  }
}

export {}
