import type { LadderApi } from './index'

declare global {
  interface Window {
    /** Absent when the renderer runs in the browser with `pnpm dev:web`. */
    ladder?: LadderApi
  }
}

export {}
