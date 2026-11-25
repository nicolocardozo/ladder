import { Bell, Gauge, KeyRound, Smartphone } from "lucide-react"
import { NeedsYou, RunningRing } from "@/components/ladder-ui/status"

const POINTS = [
  {
    icon: Bell,
    title: "Approve and answer",
    text: "Handle requests and questions from your phone. Notifications only say that a session is waiting, never project names or messages.",
  },
  {
    icon: Gauge,
    title: "Start and check",
    text: "Start a session and see your plan limits.",
  },
  {
    icon: Smartphone,
    title: "On your Home Screen",
    text: "On iPhone, a Live Activity and a widget show who is working and who is waiting.",
  },
  {
    icon: KeyRound,
    title: "Private by design",
    text: "Pair with a code your Mac shows, no account. End-to-end encrypted through a relay that forwards messages without being able to read them. Off until you turn it on.",
  },
] as const

// Telefono disegnato in HTML/CSS con una richiesta in attesa, dati di esempio generici
function PhoneViz() {
  return (
    <div aria-hidden className="relative h-[460px] overflow-hidden rounded-[18px] border border-hairline bg-frame sm:h-[520px]">
      <div
        className="absolute inset-0 opacity-80"
        style={{ backgroundImage: "radial-gradient(circle, var(--color-dot) 1px, transparent 1.5px)", backgroundSize: "18px 18px" }}
      />
      <div className="absolute top-8 bottom-[-1px] left-1/2 flex w-[min(260px,72%)] -translate-x-1/2 flex-col rounded-t-[34px] bg-c-bg p-2 text-[12.5px] leading-[1.4] text-c-text shadow-[0_0_0_1px_rgb(24_20_36/0.9),0_24px_50px_-16px_rgb(60_30_160/0.45)]">
        <div className="flex flex-1 flex-col overflow-hidden rounded-t-[27px] border border-c-line bg-c-sidebar">
          <div className="mx-auto mt-2 h-[18px] w-[72px] rounded-full bg-c-bg" />
          <div className="flex h-10 items-center px-4 font-medium">
            Waiting
            <span className="ml-auto text-[11.5px] font-normal text-c-muted">1 request</span>
          </div>
          <div className="flex flex-col gap-2 px-2.5">
            <div className="rounded-[10px] border border-c-waiting/45 bg-c-surface p-3">
              <div className="flex items-center gap-2">
                <NeedsYou />
                <span className="font-mono text-[11px] text-c-muted">api-server</span>
              </div>
              <p className="mt-1.5">Codex wants to run pnpm test</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <span className="rounded-lg bg-c-accent py-1.5 text-center font-medium text-c-bg">Approve</span>
                <span className="rounded-lg border border-c-border py-1.5 text-center text-c-muted">Deny</span>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-[10px] bg-c-surface px-3 py-2.5">
              <RunningRing />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono text-[11px] text-c-muted">web-app</span>
                <br />
                Claude Code is working
              </span>
            </div>
          </div>
        </div>
      </div>
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
