# App Store listing (draft)

Character limits are checked: name 30, subtitle 30, promotional text 170, keywords 100.

## Identity

| Field | Value |
|---|---|
| App name (first choice) | `Ladder` (4) |
| Fallback if taken | `Ladder Remote` (13) |
| Bundle ID | `dev.nicolocardozo.ladder.mobile` |
| Primary category | Developer Tools |
| Secondary category | Productivity |
| Support URL | https://itsladder.dev/docs |
| Marketing URL | https://itsladder.dev |
| Privacy policy URL | https://itsladder.dev/privacy |
| Contact email | hello@itsladder.dev |
| Price | Free |
| Copyright | 2026 Nicolo Cardozo |

Name availability is unknown until you try to create the app record: names are unique across the App Store. If `Ladder` is taken, use `Ladder Remote` (the home screen label can stay `Ladder`; it comes from app.json `name`). Support URL points to the docs; replace it with a dedicated support page if you add one.

## English (U.S.)

**Subtitle** (27): `Your Mac's agents, in reach`

**Promotional text** (163):
`Approve a request, answer a question or read a reply from anywhere. Your agents keep running on your Mac, and the phone is end-to-end encrypted. No account needed.`

**Description**

```
Ladder for iPhone is a remote control for Ladder on your Mac, the calm desktop app that runs Claude Code, Codex, Gemini CLI and other coding agents across all your repos.

An agent stops and asks for permission while you are away from your desk. Now you can answer from your phone and let it carry on.

WHAT YOU CAN DO
- See every session at a glance, with what is running, what is done and what is waiting for you
- Approve or deny a permission request, with the diff in front of you
- Answer an agent's question
- Read the reply as it arrives and send a new message
- Stop a session
- Get a notification when something needs you

PRIVATE BY DESIGN
- No account to create. Pair by scanning a code shown by your Mac
- End-to-end encrypted between your phone and your Mac. The relay in the middle forwards bytes and cannot read them
- Notifications carry a generic sentence only, never project names or messages
- No analytics, no ads, no tracking

YOUR AGENTS STAY ON YOUR MAC
This is a remote control, not a remote desktop. Your code, your agents and your subscriptions stay on your Mac; the phone shows sessions as structured data and runs no code.

REQUIREMENTS
Ladder for iPhone works with the Ladder app for macOS, which you can download at itsladder.dev. Turn on access from your phone in Ladder's settings, then scan the code with this app. To look around first, tap "Try demo" on the first screen: sample sessions and requests, no Mac needed.
```

**Keywords** (95): `claude,codex,gemini,agent,coding,remote,approve,terminal,git,diff,developer,ai,cli,worktree,mac`
(Do not repeat the app name or category words: they are indexed already.)

**What's new (1.0.0)**: `First release.`

## Italiano

**Nome**: `Ladder` (o `Ladder Remote`)

**Sottotitolo** (28): `Gli agenti del Mac, in tasca`

**Testo promozionale** (168):
`Approva una richiesta, rispondi a una domanda o leggi una risposta da qualsiasi posto. Gli agenti restano sul tuo Mac e il telefono è cifrato end-to-end. Senza account.`

**Descrizione**

```
Ladder per iPhone è il telecomando di Ladder sul tuo Mac, l'app desktop che fa lavorare Claude Code, Codex, Gemini CLI e altri agenti di programmazione su tutti i tuoi repository.

Un agente si ferma e chiede il permesso mentre sei lontano dalla scrivania. Ora puoi rispondere dal telefono e lasciarlo andare avanti.

COSA PUOI FARE
- Vedere tutte le sessioni a colpo d'occhio: cosa è in corso, cosa è finito e cosa aspetta te
- Approvare o negare una richiesta di permesso, con il diff davanti
- Rispondere a una domanda dell'agente
- Leggere la risposta mentre arriva e mandare un nuovo messaggio
- Fermare una sessione
- Ricevere una notifica quando serve qualcosa da te

PRIVATO PER SCELTA
- Nessun account da creare. Abbini il telefono inquadrando un codice mostrato dal Mac
- Cifratura end-to-end tra telefono e Mac. Il relay in mezzo inoltra i byte e non può leggerli
- Le notifiche contengono solo una frase generica, mai nomi di progetti o messaggi
- Nessuna analisi d'uso, nessuna pubblicità, nessun tracciamento

GLI AGENTI RESTANO SUL TUO MAC
È un telecomando, non un desktop remoto. Il codice, gli agenti e gli abbonamenti restano sul Mac; il telefono mostra le sessioni come dati strutturati e non esegue codice.

REQUISITI
Ladder per iPhone funziona con l'app Ladder per macOS, che scarichi da itsladder.dev. Attiva l'accesso dal telefono nelle impostazioni di Ladder, poi inquadra il codice con questa app. Per dare un'occhiata prima, tocca "Try demo" nella prima schermata: sessioni e richieste di esempio, senza Mac.
```

