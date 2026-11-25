// Which DMG this Mac needs. Safari and Firefox write "Intel Mac OS X" in the user agent even on
// Apple Silicon Macs, so we look elsewhere: first Client Hints (Chrome, Edge, Arc), then the GPU via WebGL.
// When in doubt null: the link stays /download, which leads to the Apple Silicon DMG (most Macs today).
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
  // Safari masks the GPU ("Apple GPU"): only Apple GPUs have ASTC textures, not those of Intel Macs.
  if (gl.getExtension("WEBGL_compressed_texture_astc")) return "arm64"
  return renderer ? "x64" : null
}
