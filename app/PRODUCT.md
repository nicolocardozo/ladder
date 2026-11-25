# Product

## Register

product

## Users

A single person, for now: the developer who builds it and uses it every day on a 13–14″ Mac (reference window 1440 × 900), with several repositories open at once. They work for hours with coding agents (Claude Code, Codex, ACP agents) and often switch from one project to another. The work comes in waves: they write a request, the agent works, and meanwhile another agent in another project asks for an approval. They use the keyboard and shortcuts more than the mouse. Ladder is open source under Apache-2.0, for people who work the same way.

## Product Purpose

Ladder is a desktop workspace for macOS where you work on several repositories at once with coding agents: the chat with the agent at the center, files and diffs within reach, a terminal when you need it, and a single view of who is waiting for you in which project.

Success: at any moment you understand at a glance what is happening in every project (who is working, with which agent and model, who is waiting for you) and you step in with one or two actions without losing the thread of what you were writing.

## Agent catalog

Besides Claude Code and Codex, Ladder talks to the agents in the ACP registry, from Settings → Agents. The catalog shows the most used agents first and says what will happen: a CLI already on the Mac, a package that starts with npx or uvx on first use, or a binary to download.

- **No surprise downloads.** A binary is downloaded only after a confirmation that shows name, version, source host, size (in KiB, MiB or GiB, the units of the limits) and checksum (full sha256, copyable). The confirmation does not exist without a known checksum. The checksum is verified before the agent can start, and Ladder sends the host the version, checksum and host that the user saw: if the registry changes any of the three in the meantime (even after the dialog: the host answers `checksum-changed`), the download stops, Ladder rereads the catalog and the confirmation reopens with the new data, never the old; if the entry can no longer be confirmed, the row says why. For GitHub releases the host shown is `github.com/owner/repository`, and the exact one travels with the command. Ladder never updates an agent on its own: an update is another confirmation, identical to the first.
- **No checksum, no download, and Ladder does not invent one.** It does not use checksums declared by the vendor outside the registry. Entries without a verifiable checksum stay unavailable, with the reason written out and a link to the vendor's procedure ("Install from the official site"), like a release without a digest. If the checksum cannot be read right now, the entry says "Checksum not available now" with "Try again", which rereads the catalog, with no link and no download. If a downloaded agent has an update but its checksum cannot be read right now, the row says so ("Update to v… is available, but the checksum is not available now") with "Try again". If the CLI is already on the Mac, the same is added.
- **Pinned hosts.** Ladder downloads only from the address expected for that agent. A different address, an archive that is too large, or an already downloaded version that reappears with a different checksum is not downloaded: the reason is written in plain words and the checksum conflict is a visible warning. An install error does not disappear silently: it stays visible with "Try again" (also for a redirect to a host that is not allowed or a checksum that is momentarily missing) until the user rereads by hand with Rescan or the registry publishes a new version; then the row goes back to "Download and add"; signature, team, quarantine and conflict stay until the registry publishes another version.
- **The signature is shown after installation.** The confirmation comes before the download, so the program's signature (signed by whom, intact signature but unverified signer, ad hoc, or unsigned) is read at the end of the installation and stays in the agent's row. Ladder describes the state and never says that a program is "safe". For curated agents with a developer pinned in Ladder (OpenCode, Kiro, Junie), a download that is unsigned, signed ad hoc or signed by another developer is not installed: Ladder says it is not signed by the developer it expects (without saying the signature "does not hold", which is a different thing) and does not offer "Try again". A signature that does not hold blocks the installation; if macOS puts the file in quarantine, Ladder explains it and does not remove the quarantine.
- **Sign-in never goes through Ladder.** If an agent asks to sign in, Ladder shows the methods the agent declares and, for those the agent handles itself, a button that asks it to. It does not see or store credentials. For terminal methods it only says to sign in from the terminal with the agent's command, without inventing it; for those Ladder cannot handle it says they are not supported, with no button. "Stop waiting" really stops the sign-in: the state goes back to required immediately and a new "Sign in" works.
- **First launch.** Under the shortcuts, "Other agents found on your Mac" appears with the CLIs already installed, to add with one click. "Hide" hides them only for the session: it is not a choice Ladder remembers.

## Brand Personality

Precise, calm, essential. The interface disappears behind the work: little noise, clear hierarchy, the conversation in the foreground. Confidence comes from care in the details, not from decoration. The identity is Circuit (iris, deep violet, citron used sparingly for work in progress), but color accompanies and does not dominate.

Main reference: Cursor's agents window (dark, essential structure, plenty of air around the conversation). Secondary references: Codex's chat for readability, Linear for the sharpness of small type and surfaces with few borders, Raycast for macOS polish.

## Anti-references

- Interfaces with many overlapping modes, crowded surfaces, states conveyed by color alone.
- The "cheap and dated" look of Ladder's first version: a dozen different text sizes, all small, spaced small-caps labels, borders and lines everywhere, crowded top bars, repeated titles.
- Generic dashboard SaaS: identical cards in a grid, giant numbers with gradients, glassmorphism.
- Modal panels as a first response: inline and progressive first.

## Design Principles

1. **The work at the center.** The conversation and the code are the content; navigation, bars and panels stay a step back in weight, color and density.
2. **State reads without opening.** Who is working, with which agent and model, who is waiting for you: visible from the sidebar, tabs and "Waiting", always with shape and label in addition to color.
3. **One grammar.** The same buttons, chips, menus, cards and states in every view; a short type scale and spacing on a grid, so the whole feels designed and not accumulated.
4. **Calm that is earned.** Fewer lines and more space, less color and more weight hierarchy; strong color only for what blocks you or goes wrong.
5. **Keyboard first.** Every frequent action has a visible shortcut and focus always goes where it is needed.

## Accessibility & Inclusion

- WCAG AA contrast on all themes: 4.5:1 for text, 3:1 for control borders, focus and indicators (checked by `app/desktop/scripts/check-contrast.mjs`).
- No text below 12 px.
- Every state distinguishable in grayscale (shape, icon, label), including in the Mono themes.
- Reduced motion respected: animations are short and replaced by static states with `prefers-reduced-motion`.
- Full keyboard navigation, focus always visible.
