import { Agents } from "@/components/sections/agents"
import { Closing } from "@/components/sections/closing"
import { Features } from "@/components/sections/features"
import { Mobile } from "@/components/sections/mobile"
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
      <Mobile />
      <Closing />
      <SiteFooter />
    </main>
  )
}
