import type { Metadata, Viewport } from "next"
import { JetBrains_Mono, Mona_Sans } from "next/font/google"
import { JsonLd } from "@/components/json-ld"
import { SiteHeader } from "@/components/site-header"
import { SITE } from "@/lib/site"
import "./globals.css"

const mona = Mona_Sans({
  variable: "--font-mona",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
})

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name}: every agent, every repo, one calm window`,
    template: `%s | ${SITE.name}`,
  },
  description: SITE.description,
  applicationName: SITE.name,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: SITE.locale,
    url: "/",
    title: `${SITE.name}: every agent, every repo, one calm window`,
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE.name}: every agent, every repo, one calm window`,
    description: SITE.description,
  },
}

export const viewport: Viewport = {
  themeColor: "#ffffff",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${mona.variable} ${jetbrains.variable} antialiased`}>
      <body className="min-h-dvh bg-page text-ink">
        <SiteHeader />
        {children}
        <JsonLd />
      </body>
    </html>
  )
}
