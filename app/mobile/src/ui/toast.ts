import { create } from 'zustand'

interface ToastState {
  message: string | null
  tone: 'info' | 'error'
  show: (message: string, tone?: 'info' | 'error') => void
  hide: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null

export const useToast = create<ToastState>((set) => ({
  message: null,
  tone: 'info',
  show: (message, tone = 'info') => {
    if (timer) clearTimeout(timer)
    set({ message, tone })
    timer = setTimeout(() => set({ message: null }), 4_000)
  },
  hide: () => set({ message: null })
}))
