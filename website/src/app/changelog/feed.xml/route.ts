// RSS feed of the changelog, statically generated at build time from the same entries as the page.
import { SITE } from "@/lib/site"
import { ENTRIES } from "../entries"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export function GET() {
  const page = `${SITE.url}/changelog`
  const items = ENTRIES.map((e) => {
    const html = `<p>${esc(e.summary)}</p><ul>${e.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
    return `<item>
  <title>${esc(e.title)}</title>
  <link>${page}#${e.date}</link>
  <guid isPermaLink="false">ladder-changelog-${e.date}</guid>
  <pubDate>${new Date(`${e.date}T12:00:00Z`).toUTCString()}</pubDate>
  <description>${esc(html)}</description>
</item>`
  }).join("\n")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${esc(SITE.name)} changelog</title>
  <link>${page}</link>
  <description>What's new in ${esc(SITE.name)}.</description>
  <language>en</language>
  <atom:link href="${page}/feed.xml" rel="self" type="application/rss+xml" />
${items}
</channel>
</rss>`

  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } })
}
