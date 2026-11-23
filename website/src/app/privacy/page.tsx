import type { Metadata } from "next"
import Link from "next/link"
import { PageHeader, PageShell, Prose, Section } from "@/components/page"
import { SITE } from "@/lib/site"

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "Ladder runs entirely on your Mac: no account, no server, no telemetry. What the app and this website do with your data, in plain words.",
  alternates: { canonical: "/privacy" },
  openGraph: { url: "/privacy" },
}

// Da aggiornare a ogni cambio che tocca i dati (analytics, aggiornamenti automatici, nuovi servizi)
const UPDATED = "2026-11-23"

export default function Page() {
  return (
    <PageShell className="max-w-4xl">
      <PageHeader
        eyebrow="Privacy"
        title="Your code and your accounts stay on your Mac"
        lead="Ladder has no account, no server and no telemetry. This page explains what the app and this website do with data, in plain words."
      />
      <p className="mt-6 font-mono text-[12.5px] text-muted-ink">
        Last updated <time dateTime={UPDATED}>November 23, 2026</time>
      </p>

      <div className="mt-16 space-y-16">
        <Section id="app" title="The Ladder app">
          <Prose className="mt-5">
            <ul>
              <li>
                <strong>Everything is local.</strong> Projects, sessions, conversations, settings and history are stored in
                a folder on your Mac. Nothing is sent to us, because there is nowhere to send it.
              </li>
              <li>
                <strong>No telemetry.</strong> Ladder doesn&apos;t collect usage statistics, crash reports or identifiers.
              </li>
              <li>
                <strong>No Ladder account.</strong> You never sign up with us.
              </li>
              <li>
                <strong>Your agents talk to their own providers.</strong> When you send a message, the agent you chose (for
                example Claude Code or Codex) sends it, together with the code it reads, to its provider under that
                provider&apos;s terms and privacy policy. Ladder isn&apos;t in the middle.
              </li>
              <li>
                <strong>Credentials stay with their owners.</strong> Agents sign in with their own flow, and Ladder never
                reads, stores or forwards their passwords or tokens. GitHub goes through the <code>gh</code> CLI and its
                login. A Linear API key, if you add one, is encrypted in the macOS keychain.
              </li>
            </ul>
            <h3>Network requests the app makes</h3>
            <p>Ladder connects to the internet only to do what you ask:</p>
            <ul>
              <li>the public ACP registry, to list the agents you can add;</li>
              <li>the agent vendor&apos;s download host, when you install an agent;</li>
              <li>GitHub and Linear, when you use those integrations;</li>
              <li>web pages you open in Ladder&apos;s built-in browser.</li>
            </ul>
          </Prose>
        </Section>

        <Section id="website" title="This website">
          <Prose className="mt-5">
            <ul>
              <li>
                <strong>No cookies and no analytics.</strong> We don&apos;t track visits or use advertising scripts. Your
                light or dark theme choice is saved in your browser&apos;s local storage and never leaves it.
              </li>
              <li>
                <strong>Hosting.</strong> The site is hosted by Vercel, which processes standard request data such as IP
                address and browser type to deliver and protect the site. Fonts are served from this domain, not from a
                third party.
              </li>
              <li>
                <strong>Waitlist.</strong> Joining the waitlist means sending us an email. We use your address only to tell
                you when Ladder is available and to answer you, we don&apos;t share it, and we delete it whenever you ask.
              </li>
            </ul>
          </Prose>
        </Section>

        <Section id="contact" title="Your rights and contact">
          <Prose className="mt-5">
            <p>
              You can ask what we hold about you (at most, your email if you wrote to us), ask us to correct or delete it,
              or ask anything else about privacy at <a href={`mailto:${SITE.email}`}>{SITE.email}</a>.
            </p>
            <p>
              If Ladder ever adds something that changes this page, like optional crash reports or automatic updates, we will
              update it here first and note it in the <Link href="/changelog">changelog</Link>.
            </p>
          </Prose>
        </Section>
      </div>
    </PageShell>
  )
}
