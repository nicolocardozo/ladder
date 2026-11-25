# Mobile app

The phone app for iPhone and Android: a remote control for Ladder on the Mac, paired with a QR code and connected end-to-end encrypted through the relay (`app/relay`). Expo (React Native, expo-router), TypeScript, package `@ladder/mobile`. Commands run from the repository root with `pnpm --filter @ladder/mobile …`, except where it says "from `app/mobile`".

## Structure

```
app/           screens (expo-router): tabs, session, sheets, pairing, welcome
src/host/      connection to the Mac: controller, actions, push, Live Activity
src/remote/    relay link and the encrypted channel
src/features/  composer, home, mac, pair, request, session, sessions, sheets, usage
src/store/     state (zustand)
src/locales/   Italian catalog of the phone's own strings
src/demo/      demo data used without a Mac
modules/       native modules (ladder-speech, Swift)
plugins/       Expo config plugins (widget assets)
store/         App Store and Google Play listing drafts
```

The phone and the Mac share the protocol and i18n from `app/desktop/src/shared` (`@shared/…`): a protocol change touches both apps, and both must be rebuilt.

## Rules

- User-facing text in English inside `t('…')`, with the Italian entry in `src/locales/it.ts` (or in the shared catalog for shared strings). The key is the exact English text.
- Never log or store message content, keys or tokens outside the encrypted stores already in place. Notifications carry only generic text and random identifiers (see the privacy page on the website).
- Demo data and tests use generic names (`acme-web`, `/Users/dev/…`).
- Release steps, accounts and store setup are in `RELEASE.md`: only when the user asks, and logins or submissions are the user's to do.

## Verification

1. `pnpm --filter @ladder/mobile typecheck` and `pnpm --filter @ladder/mobile test`.
2. On a simulator: `pnpm --filter @ladder/mobile ios` (or `android`) builds and starts a development build.
3. Without a Mac or a relay: from `app/mobile`, `node scripts/dev-driver.mjs`, then, with the app running, `curl -s localhost:8099/cmd -d '{"demo":true}'` starts the demo; the same command takes `theme`, `route`, `sheet` and more (see `src/dev-driver.ts`). It works only in development builds.
4. A real pairing needs the Mac app and a relay: for a local one, `pnpm --filter @ladder/relay dev`, then start the Mac app with `LADDER_RELAY_URL=ws://127.0.0.1:8787` (see `app/relay/README.md`).
5. In the report, what you couldn't verify and why.
