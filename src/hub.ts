// The hub: one HTTP server per machine that every sharing pi process links to over loopback.
// Phones talk only to the hub, through an end-to-end encrypted API; the hub routes requests
// to the right pi process and fans its events out with a replay buffer for flaky connections.
//
// Election: whichever process binds the configured port hosts the hub. When it exits, the other
// processes' links drop, and one of them binds the port and takes over (see bridge.ts).

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { extname, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Channel } from "./channel.ts";
import { b64u, open, randomId, randomKey, ReplayGuard, seal, unb64u } from "./crypto.ts";
import { type Address, type Endpoint, privateAddresses, type ServeResult, startCloudflared, type Tunnel } from "./expose.ts";
import { type AgentEvent, type AgentInfo, type HubEvent, PROTOCOL } from "./protocol.ts";
import { type Config, type Device, DeviceStore, PushStore, type Role } from "./store.ts";
import { type PushSubscriptionJSON, sendPush } from "./webpush.ts";

export const LINK_PROTOCOL = "pi-mobile-link";
const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const NACL_JS = createRequire(import.meta.url).resolve("tweetnacl/nacl-fast.min.js");
// Shared by all sessions; at ten busy agents this still covers a few minutes of reconnect gap.
const RING = 20_000;
/** No lock-screen pushes while someone typed into a pi terminal on this machine this recently. */
const PRESENCE_MS = 2 * 60_000;
/** Events every phone gets about every session; the rest only for the session it is looking at. */
const GLOBAL_EVENTS = new Set(["info", "gone", "prompt", "prompt_end"]);
const MAX_BODY = 25 * 1024 * 1024;
const PAIRING_TTL = 10 * 60_000;
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
};

interface AgentConn {
	ch: Channel;
	info: AgentInfo;
}

interface StreamClient {
	id: string;
	/** The session this phone is looking at; its detailed events are sent only for that one. */
	focus?: string;
	device: Device;
	res: ServerResponse;
	queue: unknown[];
	flush?: NodeJS.Timeout;
}

interface Pairing {
	id: string;
	key: Uint8Array;
	role: Role;
	expiresAt: number;
}

export interface HubOptions {
	config: Config;
	secret: string;
	devices?: DeviceStore;
	push?: PushStore;
	/** Replaceable in tests; defaults to the real Web Push sender. */
	sendPush?: typeof sendPush;
	/** Called when a linked pi asks the hub to restart, e.g. after a port or exposure change. */
	onRestart?: () => void;
	/** Called once the hub has been without linked agents for `idleMs`. */
	onIdle?: () => void;
	idleMs?: number;
	/** Finds or sets up an HTTPS address in front of the hub (Tailscale Serve); off when absent. */
	serve?: (port: number) => Promise<ServeResult>;
}

export class Hub {
	readonly id = randomId();
	readonly config: Config;
	/** Loopback listener: also the election lock and the only one that accepts pi links. */
	private server: Server;
	/** `network` mode: one listener per private address, kept in step with the interfaces. */
	private extra = new Map<string, { server: Server; label: string }>();
	private ifaceTimer?: NodeJS.Timeout;
	private readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
	private agents = new Map<string, AgentConn>();
	private clients = new Set<StreamClient>();
	private ring: HubEvent[] = [];
	private seq = 0;
	private pairings = new Map<string, Pairing>();
	private replay = new ReplayGuard();
	private devices: DeviceStore;
	private push: PushStore;
	private secret: Buffer;
	private tunnel?: Tunnel;
	private tunnelError?: string;
	/** HTTPS address from Tailscale Serve, used when no `publicUrl` is configured. */
	private served?: string;
	/** One-click link that enables Serve on the tailnet, while pi waits for it. */
	private serveEnable?: string;
	private serveRun?: Promise<void>;
	private serveAt = 0;
	private heartbeat?: NodeJS.Timeout;
	private idleTimer?: NodeJS.Timeout;
	private closed = false;
	private lastPresence = 0;
	private readonly opts: HubOptions;

	constructor(opts: HubOptions) {
		this.opts = opts;
		this.config = opts.config;
		this.secret = Buffer.from(opts.secret);
		this.devices = opts.devices ?? new DeviceStore();
		this.push = opts.push ?? new PushStore();
		this.handler = (req, res) => {
			this.handle(req, res).catch((e) => {
				if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
				else res.destroy();
			});
		};
		this.server = createServer(this.handler);
		this.server.on("upgrade", (req, socket) => this.upgrade(req, socket));
	}

