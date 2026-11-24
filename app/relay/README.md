# Ladder relay

A small relay that connects the Ladder phone app and your Mac when they are on different networks. It runs on Cloudflare Workers with one Durable Object per Mac. The code lives here so anyone can host their own.

The Mac opens an outbound WebSocket to the relay, so you do not open any port at home. The phone connects to the same Mac id. The relay forwards bytes between them and nothing else.

## What the relay sees and what it does not

All traffic between phone and Mac is end-to-end encrypted with a Noise handshake (`Noise_NK_25519_ChaChaPoly_SHA256`, see `app/desktop/src/shared/remote/`). The relay never holds a key that can decrypt it.

The relay sees:

- IP addresses of the Mac and of every phone.
- When they connect and disconnect, and message timing and sizes.
- The Mac id (a hash of a public key).
- The Mac's public Ed25519 key, shown once when the Mac authenticates.
- The last time the Mac was seen, and whether it said it was going to sleep or quitting.

The relay does not see chats, commands, file names, session names or anything else inside the encrypted messages. It does not store messages, it does not buffer them beyond what is in flight, and it does not log payloads. The only thing written to Durable Object storage is `{ lastSeen, reason }` for each Mac.

## What protects what

- **The Noise handshake is the only authentication between phone and Mac.** The phone knows the Mac's public key (from the pairing QR, LAD-51) and refuses anyone who cannot prove they hold the matching private key.
- **The relay URL is not authenticated by that handshake.** A malicious or wrong relay cannot read or forge messages, but it can drop them, delay them, tell the phone the Mac is offline, or collect the metadata listed above. Only point Ladder at a relay you trust to stay available.
- **Nobody can take your Mac's place on the relay.** The Mac id is derived from a separate Ed25519 key that only that Mac holds (`remote-relay-key.json`). To connect as the Mac, a client has to sign a fresh challenge from the relay with that key. A new authenticated Mac connection replaces the old one. Phones do not authenticate to the relay.
- **A signature only works on the relay it was made for.** The signed text includes the relay origin (`https://host[:port]`, as the Worker sees it), so one relay cannot replay a challenge it got from another. If you put the relay behind a proxy that rewrites the host, the Mac and the relay see different origins and sign-in fails.
- Abuse limits:
  - At most 8 phones per Mac; the 9th is closed. While the Mac is offline, a new phone takes the place of the phone that has been waiting longest, and any phone waiting for an offline Mac is closed after 5 minutes even if it keeps pinging (its client reconnects and gets the status again).
  - At most 4 unauthenticated Mac sockets: a new one closes the oldest, so someone who knows an id cannot lock the real Mac out. An unauthenticated socket is closed after 10 seconds.
  - At most 64 KiB per message (one Noise message).
  - Per-connection message and bandwidth limits. A phone that exceeds them is closed; a Mac that exceeds them has the extra messages dropped, because closing it would disconnect every phone.
  - Sockets that stay silent for about 100 seconds are closed.
  - Limits are kept in memory and reset when the object hibernates, so they are a brake rather than a hard quota.

## Wire protocol

`wss://<relay>/v1/<id>?role=mac|phone`. The full description is at the top of `app/desktop/src/shared/remote/relay-protocol.ts`.

- Phone: binary messages are Noise messages, passed through unchanged. Text messages come from the relay: `{"t":"mac","online":true}` or `{"t":"mac","online":false,"since":<ms|null>,"reason":"offline|asleep|quit|unknown"}`.
- Mac: one socket for all phones. Binary messages are `[type u8][connection id u32 BE][payload]` (data, open, close). Text messages are JSON control messages: challenge, auth, ready, state.
- Keepalive: send the text `ping`, the relay answers `pong` without waking the Durable Object.

## Run it locally

```sh
pnpm install
pnpm --filter @ladder/relay dev        # wrangler dev on http://127.0.0.1:8787, no Cloudflare account needed
pnpm --filter @ladder/relay test       # starts wrangler dev and runs the integration tests
```

To try Ladder against it, start the desktop app with `LADDER_RELAY_URL=ws://127.0.0.1:8787` (development builds only). The host prints its Mac id in the log (`[remote] relay …, id …`). `app/desktop/scripts/remote-client.ts --relay http://127.0.0.1:8787 --id <id>` acts as a phone, and `app/desktop/scripts/remote-host-harness.ts` acts as a Mac with fake data.

## Deploy to your own Cloudflare account

1. Create a Cloudflare account and run `pnpm --filter @ladder/relay exec wrangler login`.
2. From `app/relay`, run `pnpm exec wrangler deploy`. The deploy uses the account you logged in with; no account id or secret is stored in this repository.
3. Optional: add a custom domain or route in `wrangler.toml` (`routes = [{ pattern = "relay.example.com", custom_domain = true }]`). Otherwise Wrangler prints a `*.workers.dev` address.
4. Point Ladder at it: in Ladder's remote settings, set the relay URL to `wss://<your-worker>.workers.dev` (or your domain). Without a custom URL Ladder uses its default relay, `wss://relay.ladder.app` (a placeholder until the hosted relay is announced).

The Durable Object uses SQLite-backed storage (`new_sqlite_classes` in `wrangler.toml`), which is the only kind the Workers Free plan supports.

## Costs

For personal use the Workers Free plan is normally enough: a Mac with a few phones makes few requests, and the keepalive `ping` is answered by Cloudflare's WebSocket auto-response without running your code. Incoming WebSocket messages are billed at a 20:1 ratio against the request quota, and a Durable Object with only idle connections can hibernate, so it does not accrue duration charges. The relay sets alarms only at real deadlines (the 10 s sign-in timeout, the 100 s silence limit, the 5 minute wait limit), not on a fixed timer. With live sockets this means one short wake-up roughly every 100 seconds per Mac to check that the sockets are still pinging. The paid plan ($5/month) raises the quotas if you share one relay among many people. Check Cloudflare's current pricing and limits before relying on these numbers.

## Credits

The overall shape (a Durable Object per endpoint with WebSocket hibernation) follows the approach of the Apache-2.0 relay in the Paseo project. No code was copied.
