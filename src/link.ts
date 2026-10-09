// Keeps one pi process linked to the machine's hub, hosting the hub itself whenever nobody else does.

import { request } from "node:http";
import { Channel } from "./channel.ts";
import { Hub, LINK_PROTOCOL } from "./hub.ts";
import type { Endpoint } from "./expose.ts";
import type { AgentInfo } from "./protocol.ts";
import { PROTOCOL } from "./protocol.ts";
import type { Config } from "./store.ts";

const HUB_KEY = Symbol.for("pi-mobile.hub");
type Global = typeof globalThis & { [HUB_KEY]?: Hub };

/** The hub hosted by this process, if any. Lives on globalThis so it survives /new, /resume and /reload. */
export function processHub(): Hub | undefined {
	return (globalThis as Global)[HUB_KEY];
}

export function closeProcessHub(): void {
	const g = globalThis as Global;
	g[HUB_KEY]?.close();
	g[HUB_KEY] = undefined;
}

async function hostHub(config: Config, secret: string): Promise<boolean> {
	const g = globalThis as Global;
	if (g[HUB_KEY]) return true;
	const hub = new Hub({
		config,
		secret,
		onIdle: () => {
			if (g[HUB_KEY] === hub) closeProcessHub();
		},
		onRestart: () => {
			if (g[HUB_KEY] === hub) closeProcessHub();
		},
	});
	try {
		await hub.listen();
	} catch (e: any) {
		hub.close();
		if (e?.code === "EADDRINUSE") return false;
		throw e;
	}
	g[HUB_KEY] = hub;
	return true;
}

export type LinkState =
	| { kind: "connecting" }
	| { kind: "linked"; hubPid: number; endpoints: Endpoint[]; clients: { count: number; names: string[] } }
	| { kind: "error"; message: string };

export interface LinkOptions {
	/** Re-read on every (re)connect, so port and exposure changes apply when the hub restarts. */
	config: () => Config;
	secret: string;
	info: () => AgentInfo;
	onRequest: (m: string, p: any) => unknown;
	onMessage?: (msg: any) => void;
	onState?: (s: LinkState) => void;
}

export class HubLink {
	private ch?: Channel;
	private stopped = false;
	private attempt = 0;
	private retry?: NodeJS.Timeout;
	state: LinkState = { kind: "connecting" };
	private readonly opts: LinkOptions;

	constructor(opts: LinkOptions) {
		this.opts = opts;
	}

	get linked(): boolean {
		return this.state.kind === "linked" && !!this.ch?.isOpen;
	}

	start(): void {
		this.stopped = false;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.retry);
		this.ch?.close();
		this.ch = undefined;
	}

	send(msg: unknown): void {
		if (this.linked) this.ch?.send(msg);
	}

	request<T = any>(m: string, p?: unknown): Promise<T> {
		if (!this.ch?.isOpen) return Promise.reject(new Error("not connected to the pi-mobile hub"));
		return this.ch.request<T>(m, p, 15_000);
	}

	private setState(s: LinkState): void {
		this.state = s;
		this.opts.onState?.(s);
	}

	private schedule(): void {
		if (this.stopped) return;
		// Jitter keeps two orphaned agents from racing in lockstep; EADDRINUSE settles any race anyway.
		const delay = Math.min(5000, 200 * 2 ** this.attempt++) + Math.random() * 200;
		this.retry = setTimeout(() => void this.connect(), delay);
		this.retry.unref();
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		const { secret } = this.opts;
		const config = this.opts.config();
		try {
			const ch = await dial(config.port, secret);
			if (this.stopped) return ch.close();
			this.adopt(ch);
		} catch (e: any) {
			if (this.stopped) return;
			if (e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET") {
				try {
					if (await hostHub(config, secret)) {
						this.attempt = 0;
						return void this.connect();
					}
				} catch (err: any) {
					this.setState({ kind: "error", message: `cannot host the hub on port ${config.port}: ${err?.message ?? err}` });
				}
			} else {
				this.setState({ kind: "error", message: String(e?.message ?? e) });
			}
			this.schedule();
		}
	}

	private adopt(ch: Channel): void {
		this.ch = ch;
		ch.onRequest = (m, p) => this.opts.onRequest(m, p);
		ch.onMessage = (msg) => {
			if (msg.t === "welcome") {
				this.attempt = 0;
				this.setState({ kind: "linked", hubPid: msg.pid, endpoints: msg.endpoints, clients: msg.clients });
			} else if (msg.t === "rejected") {
				this.setState({ kind: "error", message: msg.reason });
			} else if (this.state.kind === "linked" && msg.t === "clients") {
				this.setState({ ...this.state, clients: msg.clients });
			} else if (this.state.kind === "linked" && msg.t === "endpoints") {
				this.setState({ ...this.state, endpoints: msg.endpoints });
			}
			this.opts.onMessage?.(msg);
		};
		ch.onClose = () => {
			if (this.ch !== ch) return;
			this.ch = undefined;
			if (this.stopped) return;
			this.setState({ kind: "connecting" });
			this.schedule();
		};
		ch.send({ t: "hello", protocol: PROTOCOL, info: this.opts.info() });
	}
}

function dial(port: number, secret: string): Promise<Channel> {
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			headers: { connection: "Upgrade", upgrade: LINK_PROTOCOL, "x-pi-mobile-secret": secret },
		});
		req.setTimeout(5000, () => req.destroy(Object.assign(new Error("hub did not answer"), { code: "ETIMEDOUT" })));
		req.on("upgrade", (_res, socket, head) => {
			socket.setTimeout(0);
			if (head.length) socket.unshift(head);
			resolve(new Channel(socket));
		});
		req.on("response", (res) => {
			res.resume();
			reject(new Error(`port ${port} is used by something that is not a pi-mobile hub (HTTP ${res.statusCode}); choose another port in /remote settings`));
		});
		req.on("error", reject);
		req.end();
	});
}
