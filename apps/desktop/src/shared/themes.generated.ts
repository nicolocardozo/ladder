// File generato da scripts/sync-brand.mjs a partire da brand/themes.json: non modificarlo a mano.

export type ThemeId = 'night-shift' | 'signal-red' | 'fieldnotes' | 'azure-ink' | 'kiln' | 'deep-current' | 'circuit' | 'copperwire' | 'blue-hour' | 'candor' | 'mono-light' | 'mono-dark'

export interface ThemeInfo {
  id: ThemeId
  name: string
  appearance: 'light' | 'dark'
  palette: { primary: string; secondary: string; highlight: string }
  tokens: Record<'background' | 'surface' | 'sidebar' | 'text' | 'textMuted' | 'border' | 'controlBorder' | 'accent' | 'onAccent' | 'selection' | 'onSelection' | 'focusRing' | 'codeBackground' | 'running' | 'waiting' | 'success' | 'error' | 'unread', string>
}

export const DEFAULT_THEME: ThemeId = 'circuit'

export const BRAND = {
  "name": "Ladder",
  "theme": "circuit",
  "primary": "#5525CF",
  "deepViolet": "#22123C",
  "citron": "#ECFC7F",
  "ivory": "#F7F4FF",
  "graphite": "#172122",
  "black": "#000000",
  "white": "#FFFFFF"
} as const

