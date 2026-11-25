import { FibersLazy } from "./fibers-lazy"
import { StatementText } from "./statement-text"

// "Problem" section: a sentence that lights up on scroll, fibers behind (z axis).
export function Statement() {
  return (
    <section id="statement" aria-labelledby="statement-title" className="relative isolate flex min-h-[100svh] items-center overflow-hidden bg-page py-24">
      <FibersLazy />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 sm:px-8">
        {/* Radial white gradient behind the text, for legibility */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-[10%] -inset-y-16 -z-10"
          style={{ background: "radial-gradient(ellipse 55% 60% at 50% 50%, color-mix(in srgb, var(--color-page) 92%, transparent), transparent 100%)" }}
        />
        <StatementText />
      </div>
    </section>
  )
}