**Parole chiave** (96): `claude,codex,gemini,agente,codice,remoto,approva,terminale,git,diff,sviluppo,ai,cli,worktree,mac`

## Age rating (questionnaire answers)

All "None": cartoons/fantasy violence, realistic violence, sexual content/nudity, profanity, horror, alcohol/tobacco/drugs, medical info, simulated gambling, contests, loot boxes. Also No: unrestricted web access (the app has no browser), user-generated content (sessions are the user's own agent output on their own Mac, not shared with other users), messaging/chat between users, gambling. Expected result: 4+. Note for App Review: agent output can contain arbitrary text produced by third-party AI models on the user's own Mac; the app does not host or share it.

## App Privacy ("nutrition label")

Apple's definition: "collect" means transmitting data off the device in a way that lets you and/or your third-party partners access it for longer than needed to service the request in real time. Data processed only on device, or end-to-end encrypted so nobody but the user can read it, is not collected.

| Data | Verdict | Reason |
|---|---|---|
| Sessions, messages, project names, diffs | Not collected | End-to-end encrypted phone to Mac; the relay cannot read it and stores none. A short encrypted cache on the phone is on-device only |
| Pairing keys | Not collected | Stored in the phone's secure storage; never sent off the device |
| Push token (APNs token via Expo) | **Collected: Identifiers > Device ID** (conservative choice) | The token is sent to the user's own Mac (not to a Ladder server) and used by Expo's push service to deliver notifications. Expo is a third-party service that receives it, so declare it. Purpose: App Functionality. Linked to identity: No. Used for tracking: No |
| IP address | Not collected | The relay sees IPs and connection times only while forwarding, keeps no logs of them and stores just "Mac last seen" (real-time servicing). Cloudflare may keep standard infrastructure logs: re-check this row once the relay is deployed and you know what it retains |
| Diagnostics / crash / analytics | Not collected | The app has none |
| Contact info, location, contacts, photos, purchases | Not collected | Camera is used only to scan the pairing QR code; frames are not stored or sent |

Tracking: **No**, the app does not track and has no ATT prompt. Final answers on the form: "Data Linked to You: none", "Data Not Linked to You: Device ID (App Functionality)", "Data Used to Track You: none".

If you prefer the strict reading (the token never reaches a server you control), you could answer "Data Not Collected". The conservative answer above is the safer one for review; changing it later is easy.

## App Review information

Sign-in required: **No** (there are no accounts).

**Notes**

```
Ladder Remote is a companion to the Ladder macOS app, which runs coding agents on the user's own Mac. The iPhone app is a remote control, not a remote desktop: it does not mirror or stream the Mac's screen. It shows agent sessions as structured data and lets the user approve or deny permission requests, answer questions, send messages and stop a session. All agent code runs on the user's Mac; the app downloads and executes no code.

There are no accounts or logins. The user pairs by scanning a QR code displayed by the Mac app. Traffic is end-to-end encrypted through a relay that cannot read it. Push notifications contain generic text only.

Because review requires a paired Mac, please use the built-in demo mode: on the first screen tap "Try demo". It shows sample sessions, a pending permission request and a question, and every action (approve, deny, answer, send, stop) works locally with no network or Mac. To leave the demo, open Settings and tap "Exit demo". The camera is requested only when tapping "Pair with your Mac", to scan the pairing QR code.

The app uses its own end-to-end encryption (standard algorithms: X25519, ChaCha20-Poly1305, SHA-256, Ed25519) and declares ITSAppUsesNonExemptEncryption = YES.

A screen recording of a real pairing with a Mac is attached. The Mac app can be downloaded at https://itsladder.dev (free) if you want to test a real pairing.
```

Contact for review: your name, phone and email (fill in App Store Connect). Attach the screen recording of a real pairing.