export const THEMES: ThemeInfo[] = [
  {
    "id": "night-shift",
    "name": "Night Shift",
    "appearance": "dark",
    "palette": {
      "primary": "#0D1623",
      "secondary": "#2C9EFE",
      "highlight": "#BCC2CC"
    },
    "tokens": {
      "background": "#101822",
      "surface": "#172230",
      "sidebar": "#0D1623",
      "text": "#EDF4FD",
      "textMuted": "#A0A7B0",
      "border": "#404A57",
      "controlBorder": "#646C77",
      "accent": "#2C9EFE",
      "onAccent": "#000000",
      "selection": "#13304D",
      "onSelection": "#EDF4FD",
      "focusRing": "#2C9EFE",
      "codeBackground": "#131C28",
      "running": "#2C9EFE",
      "waiting": "#FDBB69",
      "success": "#8CE9B7",
      "error": "#FDA4AE",
      "unread": "#2C9EFE"
    }
  },
  {
    "id": "signal-red",
    "name": "Signal Red",
    "appearance": "light",
    "palette": {
      "primary": "#491011",
      "secondary": "#E53F2A",
      "highlight": "#F7ECDA"
    },
    "tokens": {
      "background": "#FCF7EF",
      "surface": "#FFFFFF",
      "sidebar": "#F7ECDA",
      "text": "#321514",
      "textMuted": "#6F5C59",
      "border": "#DEDAD9",
      "controlBorder": "#8A8787",
      "accent": "#A62920",
      "onAccent": "#FFFFFF",
      "selection": "#EFD8C7",
      "onSelection": "#321514",
      "focusRing": "#A62920",
      "codeBackground": "#F8F5F5",
      "running": "#A62920",
      "waiting": "#8A4B08",
      "success": "#176443",
      "error": "#A52C40",
      "unread": "#A62920"
    }
  },
  {
    "id": "fieldnotes",
    "name": "Fieldnotes",
    "appearance": "light",
    "palette": {
      "primary": "#39411B",
      "secondary": "#D8E01A",
      "highlight": "#F4E8D0"
    },
    "tokens": {
      "background": "#FCF8ED",
      "surface": "#FFFDF8",
      "sidebar": "#F4E8D0",
      "text": "#292E1A",
      "textMuted": "#5F6153",
      "border": "#DDDCD4",
      "controlBorder": "#878681",
      "accent": "#556314",
      "onAccent": "#FFFFFF",
      "selection": "#E4DBBD",
      "onSelection": "#292E1A",
      "focusRing": "#556314",
      "codeBackground": "#F7F5EF",
      "running": "#556314",
      "waiting": "#8A4B08",
      "success": "#176443",
      "error": "#A52C40",
      "unread": "#556314"
    }
  },
  {
    "id": "azure-ink",
    "name": "Azure Ink",
    "appearance": "light",
    "palette": {
      "primary": "#000D8A",
      "secondary": "#9ACBFA",
      "highlight": "#D5E7FB"
    },
    "tokens": {
      "background": "#F2F7FE",
      "surface": "#FFFFFF",
      "sidebar": "#D5E7FB",
      "text": "#161C3D",
      "textMuted": "#565B70",
      "border": "#DADBE0",
      "controlBorder": "#818184",
      "accent": "#143BB0",
      "onAccent": "#FFFFFF",
      "selection": "#C2D6F4",
      "onSelection": "#161C3D",
      "focusRing": "#143BB0",
      "codeBackground": "#F5F5FA",
      "running": "#143BB0",
      "waiting": "#8A4B08",
      "success": "#176443",
      "error": "#A52C40",
      "unread": "#143BB0"
    }
  },
  {
    "id": "kiln",
    "name": "Kiln",
    "appearance": "light",
    "palette": {
      "primary": "#4F2921",
      "secondary": "#E1966A",
      "highlight": "#F4E7D5"
    },
    "tokens": {
      "background": "#FCF6ED",
      "surface": "#FFFDF8",
      "sidebar": "#F4E7D5",
      "text": "#382019",
      "textMuted": "#6D5D56",
      "border": "#DFDAD4",
      "controlBorder": "#888581",
      "accent": "#A34528",
      "onAccent": "#FFFFFF",
      "selection": "#ECD7C4",
      "onSelection": "#382019",
      "focusRing": "#A34528",
      "codeBackground": "#F8F5EF",
      "running": "#A34528",
      "waiting": "#8A4B08",
      "success": "#176443",
      "error": "#A52C40",
      "unread": "#A34528"
    }
  },
  {
    "id": "deep-current",
    "name": "Deep Current",
    "appearance": "dark",
    "palette": {
      "primary": "#0C2F32",
      "secondary": "#C2FDE7",
      "highlight": "#DFE9EA"
    },
    "tokens": {
      "background": "#102729",
      "surface": "#173437",
      "sidebar": "#0C2F32",
      "text": "#E6F6F2",
      "textMuted": "#ADBDBB",
      "border": "#3E595B",
      "controlBorder": "#677C7D",
      "accent": "#89E9C8",
      "onAccent": "#000000",
      "selection": "#24524E",
      "onSelection": "#E6F6F2",
      "focusRing": "#89E9C8",
      "codeBackground": "#132B2E",
      "running": "#89E9C8",
      "waiting": "#FDBB69",
      "success": "#8CE9B7",
      "error": "#FDA4AE",
      "unread": "#89E9C8"
    }
  },
  {
    "id": "circuit",
    "name": "Circuit",
    "appearance": "dark",
    "palette": {
      "primary": "#5525CF",
      "secondary": "#22123C",
      "highlight": "#ECFC7F"
    },
    "tokens": {
      "background": "#181424",
      "surface": "#211A30",
      "sidebar": "#1A1427",
      "text": "#F7F4FF",
      "textMuted": "#A9A6B2",
      "border": "#4A4357",
      "controlBorder": "#6C6777",
      "accent": "#AC97FF",
      "onAccent": "#000000",
      "selection": "#362D50",
      "onSelection": "#F7F4FF",
      "focusRing": "#AC97FF",
      "codeBackground": "#1B1628",
      "running": "#ECFC7F",
      "waiting": "#FDBB69",
      "success": "#8CE9B7",
      "error": "#FDA4AE",
      "unread": "#AC97FF"
    }
  },
  {
    "id": "copperwire",
    "name": "Copperwire",
    "appearance": "light",
    "palette": {
      "primary": "#442314",
      "secondary": "#C1FDFE",
      "highlight": "#F8884C"
    },
    "tokens": {
      "background": "#FAF3EB",
      "surface": "#FFFCF8",
      "sidebar": "#F2E6DA",
      "text": "#352318",
      "textMuted": "#695D54",
      "border": "#DFD9D4",
      "controlBorder": "#888481",
      "accent": "#216771",
      "onAccent": "#FFFFFF",
      "selection": "#DDD9D0",
      "onSelection": "#352318",
      "focusRing": "#216771",
      "codeBackground": "#F8F3EF",
      "running": "#216771",
      "waiting": "#8A4B08",
      "success": "#176443",
      "error": "#A52C40",
      "unread": "#216771"
    }
  },
  {
    "id": "blue-hour",
    "name": "Blue Hour",
    "appearance": "dark",
    "palette": {
      "primary": "#443F7C",
      "secondary": "#CEC7F8",
      "highlight": "#FD8783"
    },
    "tokens": {
      "background": "#22223A",
      "surface": "#2A2A49",
      "sidebar": "#242441",
      "text": "#F3F0FF",
      "textMuted": "#B3B2C2",
      "border": "#50506C",
      "controlBorder": "#75758B",
      "accent": "#CEC7F8",
      "onAccent": "#000000",
      "selection": "#444364",
      "onSelection": "#F3F0FF",
      "focusRing": "#CEC7F8",
      "codeBackground": "#23233D",
      "running": "#CEC7F8",
      "waiting": "#FD8783",
      "success": "#8CE9B7",
      "error": "#FDA4AE",
      "unread": "#CEC7F8"
    }
  },
  {
    "id": "candor",
    "name": "Candor",
    "appearance": "light",
    "palette": {
      "primary": "#165125",
      "secondary": "#D3E9F3",
      "highlight": "#FEC055"
    },
    "tokens": {
      "background": "#F5F8F5",
      "surface": "#FFFFFF",
      "sidebar": "#E7F0E7",
      "text": "#1B3021",
      "textMuted": "#59655C",
      "border": "#DBDEDB",
      "controlBorder": "#868786",
      "accent": "#196035",
      "onAccent": "#FFFFFF",
      "selection": "#D2E2D5",
      "onSelection": "#1B3021",
      "focusRing": "#196035",
      "codeBackground": "#F6F8F6",
      "running": "#196035",
      "waiting": "#8A4B08",
      "success": "#176443",
      "error": "#A52C40",
      "unread": "#196035"
    }
  },
  {
    "id": "mono-light",
    "name": "Mono Light",
    "appearance": "light",
    "palette": {
      "primary": "#000000",
      "secondary": "#FFFFFF",
      "highlight": "#D4D4D4"
    },
    "tokens": {
      "background": "#FFFFFF",
      "surface": "#FAFAFA",
      "sidebar": "#F1F1F1",
      "text": "#121212",
      "textMuted": "#606060",
      "border": "#D5D5D5",
      "controlBorder": "#8A8A8A",
      "accent": "#161616",
      "onAccent": "#FFFFFF",
      "selection": "#DBDBDB",
      "onSelection": "#121212",
      "focusRing": "#161616",
      "codeBackground": "#F0F0F0",
      "running": "#121212",
      "waiting": "#121212",
      "success": "#121212",
      "error": "#121212",
      "unread": "#121212"
    }
  },
  {
    "id": "mono-dark",
    "name": "Mono Dark",
    "appearance": "dark",
    "palette": {
      "primary": "#FFFFFF",
      "secondary": "#000000",
      "highlight": "#808080"
    },
    "tokens": {
      "background": "#0B0B0B",
      "surface": "#151515",
      "sidebar": "#080808",
      "text": "#F5F5F5",
      "textMuted": "#A3A3A3",
      "border": "#404040",
      "controlBorder": "#646464",
      "accent": "#F5F5F5",
      "onAccent": "#000000",
      "selection": "#353535",
      "onSelection": "#F5F5F5",
      "focusRing": "#F5F5F5",
      "codeBackground": "#111111",
      "running": "#F5F5F5",
      "waiting": "#F5F5F5",
      "success": "#F5F5F5",
      "error": "#F5F5F5",
      "unread": "#F5F5F5"
    }
  }
]

export function themeById(id: unknown): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
}
