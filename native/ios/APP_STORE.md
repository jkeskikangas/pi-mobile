# Shipping pi to the App Store (owner checklist)

What the owner does by hand, in order. The code side (privacy manifest, consent sheet, ATS, bundled voice logic, versions, release script) is done; see `README.md` → Notes. Check every Apple form against its current wording: Apple renames questions often.

## 0. Install on your own iPhone first

1. Xcode 26.6 with the iOS 26.5 platform, `brew install xcodegen`.
2. `cd native/ios && xcodegen && open Pi.xcodeproj`.
3. Xcode → Settings → Accounts: sign in with your Apple ID (a free Personal Team works, without push).
4. In `project.yml` `settings.base` set `DEVELOPMENT_TEAM` (your team ID) and `PI_BUNDLE_PREFIX` (e.g. `com.yourname`), run `xcodegen` again. With a paid team you may also set `PI_PUSH: YES` on the `Pi` target.
5. Plug in the iPhone, turn on Developer Mode (Settings → Privacy & Security), pick it as the run destination, press Run. First time: Settings → General → VPN & Device Management → trust your developer certificate.
6. On your computer run `/remote` in pi and scan the code. The app is **HTTPS only** (README → ATS): install Tailscale on the computer and the iPhone so `/remote` shows a `https://….ts.net` code.
7. Free-team builds stop opening after 7 days; press Run again.

Then work through **README → Device checklist**. It is the gate: no TestFlight build goes to external testers or review until every row has a result.

## 1. Accounts and identifiers

- [ ] Paid Apple Developer Program membership (individual or organisation; organisation shows your company as the seller and needs a D-U-N-S number).
- [ ] Certificates, Identifiers & Profiles → Identifiers: the three App IDs Xcode makes on the first signed build (`<prefix>.pi`, `<prefix>.pi.widgets`, `<prefix>.pi.notifications`). Check that `<prefix>.pi` has **Push Notifications** on (if shipping with `PI_PUSH=YES`) and that all three have the **Keychain Sharing** group `<prefix>.shared` (from the entitlements). Automatic signing creates these; fix them by hand only if it fails.
- [ ] Agreements, Tax, and Banking: accept the Free Apps agreement (the app is free).
- [ ] **Push relay (App Store build):** the App Store build sends notifications through the open-source Cloudflare Worker in `relay/` (its README has the deploy steps). It needs **your** APNs auth key as its secrets (Keys → +, Apple Push Notifications service, topic `<prefix>.pi`). The deployed relay is **https://pi-push-relay.pi-push-relay.workers.dev**, the default `PI_RELAY_URL` for Release builds and `release.sh` (which builds with `PI_PUSH=YES`); set `PI_RELAY_URL` to use another. Until its APNs secrets are set, `/v1/register` answers 501 and the app says notifications aren't available yet, retrying on its own only every few hours. The phone registers its APNs token there (`POST /v1/register`) and gives each computer the relay address plus a capability; computers need no Apple key.
- [ ] Push (**self-built apps only**, own team, no `PI_RELAY_URL`): create an APNs auth key (Keys → +, Apple Push Notifications service) and set it on each computer with `/remote settings` → iPhone push (bundle ID `<prefix>.pi`).

## 2. App Store Connect record

- [ ] My Apps → + New App: platform iOS, name (e.g. "pi mobile", which must be unique on the Store), primary language, bundle ID `<prefix>.pi`, SKU (any, e.g. `pi-mobile-ios`), full access.
- [ ] Category: **Developer Tools** (primary), **Productivity** (secondary).
- [ ] Price: free. Availability: all regions you want. (France needs no extra step for the encryption below, but read the export question.)
- [ ] Privacy policy URL: `https://github.com/jkeskikangas/pi-mobile/blob/main/PRIVACY.md`. Support URL: `https://github.com/jkeskikangas/pi-mobile/issues`.

## 3. App Privacy ("nutrition label")

Match `Pi/Resources/PrivacyInfo.xcprivacy` and `PRIVACY.md` exactly. Apple counts data as "collected" when it leaves the device in a way that you **or a third-party partner** can access beyond the real-time request. The developer gets nothing, but OpenAI (and other AI providers your computer uses) process it under the user's own account, so the answers are deliberately conservative:

