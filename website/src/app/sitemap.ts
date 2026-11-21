import type { MetadataRoute } from "next"
import { PAGES, SITE } from "@/lib/site"

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({
    url: new URL(p.path, SITE.url).toString(),
    changeFrequency: p.path === "/changelog" ? "weekly" : "monthly",
    priority: p.priority,
  }))
}
