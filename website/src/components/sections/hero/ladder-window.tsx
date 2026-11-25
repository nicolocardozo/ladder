"use client"

// Ladder window (Circuit theme) with the animated story: a session at work, an approval
// request from another project, ⏎, work done, new request. It starts already full.
import {
  ArrowUp,
  AtSign,
  Check,
  CircleAlert,
  Columns2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Globe,
  Inbox,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { AgentIcon } from "@/components/brand/agent-icon"
import { Logo } from "@/components/brand/logo"
import { DoneCheck, RunningRing, SessionGlyph, type SessionState } from "@/components/ladder-ui/status"
import "./hero.css"

type Item =
  | { id: number; t: "u"; x: string }
  | { id: number; t: "x"; x: string }
  | { id: number; t: "tool"; k: "Read" | "Edit" | "Ran" | "Grep"; x: string; p?: string; m?: string; ok?: boolean }
  | { id: number; t: "sub"; x: string; done?: boolean }
  | { id: number; t: "code"; lines: [" " | "+" | "-", string][] }

type Scenario = {
  title: string
  prompt: string
  intro: string
  reads: [string, string]
  edit: { file: string; add: string; del: string }
  outro: string
}

const SCENARIOS: Scenario[] = [
  {
    title: "Restore tabs after relaunch",
    prompt: "Reopen my tabs and scroll position after Ladder restarts",
    intro: "I’ll check how tabs are saved on quit and read back on launch.",
    reads: ["src/host/sessions.ts", "renderer/store/tabs.ts"],
    edit: { file: "renderer/store/tabs.ts", add: "+42", del: "−7" },
    outro: "Tabs now reopen per project, and the scroll position comes back once the transcript is measured.",
  },
  {
    title: "Palette keyboard shortcuts",
    prompt: "Show the keyboard shortcut next to each command in the palette",
    intro: "I’ll look at how commands are registered, then render their bindings.",
    reads: ["renderer/palette/commands.ts", "renderer/palette/row.tsx"],
    edit: { file: "renderer/palette/row.tsx", add: "+19", del: "−3" },
    outro: "Each row now shows its shortcut on the right, and unbound commands stay clean.",
  },
]

type Demo = {
  view: "tabs" | "request"
  chat: Item[]
  reqDone: boolean
  subsRunning: number
  subs: number
  ls: { title: string; st: SessionState; age: string }
  billing: SessionState
  web: SessionState
  note: boolean
  pulse: boolean
  typed: string | null
  sendGo: boolean
  use: number
  press: boolean
}

let uid = 0
const mk = {
  u: (x: string): Item => ({ id: ++uid, t: "u", x }),
  x: (x: string): Item => ({ id: ++uid, t: "x", x }),
  tool: (k: "Read" | "Edit" | "Ran" | "Grep", x: string, extra: { p?: string; m?: string; ok?: boolean } = {}): Item => ({ id: ++uid, t: "tool", k, x, ...extra }),
  code: (lines: [" " | "+" | "-", string][]): Item => ({ id: ++uid, t: "code", lines }),
  sub: (x: string, done = false): Item => ({ id: ++uid, t: "sub", x, done }),
}

// Conversation already going for a while: previous exchange, current request, reads, diff, subagents
function history(): Item[] {
  return [
    mk.u("Where do we persist the window state?"),
    mk.x("In state.json under Application Support, written on quit by host/window-state.ts and read back on launch."),
  ]
}
function current(done: boolean): Item[] {
  const s = SCENARIOS[0]
  return [
    mk.u(s.prompt),
    mk.x(s.intro),
    mk.tool("Read", s.reads[0]),
    mk.tool("Read", s.reads[1]),
    mk.tool("Read", "renderer/store/projects.ts"),
    mk.tool("Grep", "saveTabState", { p: "6 matches", m: "" }),
    mk.tool("Edit", "host/window-state.ts", { p: "+12", m: "−2" }),
    mk.code([
      [" ", "export function readWindowState(): WindowState {"],
      ["-", "  return JSON.parse(fs.readFileSync(path, \"utf8\"))"],
      ["+", "  const raw = tryRead(path)"],
      ["+", "  return raw ? migrate(JSON.parse(raw)) : defaultState()"],
      [" ", "}"],
    ]),
    mk.sub(done ? "2 agents finished · reports read" : "Started 2 agents · map the host · check the renderer", done),
  ]
}

function initial(): Demo {
  const s = SCENARIOS[0]
  return {
    view: "tabs",
    chat: [...history(), ...current(false)],
    reqDone: false,
    subsRunning: 2,
    subs: 2,
    ls: { title: s.title, st: "running", age: "now" },
    billing: "running",
    web: "running",
    note: false,
    pulse: false,
    typed: null,
    sendGo: false,
    use: 13,
    press: false,
  }
}

// Static state for prefers-reduced-motion: everything has already happened, one request still waiting
function finalState(): Demo {
  const s = SCENARIOS[0]
  return {
    ...initial(),
    chat: [
      ...history(),
      ...current(true),
      mk.tool("Edit", s.edit.file, { p: s.edit.add, m: s.edit.del }),
      mk.tool("Ran", "pnpm typecheck", { ok: true }),
      mk.x(s.outro),
    ],
    subsRunning: 0,
    ls: { title: s.title, st: null, age: "1 min" },
    billing: "waiting",
    web: "unread",
    use: 16,
  }
}

const AGENT_NAME = { claude: "Claude", codex: "Codex" } as const

const subscribeRM = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}
const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeRM,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  )

