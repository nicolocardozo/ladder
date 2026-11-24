# Ladder mobile: release checklist

Everything here is for you to do: nothing was built in the cloud, logged into or submitted. Linear: LAD-55. Listing texts and screenshots are in `store/`. Run commands from `app/mobile` with Node 24 (`export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"`).

## 1. Before any build

1. **Accounts**: Apple Developer Program (99 USD/year), Google Play Console (25 USD once), Expo (project `manybitstech/ladder`, id in `app.json`). `npx eas-cli login`.
2. **Relay**: deploy it (`app/relay/README.md`: `wrangler login`, `wrangler deploy`, custom domain in `wrangler.toml`).
3. **Default relay URL**: `REMOTE_DEFAULT_RELAY_URL` in `app/desktop/src/shared/protocol.ts` is still the placeholder `wss://relay.ladder.app`. The website lives at `itsladder.dev`, so something like `wss://relay.itsladder.dev` fits. Change it, rebuild the Mac app too (phone and Mac share the constant) and test a real pairing across two networks.
4. **Apple credentials**: `npx eas-cli credentials -p ios` (EAS creates the distribution certificate, provisioning profile and the **APNs key** for push; it asks for your Apple login, do it yourself). Register test iPhones for ad hoc builds with `npx eas-cli device:create`.
5. **Android push (FCM v1)**: create a Firebase project, add the Android app `dev.nicolocardozo.ladder.mobile`, download `google-services.json`, create a service account key and upload it with `npx eas-cli credentials -p android` (FCM V1). Then add `"googleServicesFile": "./google-services.json"` under `android` in `app.json` (the file is not in the repo; keep it out of git, or provide it as an EAS file env var). Without it, Android builds but gets no push.
6. **Fill the TODOs in `eas.json`**: `ascAppId` (App Store Connect > App > General > Apple ID), `appleTeamId`, Play service account key path (kept outside the repo).
7. **Create the app records** with the final name: App Store Connect (try `Ladder`, fallback `Ladder Remote`), Play Console.

## 2. Config decisions already made (change here if you disagree)

- **Version** `1.0.0` (`app.json`, `package.json`). Build numbers are managed by EAS (`appVersionSource: remote`, `autoIncrement` in production). Bump `version` for every later store release.
- **iPad: `supportsTablet: false`.** The app has a docked layout from 600 pt but no tablet design. With `true`, App Store Connect requires 13-inch iPad screenshots and review also runs on iPad, and a layout never designed for it is a rejection risk (4.0 / 2.1). iPhone-only apps still install on iPad in compatibility mode. Turn it on later after a proper iPad pass. Android tablets are not blocked; Play only asks for tablet screenshots to be featured on large screens.
- **No OTA updates**: `expo-updates` is not installed, so no `channel` is set in `eas.json` either (add both together if you add OTA). Guideline 2.5.2: if you add it later, ship only JS bug fixes, never new features that change the review.
- **Dev tools**: `Connect manually` and the dev driver are `__DEV__` only, absent from release builds.

## 3. Export compliance (encryption)

`ITSAppUsesNonExemptEncryption` is now **`true`** (it was `false`). Reason: the app implements Noise (X25519, ChaCha20-Poly1305, SHA-256, Ed25519) itself with `@noble`, on top of the OS TLS. Apple only treats the OS's own encryption as exempt from documentation; own implementation of standard algorithms is not (Apple, "Complying with Encryption Export Regulations", accessed 2026-11-24; "Export compliance documentation for encryption", accessed 2026-11-24, lists "standard algorithm not provided by the OS" as needing the French declaration only, no CCATS). Saying `false` would be a wrong declaration.

What this means:

