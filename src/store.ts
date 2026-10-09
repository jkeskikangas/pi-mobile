// Machine-wide state shared by every pi process: config, paired devices, and the local link secret.

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b64u, randomKey } from "./crypto.ts";
import { generateVapid, type PushSubscriptionJSON, type Vapid } from "./webpush.ts";

export type Expose = "network" | "local" | "cloudflared";
export type Role = "control" | "view";

export interface Config {
	/** Port of the hub's HTTP server. Also the election lock: whichever pi binds it hosts the hub. */
	port: number;
	/** network: all interfaces (LAN + Tailscale); local: loopback only; cloudflared: loopback + quick tunnel. */
	expose: Expose;
	/** Share every new pi session automatically. */
	autoStart: boolean;
	/**
	 * HTTPS address that proxies to the hub (Tailscale Serve, a reverse proxy). Listed first in the
	 * QR code. Lock-screen notifications need an HTTPS origin.
	 */
	publicUrl?: string;
}

export interface Device {
	id: string;
	name: string;
	key: string;
	role: Role;
	createdAt: number;
	lastSeenAt?: number;
}

export const DEFAULT_CONFIG: Config = { port: 7878, expose: "network", autoStart: false };

export function stateDir(): string {
	const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const dir = join(base, "pi-mobile");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writePrivate(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function loadConfig(dir = stateDir()): Config {
	const raw = readJson<Partial<Config>>(join(dir, "config.json"), {});
	const config: Config = { ...DEFAULT_CONFIG, ...raw };
	if (!["network", "local", "cloudflared"].includes(config.expose)) config.expose = DEFAULT_CONFIG.expose;
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) config.port = DEFAULT_CONFIG.port;
	return config;
}

export function saveConfig(config: Config, dir = stateDir()): void {
	writePrivate(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Devices are re-read when the file changes, so a revoke in any process takes effect in the hub. */
export class DeviceStore {
	private cache: Device[] = [];
	private mtime = -1;
	private readonly path: string;

	constructor(dir = stateDir()) {
		this.path = join(dir, "devices.json");
	}

	list(): Device[] {
		let m = 0;
		try {
			m = statSync(this.path).mtimeMs;
		} catch {
			m = 0;
		}
		if (m !== this.mtime) {
			this.mtime = m;
			this.cache = m ? readJson<Device[]>(this.path, []) : [];
		}
		return this.cache;
	}

	get(id: string): Device | undefined {
		return this.list().find((d) => d.id === id);
	}

	private save(devices: Device[]): void {
		writePrivate(this.path, `${JSON.stringify(devices, null, 2)}\n`);
		this.cache = devices;
		this.mtime = statSync(this.path).mtimeMs;
	}

	add(device: Device): void {
		this.save([...this.list().filter((d) => d.id !== device.id), device]);
	}

	remove(ids: string[]): Device[] {
		const all = this.list();
		const removed = all.filter((d) => ids.includes(d.id));
		if (removed.length) this.save(all.filter((d) => !ids.includes(d.id)));
		return removed;
	}

	touch(id: string, now = Date.now()): void {
		const all = this.list();
		const d = all.find((x) => x.id === id);
		// Throttled: last-seen only needs minute resolution.
		if (!d || (d.lastSeenAt && now - d.lastSeenAt < 60_000)) return;
		this.save(all.map((x) => (x.id === id ? { ...x, lastSeenAt: now } : x)));
	}
}

/** Secret that authenticates pi processes to the hub over loopback; readable only by this user. */
export function linkSecret(dir = stateDir()): string {
	const path = join(dir, "link.secret");
	try {
		const s = readFileSync(path, "utf8").trim();
		if (s.length >= 32) return s;
	} catch {}
	try {
		writeFileSync(path, b64u(randomKey()), { mode: 0o600, flag: "wx" });
	} catch {}
	return readFileSync(path, "utf8").trim();
}

/** VAPID keys and each device's push subscription. Only the hub writes it. */
export class PushStore {
	private readonly path: string;
	private state: { vapid: Vapid; subs: Record<string, PushSubscriptionJSON> };

	constructor(dir = stateDir()) {
		this.path = join(dir, "push.json");
		const raw = readJson<{ vapid?: Vapid; subs?: Record<string, PushSubscriptionJSON> }>(this.path, {});
		this.state = { vapid: raw.vapid ?? generateVapid(), subs: raw.subs ?? {} };
		if (!raw.vapid) this.save();
	}

	get vapid(): Vapid {
		return this.state.vapid;
	}

	entries(): [string, PushSubscriptionJSON][] {
		return Object.entries(this.state.subs);
	}

	set(deviceId: string, sub: PushSubscriptionJSON | undefined): void {
		if (sub) this.state.subs[deviceId] = sub;
		else delete this.state.subs[deviceId];
		this.save();
	}

	private save(): void {
		writePrivate(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
	}
}
