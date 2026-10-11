#!/usr/bin/env node
// pi-mobile machine commands. Plain JavaScript with no dependencies, so `npx pi-mobile` runs on a
// fresh box before pi or its TypeScript loader is there (Node won't strip types inside node_modules).
// It writes the same files the hub reads (src/store.ts); test/machines.test.ts pins that contract.
//
//   pi-mobile add <ssh-host> [--allow-origin] [--json]   add a machine you can ssh to; your phone approves it
//   pi-mobile remove <name>                              remove a machine from your phone's list
//   pi-mobile machines [--json]                          machines added from this computer
//   pi-mobile enrol                                      (run by `add` on the new machine; JSON on stdin)
//
// Keys travel only over stdin/stdout of the ssh session, never on a command line.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureServe, tailnetName } from "./tailscale.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const DEFAULT_CONFIG = { port: 7878, enabled: false };

export function stateDir() {
	const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const dir = join(base, "pi-mobile");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const randomId = (n = 9) => b64u(randomBytes(n));
function readJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}
function writePrivate(path, value) {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** A name people recognise: macOS's Computer Name rather than a generated host name (as src/store.ts). */
export function machineName() {
	if (process.platform === "darwin") {
		try {
			const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
			if (name) return name;
		} catch {}
	}
	return hostname().replace(/\.local$/, "");
}
/** This machine's stable id and name (`machine.json`, shared with src/store.ts `machineIdentity`). */
export function machine(dir = stateDir()) {
	const path = join(dir, "machine.json");
	const m = readJson(path, {});
	if (!m.id) {
		m.id = randomId();
		writePrivate(path, m);
	}
	return { id: m.id, name: m.name || machineName() };
}

/** The HTTPS address phones use: Tailscale Serve in front of the hub, found or set up as the hub does. */
async function httpsOrigin(config, cli) {
	if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
	if (config.tailscale === false) throw new Error("this machine has no HTTPS address: set publicUrl in its pi-mobile config.json, or allow Tailscale");
	if (!(await tailnetName(cli))) throw new Error("Tailscale isn't running on this machine. Install it, run `tailscale up`, then try again.");
	const r = await ensureServe(config.port, cli);
	if (r.url) return r.url;
	if (r.enable) throw new Error(`Your tailnet needs HTTPS turned on first: open ${r.enable}, then try again.`);
	throw new Error("Couldn't put pi-mobile behind Tailscale HTTPS. Run `sudo tailscale set --operator=$USER` on this machine, then try again.");
}

/**
 * On the new machine: one device per phone of the sponsor, the fleet's push key and the phones'
 * subscriptions, sharing switched on. Works before any pi runs here; the hub reads these files.
 * `cli` stands in for the tailscale CLI in tests.
 */
export async function enrol(input, dir = stateDir(), cli) {
	const phones = Array.isArray(input?.phones) ? input.phones : [];
	if (!phones.length) throw new Error("no phones to add");
	const config = { ...DEFAULT_CONFIG, ...readJson(join(dir, "config.json"), {}) };
	const origin = input.origin || (await httpsOrigin(config, cli));
	if (!config.enabled) writePrivate(join(dir, "config.json"), { ...config, enabled: true });

	const pushPath = join(dir, "push.json");
	const push = readJson(pushPath, {});
	const subs = push.subs || {};
	const vapid = input.vapid;
	if (vapid?.publicKey && vapid?.privateKey) {
		// Every machine signs notifications with the same key, so one phone subscription serves all.
		if (push.vapid && push.vapid.publicKey !== vapid.publicKey && Object.keys(subs).length && !input.force)
			throw new Error("this machine already sends notifications to other phones with a different key; add --force to replace it");
		push.vapid = vapid;
	}
	const devicesPath = join(dir, "devices.json");
	const devices = readJson(devicesPath, []);
	const now = Date.now();
	const made = phones.map((p) => {
		const d = { id: randomId(), name: String(p.name || "phone").slice(0, 60), key: b64u(randomBytes(32)), role: "control", createdAt: now };
		devices.push(d);
		if (p.sub?.endpoint) subs[d.id] = p.sub;
		return { phone: p.id, d: d.id, k: d.key };
	});
	writePrivate(devicesPath, devices);
	writePrivate(pushPath, { ...push, subs });
	return { machine: machine(dir), origin, version: VERSION, devices: made };
}

/** Offers wait for each phone in their own files, so the hub and this command never race on one file. */
function offersDir(dir) {
	const d = join(dir, "offers");
	mkdirSync(d, { recursive: true, mode: 0o700 });
	return d;
}
function writeOffer(dir, offer) {
	writePrivate(join(offersDir(dir), `${offer.id}.json`), offer);
}
const machinesPath = (dir) => join(dir, "machines.json");
export function knownMachines(dir = stateDir()) {
	return readJson(machinesPath(dir), []);
}

/** Runs `enrol` on `host` over ssh; the JSON input goes on stdin. Replaceable in tests. */
function runRemote(host, input) {
	const command = process.env.PI_MOBILE_ENROL || `npx -y pi-mobile@${VERSION} enrol`;
	const ssh = process.env.PI_MOBILE_SSH || "ssh";
	return new Promise((resolve, reject) => {
		const child = spawn(ssh, ["-o", "BatchMode=yes", host, "--", command], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => reject(new Error(`couldn't run ${ssh}: ${e.message}`)));
		child.on("close", (code) => {
			const last = out.trim().split("\n").pop() || "";
			let result;
			try {
				result = JSON.parse(last);
			} catch {}
			if (result?.error) return reject(new Error(result.error));
			if (code !== 0 || !result) return reject(new Error((err || out).trim().split("\n").slice(-3).join(" ") || `ssh exited with ${code}`));
			resolve(result);
		});
		child.stdin.end(JSON.stringify(input));
	});
}

/** On a trusted machine: enrol `host` for every phone paired here; each phone then asks "Add <name>?". */
export async function add(host, opts = {}, dir = stateDir()) {
	const phones = readJson(join(dir, "devices.json"), []).filter((d) => d.role === "control");
	if (!phones.length) throw new Error("no phone is paired with this computer yet. Run /remote in pi and scan the code first.");
	const push = readJson(join(dir, "push.json"), {});
	if (!push.vapid) throw new Error("this computer's hub hasn't run yet. Start pi here once, then try again.");
	const from = machine(dir);
	const input = {
		from: from.name,
		vapid: push.vapid,
		phones: phones.map((p) => ({ id: p.id, name: p.name, sub: push.subs?.[p.id] })),
		...(opts.origin ? { origin: opts.origin } : {}),
	};
	const result = await (opts.run || runRemote)(host, input);
	const origin = String(result?.origin || "");
	if (!/^https:\/\//.test(origin)) throw new Error(`${host} gave no HTTPS address (${origin || "none"})`);
	const mine = opts.tailnet !== undefined ? opts.tailnet : await tailnetName();
	const suffix = mine?.split(".").slice(1).join(".");
	if (suffix && !new URL(origin).hostname.endsWith(`.${suffix}`) && !opts.allowOrigin)
		throw new Error(`${origin} isn't on your tailnet (${suffix}). Add --allow-origin if you meant it.`);
	if (result.machine?.id === from.id) throw new Error(`${host} is this computer`);
	const now = Date.now();
	for (const dev of result.devices || []) {
		if (!phones.some((p) => p.id === dev.phone)) continue;
		writeOffer(dir, { id: randomId(), device: dev.phone, kind: "add", machine: result.machine, origin, d: dev.d, k: dev.k, from: from.name, createdAt: now });
	}
	const list = knownMachines(dir).filter((m) => m.id !== result.machine.id);
	list.push({ id: result.machine.id, name: result.machine.name, origin, host, addedAt: now });
	writePrivate(machinesPath(dir), list);
	return { machine: result.machine, origin, phones: phones.map((p) => p.name) };
}

/** On a trusted machine: every phone forgets `nameOrId` and revokes its own key there. */
export function remove(nameOrId, dir = stateDir()) {
	const list = knownMachines(dir);
	const q = String(nameOrId).toLowerCase();
	const hit = list.find((m) => m.id === nameOrId || m.name.toLowerCase() === q || String(m.host).toLowerCase() === q);
	if (!hit) throw new Error(`no machine called ${nameOrId} was added from here (see: pi-mobile machines)`);
	const now = Date.now();
	for (const p of readJson(join(dir, "devices.json"), []).filter((d) => d.role === "control"))
		writeOffer(dir, { id: randomId(), device: p.id, kind: "remove", machine: { id: hit.id, name: hit.name }, from: machine(dir).name, createdAt: now });
	writePrivate(
		machinesPath(dir),
		list.filter((m) => m !== hit),
	);
	return { machine: { id: hit.id, name: hit.name } };
}

/** Offers older than a week are dropped (the hub does this too; here for machines without a hub). */
export function pruneOffers(dir = stateDir(), now = Date.now()) {
	for (const f of readdirSync(offersDir(dir))) {
		const o = readJson(join(offersDir(dir), f), null);
		if (!o || now - o.createdAt > 7 * 24 * 3600_000) {
			try {
				unlinkSync(join(offersDir(dir), f));
			} catch {}
		}
	}
}

async function readStdin() {
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return JSON.parse(text || "{}");
}

async function main(argv) {
	const [cmd, ...rest] = argv;
	const flag = (f) => rest.includes(f);
	const arg = rest.find((a) => !a.startsWith("--"));
	const json = flag("--json");
	switch (cmd) {
		case "enrol":
		case "enroll": {
			try {
				console.log(JSON.stringify(await enrol(await readStdin())));
			} catch (e) {
				console.log(JSON.stringify({ error: e.message }));
				process.exitCode = 1;
			}
			return;
		}
		case "add": {
			if (!arg) throw new Error("usage: pi-mobile add <ssh-host>");
			const r = await add(arg, { allowOrigin: flag("--allow-origin") });
			if (json) return console.log(JSON.stringify(r));
			console.log(`Added ${r.machine.name} (${r.origin}).`);
			console.log(`Your phone${r.phones.length > 1 ? "s" : ""} will ask to add it: ${r.phones.join(", ")}.`);
			return;
		}
		case "remove": {
			if (!arg) throw new Error("usage: pi-mobile remove <name>");
			const r = remove(arg);
			if (json) return console.log(JSON.stringify(r));
			console.log(`Removing ${r.machine.name}: your phone forgets it next time it connects.`);
			return;
		}
		case "machines": {
			const list = knownMachines();
			if (json) return console.log(JSON.stringify(list));
			if (!list.length) return console.log("No machines added from this computer.");
			for (const m of list) console.log(`${m.name}\t${m.origin}\t(ssh ${m.host})`);
			return;
		}
		default:
			console.log("usage: pi-mobile add <ssh-host> | remove <name> | machines");
			if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
	}
}

// Run as a command (npx links it from node_modules/.bin), not when imported by tests.
const invoked = (() => {
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();
if (invoked) {
	main(process.argv.slice(2)).catch((e) => {
		console.error(`pi-mobile: ${e.message}`);
		process.exitCode = 1;
	});
}
