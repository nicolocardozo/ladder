# Google Play listing (draft)

Limits: title 30, short description 80, full description 4000.

| Field | Value |
|---|---|
| Package | `dev.nicolocardozo.ladder.mobile` |
| App name (title, 26) | `Ladder: Agents on your Mac` (fallback `Ladder Remote`) |
| App or game | App |
| Category | Tools (alternative: Productivity). Play has no "Developer Tools" category; Tools fits a remote control best |
| Tags | Developer tools, Remote control, Productivity |
| Contact email | hello@itsladder.dev |
| Website | https://itsladder.dev |
| Privacy policy | https://itsladder.dev/privacy |
| Price | Free, no ads, no in-app purchases |

## English

**Short description** (75): `Approve requests and answer your coding agents from your phone. No account.`

**Full description**: use the App Store description in `app-store.md` with these changes: "iPhone" becomes "Android", and "tap Try demo" stays the same. It is well under 4000 characters (about 1900).

## Italiano

**Titolo** (26): `Ladder: agenti sul tuo Mac`

**Descrizione breve** (78): `Approva richieste e rispondi agli agenti dal telefono. Cifrato, senza account.`

**Descrizione completa**: la descrizione italiana di `app-store.md`, con "iPhone" sostituito da "Android".

## Content rating (IARC questionnaire)

Category: Utility, Productivity, Communication or Other (choose "Utility/Productivity"). Answer No to: violence, sexual content, profanity, controlled substances, gambling, user-generated content shared between users, location sharing, digital purchases. The app does not let users communicate with other users. Expected: Everyone / PEGI 3 / USK 0.

## Target audience and content

- Target age groups: 18 and over (a developer tool). Do not select under 13: it would trigger the Families policy.
- Not designed for children, no appeal to children.
- Ads: No. News app: No. Government app: No. Financial features: None. Health: None.

## Data safety form

| Question | Answer |
|---|---|
| Does the app collect or share any of the required user data types? | Yes (the push token) |
| Is all collected data encrypted in transit? | Yes |
| Can users request data deletion? | Yes. The push token is kept only on the user's Mac and deleted when the phone is revoked or the Mac is forgotten; see privacy policy. There is no server-side account |
| **Device or other IDs** (FCM push token) | Collected: Yes. Shared: No for Google's purposes (it is processed by Expo's push service acting as a service provider and by Google FCM to deliver the push; Play treats a service provider acting on your behalf as not "sharing"). Optional: No (without it there are no notifications, but the app works; mark Optional = Yes if you prefer, since users can decline notifications). Purpose: **App functionality** |
| Personal info, financial, health, location, contacts, messages, photos/videos, audio, files, calendar, app activity, web browsing, app info and performance | Not collected |
| Messages / app activity (sessions and chats) | Not collected: end-to-end encrypted between phone and Mac, the relay cannot read it. Play excludes data that is end-to-end encrypted so that the developer cannot access it |
| Camera | Permission used only to scan the pairing QR code; frames are not stored or sent. No data type applies |

Security practices: data encrypted in transit: Yes; independent security review: No; follows Families policy: No.

Declarations to accept: US export laws (see RELEASE.md, export compliance). Permissions declared in the manifest: CAMERA (pairing), VIBRATE (haptics), plus those added by libraries (INTERNET, POST_NOTIFICATIONS).

## Review notes for Play (App access)

Select "All or some functionality is restricted" and give:

```
There is no login. To see the app without a Mac, tap "Try demo" on the first screen: sample sessions, a pending permission request and a question, with every action working locally. Real use requires the free Ladder macOS app (https://itsladder.dev), paired by scanning a QR code; a screen recording of a real pairing is available on request.
```

## Testing requirement

A personal developer account created after 13 Nov 2023 must run a closed test with at least 12 testers opted in for 14 days before it can apply for production access. See RELEASE.md.
