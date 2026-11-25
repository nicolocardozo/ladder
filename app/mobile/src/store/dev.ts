// Development only: drives the screens for screenshots and tests (deep link ladder://dev?...), without touching the screen.
import { create } from 'zustand'

/** Development only: driver commands for the composer (text, images from file, cursor). */
export interface DevComposerCmd {
  text?: string
  /** Local image files to attach as if picked from the library. */
  images?: string[]
  /** Sends the message like the Send button. */
  send?: boolean
  /** Puts focus in the field (keyboard up). */
  focus?: boolean
  /** Starts dictation like a tap on the microphone. */
  dictate?: boolean
}

/** Development only: forced dictation state, to see its interface where there is no microphone (simulator). */
export type DevDictation = 'listening' | 'downloading' | 'denied' | 'not-installed' | 'unsupported' | null

export type DevSheet = 'request' | 'permission' | 'turn' | 'switch' | 'full' | null

interface DevState {
  sheet: DevSheet
  /** Development only: the request sheet opens with the text field open (rejection reason or "Other…"). */
  reasonField: boolean
  /** Development only: the Home search field takes focus. */
  focusSearch: boolean
  /** Development only: the open native sheet registers itself here so the driver can scroll it. */
  scrollSheet: ((y: number) => void) | null
  /** Development only: the message field of "New session" takes focus (keyboard up) without a tap. */
  focusNewSession: boolean
  /** Development only: initial state of the "New session" form (options open, choice open, send immediately). */
  newSession: { expand?: boolean; step?: string; send?: boolean; project?: string; agent?: string } | null
  setSheet: (s: DevSheet) => void
  /** The open composer (chat or new session) registers itself here for the driver's commands (development only). */
  composer: ((cmd: DevComposerCmd) => void) | null
  setComposer: (fn: ((cmd: DevComposerCmd) => void) | null) => void
  dictation: DevDictation
  /** Development only: variant of the Welcome screen (capsule or single row). */
  welcome: 'chips' | 'caption'
  /** The open chat registers itself here so the driver can scroll it (development only). */
  scrollChat: ((offset: number) => void) | null
  setScrollChat: (fn: ((offset: number) => void) | null) => void
}

export const useDev = create<DevState>((set) => ({ composer: null, setComposer: (composer) => set({ composer }), dictation: null, welcome: 'chips', focusNewSession: false, reasonField: false, focusSearch: false, scrollSheet: null, newSession: null, sheet: null, setSheet: (sheet) => set({ sheet }), scrollChat: null, setScrollChat: (scrollChat) => set({ scrollChat }) }))
