# Multi-machine sessions — Spec

**Status:** draft from the 2026-10-09 conversation; items marked [ASSUMPTION] need the owner's confirmation.

## Problem

The owner runs pi sessions on a laptop and plans to run more on an always-on cloud box (Hetzner). Today each machine is paired with the phone separately, so sessions are split across two home-screen apps. The owner wants one list, with each session clearly labelled by the machine it runs on.

## Actors

- **Owner**: one person with one or more phones.
- **Machine**: a computer running pi with pi-mobile (laptop, cloud box). Exactly one machine is the **home**: the one the phone pairs with and talks to.

## Use cases

- **UC-1 Link a machine.** Once per machine, the owner links it to the home. No change on the phone.
- **UC-2 One labelled list.** The phone shows every shared session on every linked machine in one list. Each session shows which machine it runs on, and the list is still ordered by who needs the owner.
- **UC-3 Machines come and go.** When a linked machine goes away (laptop asleep, network change), the phone shows that machine as offline instead of silently dropping its sessions. When it returns, its sessions reappear by themselves.
- **UC-4 Same controls everywhere.** Everything the phone can do with a home session works the same for a linked machine's session: transcript, prompt, steer, stop, dialogs, model, compact.
- **UC-5 One attention channel.** A session on any machine that finishes or asks reaches the phone's lock screen through the home's notifications. Typing at any machine's pi terminal holds notifications, as it does today on one machine.
- **UC-6 Start a session on a chosen machine.** The new-session sheet lets the owner pick which machine (only those running herdr) and which folder there.
- **UC-7 Unlink.** The owner can unlink a machine from the home; it loses access immediately.

## Invariants

- **INV-1** Content is end-to-end encrypted on every hop: phone↔home and machine↔home. No transport or relay sees plaintext.
- **INV-2** A linked machine gains no control over sessions on the home or on other machines. It can only publish its own sessions and answer requests for them.
- **INV-3** A setup with one machine and no links behaves exactly as today.
- **INV-4** Every session is unambiguously identified and routed even when two machines have similar names or folders.

## Non-functional

- **NFR-1** After a machine reconnects, its sessions are back on the phone within 10 s.
- **NFR-2** No new infrastructure, account or third-party service. [ASSUMPTION] Linked machines reach the home over Tailscale or a LAN; the home needs no public address.
- **NFR-3** Hub failover still works on both sides: whichever pi hosts a machine's hub keeps that machine linked.
- **NFR-4** herdr stays optional (UC-6 is the only herdr-dependent part).

## Out of scope

- Phones pairing with several homes and merging them on the phone.
- Linked machines reaching each other directly; the topology is a star around the home.
- Transcripts of sessions on machines that are offline.