	/** Binds the port; rejects with EADDRINUSE when another process already hosts the hub. */
	async listen(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onError = (e: Error) => reject(e);
			this.server.once("error", onError);
			this.server.listen(this.config.port, "127.0.0.1", () => {
				this.server.off("error", onError);
				resolve();
			});
		});
		this.server.unref();
		if (this.config.expose === "network") {
			this.syncInterfaces();
			// Wi-Fi changes, VPNs and `tailscale up` come and go; follow them.
			this.ifaceTimer = setInterval(() => this.syncInterfaces(), 10_000);
			this.ifaceTimer.unref();
		}
		this.heartbeat = setInterval(() => this.ping(), 15_000);
		this.heartbeat.unref();
		this.armIdle();
		void this.syncServe();
		if (this.config.expose === "cloudflared") {
			startCloudflared(this.config.port).then(
				(t) => {
					if (this.closed) return t.stop();
					this.tunnel = t;
					this.broadcastToAgents({ t: "endpoints", endpoints: this.endpoints() });
				},
				(e) => {
					this.tunnelError = String(e?.message ?? e);
					this.broadcastToAgents({ t: "endpoints", endpoints: this.endpoints(), error: this.tunnelError });
				},
			);
		}
	}

	private syncInterfaces(addresses: Address[] = privateAddresses()): void {
		if (this.closed) return;
		const want = new Map(addresses.map((a) => [a.ip, a.label]));
		for (const [ip, l] of this.extra) {
			if (!want.has(ip)) {
				l.server.close();
				this.extra.delete(ip);
			}
		}
		for (const [ip, label] of want) {
			if (this.extra.has(ip)) continue;
			const server = createServer(this.handler);
			const entry = { server, label };
			this.extra.set(ip, entry);
			server.on("error", () => {
				if (this.extra.get(ip) === entry) this.extra.delete(ip);
			});
			server.listen(this.port, ip, () => server.unref());
		}
	}

	/**
	 * Looks up (or sets up) the Tailscale Serve address. Runs at start and before pairing or status,
	 * at most every 15 s; while the tailnet still has to enable Serve, it waits on that instead.
	 */
	syncServe(): Promise<void> {
		const serve = this.opts.serve;
		if (!serve || this.config.publicUrl || this.closed) return Promise.resolve();
		if (this.serveRun) return this.serveRun;
		if (this.serveEnable || Date.now() - this.serveAt < 15_000) return Promise.resolve();
		this.serveRun = serve(this.port)
			.then(
				(r) => {
					this.serveEnable = r.enable;
					this.setServed(r.url);
					r.pending?.then((url) => {
						this.serveEnable = undefined;
						this.serveAt = 0;
						if (url) this.setServed(url);
					});
				},
				() => {},
			)
			.finally(() => {
				this.serveRun = undefined;
				this.serveAt = Date.now();
			});
		return this.serveRun;
	}

	private setServed(url: string | undefined): void {
		if (url === this.served || this.closed) return;
		this.served = url;
		this.broadcastToAgents({ t: "endpoints", endpoints: this.endpoints() });
	}

	get port(): number {
		const a = this.server.address();
		return typeof a === "object" && a ? a.port : this.config.port;
	}

	endpoints(): Endpoint[] {
		const local = { label: "this computer", url: `http://127.0.0.1:${this.port}` };
		const pub = this.config.publicUrl
			? [{ label: "https", url: this.config.publicUrl.replace(/\/+$/, "") }]
			: this.served
				? [{ label: "tailscale https", url: this.served }]
				: [];
		if (this.config.expose === "cloudflared")
			return [...pub, ...(this.tunnel ? [{ label: "cloudflared", url: this.tunnel.url }] : []), local];
		if (this.config.expose === "local") return [...pub, local];
		const lan = [...this.extra].map(([ip, l]) => ({ label: l.label, url: `http://${ip}:${this.port}` }));
		return [...pub, ...lan.filter((e) => e.label === "tailscale"), ...lan.filter((e) => e.label !== "tailscale"), local];
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.heartbeat);
		clearInterval(this.ifaceTimer);
		for (const l of this.extra.values()) {
			l.server.close();
			l.server.closeAllConnections?.();
		}
		this.extra.clear();
		clearTimeout(this.idleTimer);
		this.tunnel?.stop();
		for (const c of this.clients) c.res.end();
		this.clients.clear();
		for (const a of this.agents.values()) a.ch.close();
		this.agents.clear();
		this.server.close();
		this.server.closeAllConnections?.();
	}

	// ── agent links ────────────────────────────────────────────────────────────────

	private upgrade(req: IncomingMessage, socket: Duplex): void {
		const given = Buffer.from(String(req.headers["x-pi-mobile-secret"] ?? ""));
		const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
		const ok =
			req.headers.upgrade === LINK_PROTOCOL &&
			loopback &&
			given.length === this.secret.length &&
			timingSafeEqual(given, this.secret);
		if (!ok) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${LINK_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`);
		const ch = new Channel(socket);
		let agentId: string | undefined;
		ch.onMessage = (msg) => {
			if (msg.t === "hello") {
				if (msg.protocol !== PROTOCOL) {
					ch.send({ t: "rejected", reason: `protocol ${msg.protocol} ≠ hub protocol ${PROTOCOL}; update pi-mobile everywhere` });
					ch.close();
					return;
				}
				agentId = msg.info.agent as string;
				const prev = this.agents.get(agentId);
				if (prev && prev.ch !== ch) prev.ch.close();
				this.agents.set(agentId, { ch, info: msg.info });
				clearTimeout(this.idleTimer);
				ch.send({ t: "welcome", hubId: this.id, pid: process.pid, endpoints: this.endpoints(), clients: this.clientSummary() });
				this.publish(agentId, { type: "info", info: msg.info });
			} else if (msg.t === "presence") {
				this.lastPresence = Date.now();
			} else if (msg.t === "attention" && agentId) {
				void this.attention(agentId, msg);
			} else if (msg.t === "ev" && agentId) {
				const ev = msg.ev as AgentEvent;
				const conn = this.agents.get(agentId);
				if (conn && ev.type === "info") conn.info = ev.info;
				this.publish(agentId, ev);
			}
		};
		ch.onRequest = (m, p) => this.agentRequest(m, p);
		ch.onClose = () => {
			if (!agentId || this.agents.get(agentId)?.ch !== ch) return;
			this.agents.delete(agentId);
			this.publish(agentId, { type: "gone" });
			this.armIdle();
		};
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.agents.size || !this.opts.onIdle) return;
		this.idleTimer = setTimeout(() => {
			if (!this.agents.size && !this.closed) this.opts.onIdle?.();
		}, this.opts.idleMs ?? 15_000);
		this.idleTimer.unref();
	}

	private agentRequest(m: string, p: any): unknown {
		switch (m) {
			case "pair":
				return this.syncServe().then(() => ({ ...this.createPairing(), serveEnable: this.serveEnable }));
			case "status":
				return this.syncServe().then(() => ({
					hubId: this.id,
					pid: process.pid,
					expose: this.config.expose,
					endpoints: this.endpoints(),
					serveEnable: this.serveEnable,
					tunnelError: this.tunnelError,
					agents: [...this.agents.values()].map((a) => a.info),
					clients: this.clientSummary(),
					devices: this.devices.list().map(publicDevice),
				}));
			case "restart":
				setTimeout(() => this.opts.onRestart?.(), 50);
				return { ok: true };
			case "revoke": {
				const ids: string[] = Array.isArray(p?.ids) ? p.ids : [];
				const removed = this.devices.remove(ids);
				for (const id of ids) this.push.set(id, undefined);
				this.dropStreams(ids);
				return removed.map(publicDevice);
			}
			default:
				throw new Error(`unknown hub request ${m}`);
		}
	}

	private broadcastToAgents(msg: unknown): void {
		for (const a of this.agents.values()) a.ch.send(msg);
	}

	createPairing(role: Role = "control"): { links: Endpoint[]; expiresAt: number; role: Role } {
		const now = Date.now();
		for (const [id, p] of this.pairings) if (p.expiresAt < now) this.pairings.delete(id);
		const pairing: Pairing = { id: randomId(), key: randomKey(), role, expiresAt: now + PAIRING_TTL };
		this.pairings.set(pairing.id, pairing);
		const fragment = `#p=${pairing.id}.${b64u(pairing.key)}`;
		return { links: this.endpoints().map((e) => ({ label: e.label, url: `${e.url}/${fragment}` })), expiresAt: pairing.expiresAt, role };
	}

	/**
	 * Lock-screen notification to every subscribed device. The payload is encrypted to each browser
	 * (RFC 8291), so the push service sees neither the session name nor the text.
	 */
	private async attention(agent: string, msg: { title?: string; body?: string; urgent?: boolean }): Promise<void> {
		if (Date.now() - this.lastPresence < PRESENCE_MS) return; // you are at a terminal here
		const payload = { title: String(msg.title ?? "pi"), body: String(msg.body ?? ""), agent };
		await Promise.all(
			this.push.entries().map(async ([id, sub]) => {
				if (!this.devices.get(id)) return this.push.set(id, undefined);
				const send = this.opts.sendPush ?? sendPush;
				if ((await send(sub, payload, this.push.vapid, msg.urgent ? "high" : "normal")) === "gone") this.push.set(id, undefined);
			}),
		);
	}

	// ── events ─────────────────────────────────────────────────────────────────────

	private publish(agent: string, ev: AgentEvent): void {
		const stamped = { ...ev, agent, seq: ++this.seq } as HubEvent;
		this.ring.push(stamped);
		if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
		for (const c of this.clients) if (wants(c, stamped)) this.enqueue(c, stamped);
	}

	private enqueue(c: StreamClient, ev: unknown): void {
		c.queue.push(ev);
		// Batch to keep per-message crypto and SSE framing overhead low during token streaming.
		c.flush ??= setTimeout(() => this.flush(c), 40);
	}

	private flush(c: StreamClient): void {
		c.flush = undefined;
		if (!c.queue.length) return;
		const batch = c.queue;
		c.queue = [];
		c.res.write(`data: ${seal(unb64u(c.device.key), batch)}\n\n`);
	}

	private ping(): void {
		for (const c of this.clients) c.res.write(": ping\n\n");
	}

	private clientSummary(): { count: number; names: string[] } {
		const names = [...new Set([...this.clients].map((c) => c.device.name))];
		return { count: this.clients.size, names };
	}

	private clientsChanged(): void {
		this.broadcastToAgents({ t: "clients", clients: this.clientSummary() });
	}

	private dropStreams(deviceIds: string[]): void {
		for (const c of [...this.clients]) {
			if (deviceIds.includes(c.device.id)) {
				c.res.end();
				this.clients.delete(c);
			}
		}
		this.clientsChanged();
	}

	// ── HTTP ───────────────────────────────────────────────────────────────────────

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://hub");
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		if (url.pathname === "/api/pair" && req.method === "POST") return this.pair(req, res);
		if (url.pathname === "/api/rpc" && req.method === "POST") return this.rpc(req, res);
		if (url.pathname === "/api/stream" && req.method === "GET") return this.stream(url, req, res);
		if (req.method === "GET" || req.method === "HEAD") return this.serveStatic(url.pathname, res);
		send(res, 404, { error: "not found" });
	}

	private async serveStatic(path: string, res: ServerResponse): Promise<void> {
		let file: string;
		if (path === "/" || path === "/index.html") file = join(WEB_DIR, "index.html");
		else if (path === "/nacl.js") file = NACL_JS;
		else {
			const rel = normalize(path).replace(/^([/\\])+/, "");
			if (rel.startsWith("..") || rel.includes("\0")) return send(res, 404, { error: "not found" });
			file = join(WEB_DIR, rel);
		}
		try {
			const body = await readFile(file);
			res.writeHead(200, {
				"content-type": MIME[extname(file)] ?? "application/octet-stream",
				"cache-control": "no-cache",
				"content-security-policy":
					// media-src blob: lets voice mode keep a silent media session (headset button) alive.
					"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
			});
			res.end(body);
		} catch {
			send(res, 404, { error: "not found" });
		}
	}

	private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const pairing = this.pairings.get(String(body?.p ?? ""));
		if (!pairing || pairing.expiresAt < Date.now()) return send(res, 410, { error: "pairing code expired or already used; run /remote again" });
		const hello = open<{ t: number; name?: string }>(pairing.key, String(body?.b ?? ""));
		if (!hello || !this.replay.accept(hello.nonce, hello.value.t)) return send(res, 401, { error: "bad pairing" });
		this.pairings.delete(pairing.id);
		const key = randomKey();
		const device: Device = {
			id: randomId(),
			name: String(hello.value.name || "phone").slice(0, 60),
			key: b64u(key),
			role: pairing.role,
			createdAt: Date.now(),
		};
		this.devices.add(device);
		this.broadcastToAgents({ t: "paired", device: publicDevice(device) });
		send(res, 200, { b: seal(pairing.key, { d: device.id, k: device.key, role: device.role, host: MACHINE() }) });
	}

	private authenticate(d: unknown, b: unknown): { device: Device; value: any } | undefined {
		const device = this.devices.get(String(d ?? ""));
		if (!device) return undefined;
		const opened = open<any>(unb64u(device.key), String(b ?? ""));
		if (!opened || !this.replay.accept(opened.nonce, opened.value?.t)) return undefined;
		this.devices.touch(device.id);
		return { device, value: opened.value };
	}

	private async rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const auth = this.authenticate(body?.d, body?.b);
		if (!auth) return send(res, 401, { error: "unauthorized" });
		const key = unb64u(auth.device.key);
		try {
			const result = await this.deviceCall(auth.device, String(auth.value.m), auth.value.p ?? {});
			send(res, 200, { b: seal(key, { r: result ?? null }) });
		} catch (e: any) {
			send(res, 200, { b: seal(key, { e: String(e?.message ?? e) }) });
		}
	}

	private async deviceCall(device: Device, m: string, p: any): Promise<unknown> {
		switch (m) {
			case "hub":
				return {
					hubId: this.id,
					host: MACHINE(),
					seq: this.seq,
					agents: [...this.agents.values()].map((a) => a.info),
					device: publicDevice(device),
					pushKey: this.push.vapid.publicKey,
					pushOn: this.push.entries().some(([id]) => id === device.id),
				};
			case "focus": {
				for (const c of this.clients) if (c.id === p.client && c.device.id === device.id) c.focus = String(p.agent ?? "") || undefined;
				return { ok: true };
			}
			case "push": {
				const sub = p.subscription as PushSubscriptionJSON | null;
				if (sub && !(typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://") && sub.keys?.p256dh && sub.keys?.auth))
					throw new Error("invalid push subscription");
				this.push.set(device.id, sub ?? undefined);
				return { ok: true };
			}
			case "devices":
				return this.devices.list().map(publicDevice);
			case "revoke": {
				const ids: string[] = Array.isArray(p.ids) ? p.ids.map(String) : [];
				const removed = this.devices.remove(ids);
				for (const id of ids) this.push.set(id, undefined);
				setImmediate(() => this.dropStreams(ids));
				return removed.map(publicDevice);
			}
			case "pair":
				await this.syncServe();
				return { ...this.createPairing(), serveEnable: this.serveEnable };
			case "agent": {
				const conn = this.agents.get(String(p.agent));
				if (!conn) throw new Error("that pi session is no longer connected");
				const method = String(p.m);
				return conn.ch.request(method, { ...(p.p ?? {}), _device: { id: device.id, name: device.name } }, 10 * 60_000);
			}
			default:
				throw new Error(`unknown method ${m}`);
		}
	}

	private stream(url: URL, req: IncomingMessage, res: ServerResponse): void {
		const auth = this.authenticate(url.searchParams.get("d"), url.searchParams.get("b"));
		if (!auth) return send(res, 401, { error: "unauthorized" });
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
			connection: "keep-alive",
		});
		res.flushHeaders();
		req.socket.setNoDelay(true);
		const { hub, since, focus } = auth.value as { hub?: string; since?: number; focus?: string };
		const client: StreamClient = { id: randomId(), focus, device: auth.device, res, queue: [] };
		const first = this.ring[0]?.seq ?? this.seq + 1;
		const canReplay = hub === this.id && typeof since === "number" && since >= first - 1 && since <= this.seq;
		client.queue.push({ type: "hello", hubId: this.id, seq: this.seq, resync: !canReplay, client: client.id });
		if (canReplay) for (const ev of this.ring) if (ev.seq > since && wants(client, ev)) client.queue.push(ev);
		this.flush(client);
		this.clients.add(client);
		this.clientsChanged();
		const done = () => {
			if (!this.clients.delete(client)) return;
			clearTimeout(client.flush);
			this.clientsChanged();
		};
		req.on("close", done);
		res.on("close", done);
	}
}

/** A name people recognise: macOS's Computer Name rather than a generated host name. */
function machineName(): string {
	if (process.platform === "darwin") {
		try {
			const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
			if (name) return name;
		} catch {}
	}
	return hostname().replace(/\.local$/, "");
}
let machine: string | undefined;
const MACHINE = () => (machine ??= machineName());

function wants(c: StreamClient, ev: HubEvent): boolean {
	return GLOBAL_EVENTS.has(ev.type) || ev.agent === c.focus;
}

function publicDevice(d: Device): Omit<Device, "key"> {
	const { key: _key, ...rest } = d;
	return rest;
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new Error("request too large");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}
