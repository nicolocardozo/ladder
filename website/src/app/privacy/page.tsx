import type { Metadata } from "next"
import Link from "next/link"
import { PageHeader, PageShell, Prose, Section } from "@/components/page"
import { SITE } from "@/lib/site"

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "Ladder runs on your Mac: no account, no telemetry, and an optional end-to-end encrypted relay for the phone app. What the apps and this website do with your data, in plain words.",
  alternates: { canonical: "/privacy" },
  openGraph: { url: "/privacy" },
}

// Da aggiornare a ogni cambio che tocca i dati (analytics, aggiornamenti automatici, nuovi servizi)
const UPDATED = "2026-11-24"

export default function Page() {
  return (
    <PageShell className="max-w-4xl">
      <PageHeader
        eyebrow="Privacy"
        title="Your code and your accounts stay on your Mac"
        lead="Ladder has no account and no telemetry. The only server involved is an optional relay that lets your phone reach your Mac, and it can't read what passes through it. This page explains what the apps and this website do with data, in plain words."
      />
      <p className="mt-6 font-mono text-[12.5px] text-muted-ink">
        Last updated <time dateTime={UPDATED}>November 24, 2026</time>
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
              <li>web pages you open in Ladder&apos;s built-in browser;</li>
              <li>the relay and Expo&apos;s push service, only if you turn on access from your phone (see below).</li>
            </ul>
          </Prose>
        </Section>

        <Section id="phone" title="The phone app and access from your phone">
          <Prose className="mt-5">
            <p>
              The Ladder app for iPhone and Android is a remote control for Ladder on your Mac. Access from your phone is off
              until you turn it on in Ladder&apos;s settings.
            </p>
            <ul>
              <li>
                <strong>No account.</strong> You pair the phone by scanning a code shown by your Mac. Each phone gets its own
                key, kept in the phone&apos;s secure storage; your Mac keeps its keys in its data folder. You can revoke a
                phone or regenerate the Mac&apos;s key at any time.
              </li>
              <li>
                <strong>End-to-end encrypted.</strong> Sessions, messages, requests and answers travel encrypted between your
                phone and your Mac. They pass through a relay hosted on Cloudflare, by us or by you if you run your own, which
                forwards them without being able to read them.
              </li>
              <li>
                <strong>What the relay sees.</strong> IP addresses, connection times, message sizes and a random identifier
                derived from your Mac&apos;s key. It stores only when your Mac was last online and why it went away (asleep,
                closed, key changed). It keeps no messages and no logs of their content.
              </li>
              <li>
                <strong>Notifications.</strong> Your Mac sends them through Expo&apos;s push service to Apple or Google. They
                contain only a generic sentence in your language, like &quot;A session is waiting for you&quot;, and random
                identifiers. Project names, session titles and messages are never included. Your phone&apos;s push token is
                stored only on your Mac and is deleted when you revoke the phone.
              </li>
              <li>
                <strong>On the phone.</strong> The app collects no analytics or crash reports. To show your sessions when the
                Mac is unreachable it keeps a short encrypted copy of recent conversations on the phone, excluded from
                backups. Forgetting the Mac in the app deletes the copy and the phone&apos;s keys.
              </li>
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
                <strong>Downloads.</strong> The Ladder disk image is served by GitHub, which processes standard request data
                such as IP address to deliver the file. We don&apos;t receive or keep a list of who downloads it.
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
