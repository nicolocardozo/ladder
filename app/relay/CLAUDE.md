# Relay

The relay between the Mac and the phone: a Cloudflare Worker with a Durable Object that forwards encrypted bytes it can't read. Package `@ladder/relay`. `README.md` explains what the relay sees, the wire protocol, local runs, deploys and costs.

## Rules

- The relay never decrypts, parses or stores message content. It may keep only what `README.md` and the website's privacy page say (when a Mac was last online and why it went away); anything new it would see or store must be added to both first.
- No account ids, routes with private domains or secrets in `wrangler.toml`: deploys use the account of whoever runs `wrangler login`.
- The wire protocol is shared with the Mac (`app/desktop/src/shared/remote/`) and the phone (`app/mobile/src/remote/`): a change touches all three.

## Verification

1. `pnpm --filter @ladder/relay typecheck`.
2. `pnpm --filter @ladder/relay test`: starts `wrangler dev` locally (no Cloudflare account needed) and runs the integration tests.