function Am({ agent, className = "size-3.5" }: { agent: string; className?: string }) {
  return <AgentIcon agent={agent} className={className} />
}

function ItemView({ it }: { it: Item }): ReactNode {
  if (it.t === "u") return <div className="lw-ub lw-ani">{it.x}</div>
  if (it.t === "x") return <div className="lw-tx lw-ani">{it.x}</div>
  if (it.t === "sub")
    return (
      <div className="lw-subl lw-ani">
        {it.done ? <DoneCheck /> : <RunningRing />}
        {it.x}
      </div>
    )
  if (it.t === "code")
    return (
      <div className="lw-code lw-ani">
        {it.lines.map(([k, l], i) => (
          <div key={i} className={k === "+" ? "add" : k === "-" ? "del" : ""}>
            <b>{k === " " ? "" : k}</b>
            {l}
          </div>
        ))}
      </div>
    )
  const Icon = it.k === "Edit" ? Pencil : it.k === "Ran" ? Terminal : it.k === "Grep" ? Search : FileText
  return (
    <div className="lw-tool lw-ani">
      <Icon className="i" aria-hidden />
      <b>{it.k}</b> {it.x}
      {it.p ? (
        <>
          <span className="p">{it.p}</span> <span className="m">{it.m}</span>
        </>
      ) : null}
      {it.ok ? <Check className="i p" aria-hidden /> : null}
    </div>
  )
}

