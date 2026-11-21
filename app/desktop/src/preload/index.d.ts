import type { LadderApi } from './index'

declare global {
  interface Window {
    /** Assente quando il renderer gira nel browser con `pnpm dev:web`. */
    ladder?: LadderApi
  }
}

export {}