- Do you or your third-party partners collect data from this app? **Yes**.
- **Audio Data**: App Functionality; **linked** to the user's identity: **Yes** (processed under the user's OpenAI/ChatGPT account); used for tracking: **No**.
- **Photos or Videos** (image attachments sent to the computer and on to its AI model): App Functionality; linked: **Yes**; tracking: **No**.
- **Other User Content** (messages, dictated text, session context given to the realtime model): App Functionality; linked: **Yes**; tracking: **No**.
- **Device ID** is not declared: the APNs device token goes to the push relay you run (Cloudflare processes it as your host, together with sealed ciphertext it can't read) only to deliver notifications. If you'd rather be stricter, declare **Device ID**, App Functionality, not linked, no tracking, and add it to the manifest too.
- Everything else (contact info, usage data, diagnostics, location, etc.): **not collected**. No analytics or crash SDKs are included.
- Tracking: **No** (`NSPrivacyTracking` false, no tracking domains).

## 4. Age rating

Answer the questionnaire for what the app itself shows: a remote control for a coding agent running on your own computer.

- Violence, sexual content, profanity, horror, drugs, gambling, contests, medical: **None / No**.
- Unrestricted web access: **No** (the web view loads only your paired computer's UI; other links open in Safari).
- User-generated content shared with other users / messaging between users: **No** (it talks only to your own computers).
- If the form asks about AI assistants or chatbots that can produce unfiltered content: **Yes, infrequent** is the honest answer, because pi relays the output of the language model your computer uses. Expect **13+** (or the lowest rating the form allows with that answer).

## 5. Export compliance (encryption)

`ITSAppUsesNonExemptEncryption` is deliberately **not** in Info.plist, so App Store Connect asks on the first upload. Suggested answers, with the reasoning:

- Does your app use encryption? **Yes**. Besides HTTPS (Apple's), the app implements end-to-end encryption itself with libsodium (XSalsa20-Poly1305 secretbox) to talk to your own computer.
- Does it use proprietary or non-standard algorithms? **No**. XSalsa20-Poly1305 is a published, standard construction.
- Does it implement standard algorithms instead of, or in addition to, Apple's OS encryption? **Yes** (libsodium).
- The likely outcome: a mass-market item (US ECCN 5D992.c, EU dual-use "mass market" note). App Store Connect may then ask for documentation or an annual self-classification report to the US BIS. Follow its prompts; if unsure, ask Apple via the export compliance contact before answering. After the first answers Apple shows a key you can add to Info.plist so later uploads skip the question.

The old `ITSAppUsesNonExemptEncryption: false` was removed because "exempt" isn't clearly true for an app that ships its own cipher; answering the questionnaire once is the safe route.

## 6. Screenshots to take

6.9" (iPhone 17 Pro Max class, 1320×2868) is required; 6.5" is optional. Use a real paired computer or the `npm run ui` fixture, light mode and dark mode where it helps:

1. A session with a conversation and steps (the web UI in the app).
2. pi asks a question: the question card raised.
3. Voice mode, listening (the orb) with a caption.
4. Voice mode asking, with the question card.
5. The Live Activity on the lock screen and the Dynamic Island.
6. Dictation in the composer with the raw / undo chips.
7. Sessions list grouped Needs you / Working / Idle across two computers.
8. The pairing screen (Scan code).

The simulator shots in `shots/` (`voice/`, `activity/`, `e2e/`) show the states; retake them at the required size (`xcrun simctl io <id> screenshot`).

## 7. Review notes (draft)

Paste into App Review Information → Notes, with a contact phone and email:

> pi mobile is a remote control for pi, an open-source coding agent that runs on the user's own computer (https://github.com/jkeskikangas/pi-mobile). There is no account and no server run by us: the app pairs with the user's computer by scanning a QR code, and all traffic between phone and computer is end-to-end encrypted.
>
> **To test:** we run a demo computer for you. Open the app, tap Paste link and paste: `<DEMO PAIRING LINK>` (or scan the attached QR code). It opens the demo's sessions. Try: open a session, send a message, tap the waveform button for voice mode, and the microphone in the composer for dictation. The first voice mode asks for consent to send audio to OpenAI (guideline 5.1.2(i)).
>
> **Background audio (2.5.4):** the audio background mode is used only during voice mode, a hands-free spoken conversation the user starts (in the app, from the Action button / Siri, or from a notification) and can end any time. While it runs a Live Activity shows the state with Mute and End, and the microphone indicator is on. Without voice mode the app records nothing in the background.
>
> **Native features (4.2):** beyond the web UI it hosts, the app adds: QR pairing with the camera (VisionKit); keys in the Keychain; native voice mode (WebRTC realtime audio with Apple voice processing, echo cancellation, earcons, haptics); native dictation; a Live Activity and Dynamic Island with Mute/End intents; App Shortcuts, Siri and a Control Center / Action button control to start voice; push notifications decrypted on device by a Notification Service Extension, with "Answer by voice"; VoiceOver and Dynamic Type throughout the native screens.
>
> **Network:** HTTPS only; no App Transport Security exceptions.
>
> **Code (2.5.2):** the app runs no downloaded code. The web UI shown in WKWebView comes from the user's own computer, and the voice decision logic is bundled in the app.

### The demo computer for the reviewer

The reviewer's iPhone must reach a computer over **HTTPS** (the app refuses plain HTTP). Options:

- A small always-on box (a cheap VPS or a Raspberry Pi) running pi with this extension, exposed with **Tailscale Funnel** (`tailscale funnel <port>`, giving a public `https://<box>.<tailnet>.ts.net`), or behind any public HTTPS reverse proxy with `publicUrl` set in its pi-mobile config.
- Give it a harmless project and a model with spending limits; keep `/remote` sessions running so there is something to look at; set an OpenAI key or ChatGPT sign-in if you want realtime voice reviewed (else basic voice runs).
- **Open problem:** pairing codes are single-use and expire after 10 minutes (`PAIRING_TTL` in `src/hub.ts`), so a code in the review notes would be dead before a reviewer reads it. Before submitting, add a long-lived, revocable review pairing link to the hub (e.g. a `/remote review` command with a TTL of days and one device), or arrange a time with App Review. Revoke the reviewer's device afterwards.

## 8. TestFlight

1. Bump `MARKETING_VERSION` in `project.yml` when the user-visible version changes (now `1.0.0`); commit.
2. `DEVELOPMENT_TEAM=XXXXXXXXXX PI_BUNDLE_PREFIX=com.example PI_PUSH=YES scripts/release.sh <build number>` (the number must grow with every upload; the script refuses a dirty tree, checks the privacy manifest and ATS, archives and uploads).
3. App Store Connect → TestFlight: answer export compliance (§5) for the build; add yourself as an internal tester; install with the TestFlight app.
4. Run the Device checklist again on the TestFlight build (Release config: production APNs tokens, so the relay must push to production APNs for them; the phone sends `sandbox: false`).
5. External testers need a short beta review: fill in the test information with the review notes above.

## 9. Release gates

- [ ] **Required-reason APIs in SDKs.** The manifest covers the app's own code only. Audit the archived binary (`nm -um Pi.app/Pi`, and each framework) for required-reason symbols that come from dependencies: libsodium's `randombytes` calls `fstat` on `/dev/urandom` (the file-timestamp category), and swift-sodium ships no privacy manifest. Don't declare a reason that doesn't apply (e.g. C617.1/0A2A.1 are about files the app shows or owns); if Apple's upload or TestFlight email flags an API, act on that feedback: pick the reason that truly fits, or update/replace the SDK.
- [ ] The device checklist (README) is complete on a TestFlight build.
- [ ] `scripts/release.sh` passed its manifest and ATS checks.

## 10. Submit

- [ ] Device checklist complete on a TestFlight build.
- [ ] Screenshots, description, keywords, support and privacy URLs, age rating, App Privacy, export compliance done.
- [ ] Demo computer up, review pairing link valid for the review window.
- [ ] Select the build, add the review notes, submit. Manual release is the safer choice for 1.0.