export default function LadderWindow() {
  const reduced = useReducedMotion()
  const [live, setLive] = useState<Demo>(initial)
  const s = reduced ? finalState() : live
  const patch = (p: Partial<Demo> | ((d: Demo) => Partial<Demo>)) =>
    setLive((d) => ({ ...d, ...(typeof p === "function" ? p(d) : p) }))
  const root = useRef<HTMLDivElement>(null)
  const visible = useRef(false)
  const approveRef = useRef<(() => void) | null>(null)
  const touched = useRef(false)
  const billingWaiting = useRef(false)
  billingWaiting.current = live.billing === "waiting"

  // Approval: click, ⏎ or automatic after a few seconds
  const approve = () => {
    approveRef.current?.()
    approveRef.current = null
  }
  const openRequest = () => {
    if (!billingWaiting.current) return
    touched.current = true
    patch({ view: "request" })
  }

  useEffect(() => {
    const el = root.current
    if (!el || reduced) return
    let alive = true
    const CANCEL = new Error("cancel")
    const wait = async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms))
      if (!alive) throw CANCEL
    }
    const untilVisible = async () => {
      while (!visible.current) await wait(250)
    }
    const io = new IntersectionObserver(([e]) => (visible.current = e.isIntersecting), { threshold: 0.5 })
    io.observe(el)

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "Enter" || !visible.current || !billingWaiting.current || t?.closest("a,button,input,textarea")) return
      e.preventDefault()
      touched.current = true
      patch({ view: "request" })
      setTimeout(approve, 250)
    }
    document.addEventListener("keydown", onKey)

    const push = (it: Item) => patch((d) => ({ chat: [...d.chat, it] }))
    const bump = (n: number) => patch((d) => ({ use: Math.min(96, d.use + n) }))

    async function typeIn(text: string) {
      patch({ typed: "", sendGo: false })
      for (let i = 1; i <= text.length; i++) {
        patch({ typed: text.slice(0, i) })
        await wait(24 + Math.random() * 28)
      }
      patch({ sendGo: true })
      await wait(420)
      patch({ typed: null, sendGo: false })
    }

    async function run() {
      let n = 0
      try {
        for (;;) {
          const sc = SCENARIOS[n % SCENARIOS.length]
          if (n > 0) {
            // New request in the composer; the chat is never empty
            await typeIn(sc.prompt)
            patch((d) => ({
              view: "tabs",
              chat: [...d.chat.slice(-12), mk.u(sc.prompt)],
              reqDone: false,
              subs: 0,
              subsRunning: 0,
              billing: "running",
              web: "running",
              ls: { title: sc.title, st: "running", age: "now" },
              use: d.use > 80 ? 10 : d.use,
            }))
            await wait(800)
            push(mk.x(sc.intro))
            await wait(700)
            push(mk.tool("Read", sc.reads[0]))
            bump(1)
            await wait(600)
            push(mk.tool("Read", sc.reads[1]))
            await wait(700)
            patch({ subs: 2, subsRunning: 2 })
            push(mk.sub("Started 2 agents · map the host · check the renderer"))
          }
          await untilVisible()
          await wait(1300)
          touched.current = false
          patch({ billing: "waiting", note: true, pulse: true })
          await new Promise<void>((res) => {
            approveRef.current = res
            setTimeout(() => {
              if (approveRef.current && !touched.current) patch({ view: "request" })
            }, 2800)
            setTimeout(() => {
              if (approveRef.current && !touched.current) {
                patch({ press: true })
                setTimeout(approve, 220)
              }
            }, 5600)
          })
          if (!alive) throw CANCEL
          const wasRequest = await new Promise<boolean>((r) => {
            patch((d) => {
              r(d.view === "request")
              return { note: false, pulse: false, reqDone: true, billing: "running", press: false }
            })
          })
          await wait(wasRequest ? 900 : 0)
          patch({ view: "tabs", reqDone: false })
          await wait(700)
          patch({ subsRunning: 1 })
          await wait(700)
          push(mk.tool("Edit", sc.edit.file, { p: sc.edit.add, m: sc.edit.del }))
          bump(2)
          await wait(800)
          patch((d) => ({ subsRunning: 0, chat: d.chat.map((c) => (c.t === "sub" ? { ...c, done: true, x: "2 agents finished · reports read" } : c)) }))
          await wait(700)
          patch({ web: "unread" })
          await wait(600)
          push(mk.tool("Ran", "pnpm typecheck", { ok: true }))
          bump(1)
          await wait(900)
          push(mk.x(sc.outro))
          patch((d) => ({ ls: { ...d.ls, st: null, age: "1 min" } }))
          await wait(1400)
          patch({ billing: "unread" })
          await wait(4500)
          n++
        }
      } catch (e) {
        if (e !== CANCEL) throw e
      }
    }
    run()
    return () => {
      alive = false
      io.disconnect()
      document.removeEventListener("keydown", onKey)
    }
  }, [reduced])

  const waitingCount = (s.billing === "waiting" ? 1 : 0) + (s.web === "waiting" ? 1 : 0)
  const isReq = s.view === "request"
  const sessions = [
    { title: s.ls.title, agent: "claude" as string, model: "Opus 5.5", age: s.ls.age, st: s.ls.st, subs: s.subs },
    { title: "Diff viewer word wrap", agent: "codex" as const, model: "GPT-5.5", age: "12 min", st: "unread" as SessionState, subs: 0 },
    { title: "Command palette initials", agent: "claude" as const, model: "Sonnet 5.5", age: "1 h", st: null as SessionState, subs: 1 },
    { title: "Fix flaky worktree cleanup", agent: "codex" as const, model: "GPT-5.5", age: "2 h", st: "running" as SessionState, subs: 3 },
    { title: "Theme preview in settings", agent: "gemini" as const, model: "ACP", age: "yesterday", st: null as SessionState, subs: 0 },
  ]
  const projects = [
    { name: "billing-api", st: s.billing },
    { name: "marketing-web", st: s.web },
    { name: "infra", st: null as SessionState },
    { name: "design-system", st: "running" as SessionState },
    { name: "mobile-app", st: "unread" as SessionState },
  ]

  return (
    <div ref={root} className="lw" role="group" aria-label="Ladder, live demo">
      <button type="button" className={`lw-note${s.note ? " on" : ""}`} onClick={openRequest} tabIndex={s.note ? 0 : -1} aria-hidden={!s.note}>
        <span className="lw-appi">
          <Logo variant="mark" decorative className="h-4 w-auto" />
        </span>
        <span>
          <small>now</small>
          <b>billing-api needs you</b>
          <br />
          Codex wants to run <code>pnpm test</code>
        </span>
      </button>
      <div className="lw-body">
        <aside className="lw-sb" aria-label="Sessions">
          <div className="lw-sbtop">
            <div className="lw-tl" aria-hidden>
              <i />
              <i />
              <i />
            </div>
            <span className="lw-ib">
              <PanelLeft className="i" aria-hidden />
            </span>
            <span className="lw-ib">
              <Search className="i" aria-hidden />
            </span>
          </div>
          <div className="lw-nav">
            <div className="lw-it">
              <SquarePen className="i" aria-hidden /> New chat
              <span className="lw-k">
                <span>⌘</span>
                <span>N</span>
              </span>
            </div>
            <button type="button" className={`lw-it${isReq ? " sel" : ""}${s.pulse ? " pulse" : ""}`} onClick={openRequest}>
              <Inbox className="i" aria-hidden /> Waiting
              <span className={`lw-wc${waitingCount ? " on" : ""}`}>
                <CircleAlert className="i" aria-hidden />
                {waitingCount || 1}
              </span>
            </button>
          </div>
          <div className="lw-sec">
            Projects
            <FolderPlus className="i" aria-hidden />
          </div>
          <div className="lw-projs">
            {projects.map((p) => (
              <div className="lw-pj" key={p.name}>
                <Folder className="i" aria-hidden />
                <span>{p.name}</span>
                <span className="lw-bd">
                  {p.st === "waiting" ? (
                    <span className="lw-wc on">
                      <CircleAlert className="i" aria-hidden />1
                    </span>
                  ) : (
                    <SessionGlyph state={p.st} />
                  )}
                </span>
              </div>
            ))}
            <div className="lw-pj open">
              <FolderOpen className="i" aria-hidden />
              <span>ladder</span>
            </div>
            {sessions.map((x, i) => (
              <div className={`lw-ss${!isReq && i === 0 ? " sel" : ""}`} key={x.title}>
                <div className="lw-r1">
                  <span className="lw-tt">{x.title}</span>
                  <SessionGlyph state={x.st} />
                  <span className="lw-ag">{x.age}</span>
                </div>
                <div className="lw-r2">
                  <Am agent={x.agent} className="size-3" />
                  {x.model}
                  {x.subs ? ` · ${x.subs} agent${x.subs > 1 ? "s" : ""}` : ""}
                </div>
              </div>
            ))}
          </div>
          <div className="lw-all">
            All sessions <span>· 14</span>
          </div>
          <div className="lw-sfoot">
            <span className="lw-av" aria-hidden>
              AL
            </span>
            <span className="n">
              Ada Lovelace
              <span className="lw-svc" role="img" aria-label="Claude and ChatGPT subscriptions linked">
                <Am agent="claude" className="size-3" />
                <Am agent="codex" className="size-3" />
              </span>
            </span>
            <Settings className="i lw-gear" aria-hidden />
          </div>
        </aside>

        <div className="lw-mn">
          <div className="lw-tabs">
            <span className="lw-crumb">
              <Folder className="i" aria-hidden />
              {isReq ? "billing-api" : "ladder"} <span>/ main</span>
            </span>
            {isReq ? (
              <span className="lw-tab act">
                <Am agent="codex" className="size-3" />
                <span className="lbl">Rate limit webhooks</span>
                <X className="i lw-x" aria-hidden />
              </span>
            ) : (
              <>
                <span className="lw-tab act">
                  <Am agent="claude" className="size-3" />
                  <span className="lbl">Restore tabs</span>
                  <X className="i lw-x" aria-hidden />
                </span>
                <span className="lw-tab">
                  <Am agent="codex" className="size-3" />
                  <span className="lbl">Word wrap</span>
                </span>
                <span className="lw-tab">
                  <Am agent="claude" className="size-3" />
                  <span className="lbl">Palette</span>
                </span>
                <span className="lw-tab">
                  <Am agent="gemini" className="size-3" />
                  <span className="lbl">Theme preview</span>
                </span>
              </>
            )}
            <span className="lw-ib">
              <Plus className="i" aria-hidden />
            </span>
            <span className="lw-rt">
              <span className="lw-ib lw-opt">
                <Columns2 className="i" aria-hidden />
              </span>
              <span className="lw-ib lw-opt">
                <Globe className="i" aria-hidden />
              </span>
              <span className="lw-ib">
                <SquareTerminal className="i" aria-hidden />
              </span>
              <span className="lw-fl">
                <FolderTree className="i" aria-hidden />
                Files
              </span>
              <span className="lw-ib">
                <PanelRight className="i" aria-hidden />
              </span>
            </span>
          </div>

          <div className="lw-chat">
            <div className="lw-col">
              {isReq ? (
                <>
                  <div className="lw-who">
                    <Am agent="codex" className="size-3" />
                    <b>{AGENT_NAME.codex}</b> GPT-5.5
                  </div>
                  <div className="lw-ub">Add a per-customer rate limit to POST /webhooks</div>
                  <div className="lw-tool">
                    <FileText className="i" aria-hidden />
                    <b>Read</b> src/routes/webhooks.ts
                  </div>
                  <div className="lw-tool">
                    <Pencil className="i" aria-hidden />
                    <b>Edit</b> middleware/limit.ts <span className="p">+58</span> <span className="m">−0</span>
                  </div>
                  <div className={`lw-req${s.reqDone ? " done" : ""}`}>
                    <div className="h">
                      {s.reqDone ? <Check className="i" aria-hidden /> : <CircleAlert className="i" aria-hidden />}
                      {s.reqDone ? "Approved" : "Codex wants to run a command"}
                    </div>
                    <code>pnpm test --filter billing-api</code>
                    {s.reqDone ? null : (
                      <div className="a">
                        <button type="button" className="lw-btn" onClick={() => { touched.current = true; approve() }}>
                          Deny
                        </button>
                        <button type="button" className={`lw-btn pri${s.press ? " press" : ""}`} onClick={() => { touched.current = true; approve() }}>
                          Approve <kbd>⏎</kbd>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="lw-who">
                    <Am agent="claude" className="size-3" />
                    <b>{AGENT_NAME.claude}</b> Opus 5.5
                  </div>
                  {s.chat.map((it) => (
                    <ItemView key={it.id} it={it} />
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="lw-stl">
            {!isReq && s.subs ? (
              <>
                {s.subsRunning ? <RunningRing /> : null}
                {s.subs} agents{s.subsRunning ? ` · ${s.subsRunning} running` : ""}
              </>
            ) : null}
          </div>

          <div className={`lw-cmp${s.typed !== null ? " focus" : ""}`}>
            <div className={`lw-ph${s.typed !== null ? " typed" : ""}`}>
              {s.typed !== null ? (
                <>
                  {s.typed}
                  <span className="lw-caret" />
                </>
              ) : (
                "Ask Claude. @ to mention a file, / for commands"
              )}
            </div>
            <div className="lw-row">
              <Plus className="i" aria-hidden />
              <AtSign className="i" aria-hidden />
              <SlidersHorizontal className="i" aria-hidden />
              <span className="lw-sp" />
              <span className="lw-use">
                <svg viewBox="0 0 16 16" aria-hidden>
                  <circle cx="8" cy="8" r="6" fill="none" stroke="#4A4357" strokeWidth="2.4" />
                  <circle cx="8" cy="8" r="6" fill="none" stroke="#A9A6B2" strokeWidth="2.4" strokeDasharray="37.7" strokeDashoffset={37.7 * (1 - s.use / 100)} transform="rotate(-90 8 8)" style={{ transition: "stroke-dashoffset .8s" }} />
                </svg>
                {s.use}%
              </span>
              <span className="lw-pill">
                <Am agent="claude" className="size-3" />
                <b>Opus 5.5</b>
                <span>Medium</span>
              </span>
              <span className="lw-gh">
                <ShieldCheck className="i" aria-hidden />
                Full access
              </span>
              <span className={`lw-send${s.sendGo ? " go" : ""}`}>
                <ArrowUp className="i" aria-hidden />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
