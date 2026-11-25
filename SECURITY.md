# Security policy

Ladder runs coding agents on your Mac, with access to your repositories and terminals, so security reports matter.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: on this repository, open **Security → Report a vulnerability**.

Include what you found, how to reproduce it and the Ladder version. You'll get an answer within a few days; once a fix is released, the report can be made public with credit to you, if you want it.

## Scope

In scope: the Ladder app (`app/desktop`) and the website (`website`), for example how Ladder starts agents and child processes, the environment passed to them, downloads of agent binaries and their checksums, the `ladder://` links, and anything that could expose credentials or run code without the user's consent.

Out of scope: vulnerabilities in the agents themselves (Claude Code, Codex, ACP agents) or in third-party services; report those to their makers.

## Supported versions

Only the latest release receives fixes.
