import { Bell, Gauge, KeyRound, Smartphone } from "lucide-react"
import { PhoneDemo } from "./phone"

const POINTS = [
  {
    icon: Bell,
    title: "Approve and answer",
    text: "Approve requests and answer questions from your phone. Notifications never show project names or messages.",
  },
  {
    icon: Gauge,
    title: "Start and check",
    text: "Start a session in any project, follow it as it works and see how much of your plan limits is left.",
  },
  {
    icon: Smartphone,
    title: "On your Home Screen",
    text: "On iPhone, a Live Activity and a widget show who is working and who is waiting, without opening the app.",
  },
  {
    icon: KeyRound,
    title: "Private by design",
    text: "Pair with a code from your Mac, no account. End-to-end encrypted, and off until you turn it on.",
  },
] as const

// The phone app in a CSS iPhone, on the same dotted frame as the feature cards
function PhoneViz() {
  return (
    <div className="relative flex items-center justify-center overflow-hidden rounded-[18px] border border-hairline bg-frame py-10 sm:py-12">
      <div
        aria-hidden
        className="absolute inset-0 opacity-80"
        style={{ backgroundImage: "radial-gradient(circle, var(--color-dot) 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}
      />
      <PhoneDemo />
    </div>
  )
}

export function Mobile() {
  return (
    <section
      id="mobile"
      className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-24 sm:px-8 sm:py-32 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-16"
    >
      <div>
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-iris">Coming soon</p>
        <h2 className="mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Step away. Your agents can still reach you.
        </h2>
        <p className="mt-4 text-base text-muted-ink sm:text-lg">
          A Ladder app for iPhone and Android, paired with your Mac. A remote control for the Ladder
          you already run, not a second workspace.
        </p>
        <ul className="mt-8 grid gap-2 min-[560px]:grid-cols-2">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-xl border border-hairline bg-surface p-4">
              <Icon aria-hidden className="size-4 text-iris" />
              <h3 className="mt-3 text-[15px] font-medium text-ink">{title}</h3>
              <p className="mt-1 text-[14px] leading-[1.5] text-muted-ink">{text}</p>
            </li>
          ))}
        </ul>
      </div>
      <PhoneViz />
    </section>
  )
}
