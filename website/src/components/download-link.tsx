"use client"

// Download link that points to the right DMG for this Mac (see lib/mac-arch.ts).
// Without JavaScript, or until it has figured it out, it stays /download (Apple Silicon).
import { useEffect, useState, type ComponentProps } from "react"
import { detectMacArch } from "@/lib/mac-arch"
import { DOWNLOADS } from "@/lib/site"

export function useDownloadHref(): string {
  const [href, setHref] = useState<string>(DOWNLOADS.auto)
  useEffect(() => {
    let live = true
    detectMacArch().then((arch) => {
      if (live && arch) setHref(DOWNLOADS[arch])
    })
    return () => {
      live = false
    }
  }, [])
  return href
}

export function DownloadLink(props: Omit<ComponentProps<"a">, "href">) {
  return <a {...props} href={useDownloadHref()} />
}
