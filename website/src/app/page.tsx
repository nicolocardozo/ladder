import { Agents } from "@/components/sections/agents"
import { Closing } from "@/components/sections/closing"
import { Features } from "@/components/sections/features"
import { Hero } from "@/components/sections/hero"
import { Statement } from "@/components/sections/statement"
import { SiteFooter } from "@/components/site-footer"

export default function Home() {
  return (
    <main>
      <Hero />
      <Statement />
      <Features />
      <Agents />
      <Closing />
      <SiteFooter />
    </main>
  )
}