- In App Store Connect, answer: uses encryption **Yes**; does not qualify for the Category 5 Part 2 exemptions; algorithms are **standard** (not proprietary). I could not read the exact current wording of the questions, so check it in the UI. Every new build will ask again until Apple gives you a compliance code; once you have one, add `"ITSEncryptionExportComplianceCode": "<code>"` to `infoPlist` (left out on purpose, it only exists after Apple approves documents).
- **US (EAR)**: free mass-market software with standard encryption is normally ECCN **5D992.c** under License Exception ENC (§740.17(b)(1)). Since the 29 Mar 2021 BIS rule, mass-market 5D992.c items no longer need a self-classification report or classification request (Goodwin / WSGR summaries 2021; DWT reminder 2024 says the annual report is still due for other (b)(1) items; BIS page https://www.bis.gov/learn-support/encryption-controls/annual-self-classification). Not verified against the current CFR text: confirm with a lawyer or BIS that your case needs nothing.
- **France**: crypto supply is regulated (decree 2007-663, ANSSI; https://cyber.gouv.fr/reglementation/reglementation-identite-confiance-numerique/controles-reglementaires-cryptographie/controle-moyen-de-cryptologie/). Apple asks for the French declaration only if the app is distributed in France. Options: file the ANSSI declaration and upload it, or untick France in the app's availability. **This is your legal call**; I did not decide it.
- Not legal advice. Google Play only has a US export laws acknowledgement.

## 4. Build and test

```sh
npx eas-cli build -p ios --profile preview          # ad hoc, registered devices
npx eas-cli build -p android --profile preview      # APK
npx eas-cli build -p ios --profile production       # store build
npx eas-cli build -p android --profile production   # AAB
```

The `development` profile is a simulator build (no expo-dev-client: it did not compile with Xcode 27). Local check without the cloud: `npx expo run:ios --configuration Release` (needs `pod` on PATH, e.g. `/usr/local/bin`).

## 5. TestFlight

1. `npx eas-cli submit -p ios --profile production --latest`.
2. In App Store Connect > TestFlight, answer export compliance (section 3), add yourself as internal tester, install, pair with a real Mac, confirm push arrives with generic text.
3. For external testers, the first build goes through Beta App Review (use the same notes as below).

## 6. App Store submission

- Listing, keywords, URLs: `store/app-store.md`. Screenshots: `store/screenshots/ios` (iPhone 6.9", 1320x2868).
- **Privacy policy URL** https://itsladder.dev/privacy (deploy the website first: the page must be live). **App Privacy** answers are in `store/app-store.md` (push token as Device ID, App Functionality, not tracking).
- **Age rating**: answers in the same file, expected 4+.
- **App Review notes**: paste the notes from `store/app-store.md`. Main risk is 2.1 / 4.2.3 "needs another app": the demo mode on the first screen ("Try demo") is the answer. Not a remote desktop (4.2.7 does not apply: no screen mirroring).
- **Screen recording** to attach: a real pairing with a Mac (scan QR, see sessions, approve a request). Under 2 minutes, record the iPhone with QuickTime or Control Center and the Mac screen next to it.
- No sign-in needed: leave "Sign-in required" off.
- Expect questions about the relay and encryption; the answer is in `app/relay/README.md` and the privacy page.

## 7. Google Play

1. Create the app, fill the listing from `store/google-play.md`, Data safety, content rating, target audience (18+), App access (demo notes).
2. `npx eas-cli submit -p android --profile production --latest` uploads to the **internal** track as draft. The first upload of a new app often has to be done by hand in the console (Play API requires an existing release).
3. **Personal accounts created after 13 Nov 2023** (check yours): a **closed test with at least 12 testers opted in for 14 days** is required before applying for production access. Start it early: recruit testers, add them to a Google Group, run the closed track, then apply. Organisation accounts are exempt.
4. **Direct APK** (outside Play): the `preview` Android profile gives an APK. Google's Android developer verification (rolling out 2026 for sideloaded apps; check the current dates and your region) requires a registered developer for APKs to install on certified devices, so it is not a way around Play long term.

## 8. After release

- Keep `website/src/app/privacy/page.tsx` in sync with anything that touches data.
- If the relay logs anything, update the privacy label and Data safety.
