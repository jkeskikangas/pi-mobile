# pi mobile privacy policy

_Last updated: 11 October 2026. Applies to the pi iPhone app and the pi-mobile extension. Web address: https://github.com/jkeskikangas/pi-mobile/blob/main/PRIVACY.md_

## The short version

**The developer of pi collects nothing.** There is no account, no analytics, no tracking, no advertising and no server run by the developer. The app talks only to computers you pair it with, to OpenAI when you use voice mode, and to Apple when you turn on notifications.

## Where your data goes

| What | Goes to | Why |
|---|---|---|
| Your messages, sessions, answers, images and dictated text | **Your own computers** running pi, the ones you paired | That is the app's job: it is a remote control for pi on your computer. Everything between the phone and your computer is end-to-end encrypted with a key made at pairing; nothing in between can read it. |
| Your voice in **voice mode** | **OpenAI**, directly from your phone (realtime speech), using your computer's ChatGPT sign-in or OpenAI API key; and **your computer**, which gets what you say and pi's replies | To hold a spoken conversation. OpenAI processes the audio under [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/). If realtime voice isn't available, voice mode uses basic voice and the audio goes only to your computer. |
| Your recording in **dictation** | **Your computer**, which turns it into text with the speech provider it is set up with (that may be OpenAI) | To turn speech into text you can review before sending. |
| A notification (only if you turn notifications on) | **Apple's push service**, sent by your computer | So you hear when pi finishes or needs you. Apple sees only "pi · New activity"; the real text is sealed with your device key and opened on the phone. |

The app asks before voice mode or dictation sends any audio, and names these recipients. You can take that back at any time: voice settings → Stop sharing my voice, or the menu → Voice.

## What stays on your phone

- The list of paired computers and their keys: in the iOS Keychain.
- Your voice preferences, notification setting, the last session you looked at and your consent answer: in the app's own settings storage (UserDefaults).
- Nothing else is stored by the app outside the web view's own cache.

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
