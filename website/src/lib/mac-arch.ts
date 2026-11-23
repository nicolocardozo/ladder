// Quale DMG serve a questo Mac. Safari e Firefox scrivono "Intel Mac OS X" nello user agent anche sui Mac
// Apple Silicon, quindi si guarda altrove: prima i Client Hints (Chrome, Edge, Arc), poi la GPU via WebGL.
// Nel dubbio null: il link resta /download, che porta al DMG Apple Silicon (la maggior parte dei Mac di oggi).
export type MacArch = "arm64" | "x64"

let cached: Promise<MacArch | null> | null = null

export function detectMacArch(): Promise<MacArch | null> {
  cached ??= detect().catch(() => null)
  return cached
}

async function detect(): Promise<MacArch | null> {
  if (!/Macintosh|Mac OS X/.test(navigator.userAgent) || navigator.maxTouchPoints > 1) return null

  const hints = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(keys: string[]): Promise<{ architecture?: string }> }
  }).userAgentData
  if (hints) {
    const { architecture } = await hints.getHighEntropyValues(["architecture"])
    if (architecture === "arm") return "arm64"
    if (architecture === "x86") return "x64"
  }

  const gl = document.createElement("canvas").getContext("webgl")
  if (!gl) return null
  const info = gl.getExtension("WEBGL_debug_renderer_info")
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ""
  if (/Apple M\d/.test(renderer)) return "arm64"
  if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return "x64"
  // Safari maschera la GPU ("Apple GPU"): le texture ASTC le hanno solo le GPU Apple, non quelle dei Mac Intel.
  if (gl.getExtension("WEBGL_compressed_texture_astc")) return "arm64"
  return renderer ? "x64" : null
}
