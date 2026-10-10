# Multi-machine sessions — Spec

**Status:** v2, 2026-10-10, written from first principles after the owner described the real setup; replaces the v1 "home hub" spec (git history). Items marked [ASSUMPTION] need the owner's confirmation.

## Problem

The owner works on a laptop running herdr and pi. From that laptop they ask pi to create cloud boxes (Hetzner), today one and next week another, and some boxes are deleted again. pi sessions run on all of them. The owner wants every session on every machine in one list on the phone, labelled by machine, with lock-screen notifications from all of them. Adding a machine must be as close to zero effort as an Apple device joining your account. The laptop sleeps often; the boxes never do.

## Actors

- **Owner:** one person with one or more phones.
- **Machine:** a computer running pi with pi-mobile (the laptop, a cloud box). No machine is special.
- **Trusted machine:** a machine the owner's phone already has.

## Use cases

- **UC-1 First machine.** The owner runs `/remote` and scans one QR code, as today. Nothing else changes for a single machine.
- **UC-2 Add a machine from a trusted one.** The owner, or pi acting for the owner, adds a machine it can reach over SSH (`/remote add box`). The phone asks once, "Add box?", and box's sessions appear. No QR code, no copying keys, nothing to type on the phone.
- **UC-3 Add a machine without a trusted path.** The owner adds a machine no trusted machine can reach, with one scan or paste from inside the app (Add a computer).
- **UC-4 One labelled list.** The phone shows every session on every machine in one list, ordered by who needs the owner. Each session shows its machine whenever more than one machine is known.
- **UC-5 Machines sleep and wake.** A machine that can't be reached shows as offline ("laptop · offline since 14:02"). Its sessions return by themselves within 10 s of it coming back. Every other machine keeps working, and so do its notifications.
- **UC-6 Same controls everywhere.** Everything the phone can do with a session works the same on every machine: transcript, prompt, steer, stop, dialogs, model, compact, voice.
- **UC-7 Notifications from every machine.** A session on any machine that finishes or asks reaches the lock screen, even while other machines are asleep or gone.
- **UC-8 Start a session on a chosen machine.** The new-session sheet offers machines running herdr.
- **UC-9 Remove a machine.** From the phone, or with `/remote remove box` on any trusted machine (pi runs it when it deletes a box). The machine loses access immediately; a deleted box disappears from the list.
- **UC-10 Voice across machines.** Voice mode can switch to a session on any machine mid-call, and speech works even if a session's machine has no voice credentials.

## Invariants

- **INV-1** Content is end-to-end encrypted between the phone and each machine. No relay, transport or other machine sees another machine's plaintext.
- **INV-2** Machines have no power over each other. A machine can't read or drive another machine's sessions. A machine adding another is the only cross-machine action, and it needs the phone's consent.
- **INV-3** A single machine behaves exactly as today, and existing pairings keep working without a re-scan.
- **INV-4** A machine joins only with the owner's explicit consent on a trusted device. A machine can't enrol itself, and a QR code shown to the owner can't enrol one.
- **INV-5** No machine is a single point of failure. Any one machine being asleep or deleted affects only its own sessions.

## Non-functional

- **NFR-1** A machine that comes back has its sessions on the phone within 10 s.
- **NFR-2** No new infrastructure, account or third-party service. [ASSUMPTION] Every machine after the first is reachable from the phone over Tailscale with HTTPS (`tailscale serve`). The first machine may stay on a LAN address.
- **NFR-3** Adding a machine from a trusted one takes one command (or one request to pi) and one tap on the phone.
- **NFR-4** A command or script can drive every machine operation (add, remove, status) without prompts, so pi can do it while provisioning.
- **NFR-5** herdr stays optional.

## Out of scope

- Transcripts of sessions on machines that are offline.
- Machines on networks the phone can't reach (no relay, by design).
- Provisioning cloud boxes. pi or herdr does that; pi-mobile only adds a machine that already exists.
