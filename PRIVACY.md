# pi mobile privacy policy

_Last updated: 11 October 2026. Applies to the pi iPhone app and the pi-mobile extension. Web address: https://github.com/jkeskikangas/pi-mobile/blob/main/PRIVACY.md_

## The short version

**The developer of pi collects nothing.** There is no account, no analytics, no tracking and no advertising. The app talks to computers you pair it with, to OpenAI when you use voice mode, and, only if you turn notifications on, to the pi push relay and Apple. The relay is the one server run by the developer: it only forwards sealed notifications it can't read (details in `relay/README.md`).

## Where your data goes

| What | Goes to | Why |
|---|---|---|
| Your messages, sessions, answers, images and dictated text | **Your own computers** running pi, the ones you paired | That is the app's job: it is a remote control for pi on your computer. Everything between the phone and your computer is end-to-end encrypted with a key made at pairing; nothing in between can read it. |
| Your voice in **voice mode** | **OpenAI**, directly from your phone (realtime speech), using your computer's ChatGPT sign-in or OpenAI API key, together with the session's recent messages and tool results that your computer gives the realtime model as context; and **your computer**, which gets what you say and pi's replies | To hold a spoken conversation. OpenAI processes this under [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/) and your OpenAI or ChatGPT account. |
| Your voice in **basic voice** (when realtime voice isn't available) | **Your computer**, which turns it into text and may speak replies using the speech services it is set up with (OpenAI or another provider) | Voice mode without the realtime model. |
| Your recording in **dictation** | **Your computer**, which transcribes it with its speech service and tidies the text with its AI model (either may be OpenAI or another provider) | To turn speech into text you can review before sending. |
| A notification (only if you turn notifications on) | **Apple's push service**. In the App Store app it goes through **the pi push relay**, an open-source Cloudflare Worker (`relay/` in the repository) run by the developer; self-built apps can push from your computer directly | So you hear when pi finishes or needs you. The relay (and Cloudflare, which hosts it) handles your phone's push token and the sealed notification, which it can't read; Apple sees only "pi · New activity". The real text is sealed with your device key and opened on the phone. What the relay stores and for how long is described in `relay/README.md`. |

The app asks before voice mode or dictation sends any audio, and names these recipients. You can take that back at any time: voice settings → Stop sharing my voice, or the menu → Voice.

## What stays on your phone

- The list of paired computers and their keys: in the iOS Keychain.
- Your voice preferences, notification setting, the last session you looked at and your consent answer: in the app's own settings storage (UserDefaults).
- The web view's storage (localStorage) holds a copy of the paired computers and their keys, rewritten from the Keychain each time the app opens, plus the web app's own settings; the web view also caches the web app's files.
- A dictation recording is written to a temporary file while you record and deleted once it has been sent or cancelled.
- Nothing else is stored by the app.

Your computers keep their own data (sessions, the list of paired devices, any push token) under your control; see the project README.

## Deleting your data

- **Unpair** a computer in the menu (Unpair this device, or remove a computer), or revoke the phone from the computer with `/remote`.
- **Delete the app** to remove everything it stored on the phone. (Keychain entries may survive an app deletion on some iOS versions; unpairing first removes them.)
- For audio already sent to OpenAI, see OpenAI's privacy policy and your OpenAI account settings.

## Children

pi is a tool for software developers and is not directed at children.

## Changes

If the app ever sends data to someone new, this page changes first and the app asks for your consent again.

## Contact

Open an issue at https://github.com/jkeskikangas/pi-mobile/issues.
