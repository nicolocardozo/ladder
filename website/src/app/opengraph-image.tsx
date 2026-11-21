import { ImageResponse } from "next/og"
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from "@/components/brand/logo-paths"
import { SITE } from "@/lib/site"

export const alt = `${SITE.name}: ${SITE.tagline}`
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#181424",
          color: "#F7F4FF",
          padding: 80,
        }}
      >
        <svg width={267} height={60} viewBox={WORDMARK_VIEWBOX} fill="#F7F4FF">
          {WORDMARK_PATHS.map((p) => (
            <path key={p.transform} fillRule="evenodd" transform={p.transform} d={p.d} />
          ))}
        </svg>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 84, lineHeight: 1.05, letterSpacing: -2 }}>
          <span>Every agent, every repo,</span>
          <span style={{ color: "#AC97FF" }}>one calm window.</span>
        </div>
      </div>
    ),
    size,
  )
}
