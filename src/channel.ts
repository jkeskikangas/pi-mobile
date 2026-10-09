// Newline-delimited JSON over a duplex socket with request/response correlation.
// Used for the loopback link between each pi process (bridge) and the hub.

import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type Handler = (method: string, params: any) => Promise<unknown> | unknown;

const MAX_LINE = 64 * 1024 * 1024;

export class Channel {
	private buf = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private closed = false;
	onRequest: Handler = () => {
		throw new Error("no handler");
	};
	onMessage: (msg: any) => void = () => {};
	onClose: () => void = () => {};

	private readonly socket: Duplex;

	constructor(socket: Duplex) {
		this.socket = socket;
		// Not socket.setEncoding(): Node forbids it on sockets taken over from an HTTP upgrade.
		const decoder = new StringDecoder("utf8");
		socket.on("data", (chunk: Buffer) => this.feed(decoder.write(chunk)));
		// Sockets taken over from an HTTP server allow half-open connections: the peer's FIN only
		// emits "end", never "close", so a departed peer would linger forever without this.
		socket.on("end", () => this.close());
		socket.on("close", () => this.shutdown());
		socket.on("error", () => this.shutdown());
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	private feed(chunk: string): void {
		this.buf += chunk;
		if (this.buf.length > MAX_LINE) return this.close();
		let nl = this.buf.indexOf("\n");
		while (nl >= 0) {
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			if (line) this.dispatch(line);
			nl = this.buf.indexOf("\n");
		}
	}

	private dispatch(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg?.t === "res") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.e !== undefined) p.reject(new Error(String(msg.e)));
			else p.resolve(msg.r);
		} else if (msg?.t === "req") {
			Promise.resolve()
				.then(() => this.onRequest(msg.m, msg.p))
				.then(
					(r) => this.send({ t: "res", id: msg.id, r: r ?? null }),
					(e) => this.send({ t: "res", id: msg.id, e: e instanceof Error ? e.message : String(e) }),
				);
		} else {
			this.onMessage(msg);
		}
	}

	send(msg: unknown): void {
		if (this.closed) return;
		this.socket.write(`${JSON.stringify(msg)}\n`);
	}

	request<T = any>(m: string, p?: unknown, timeoutMs = 60_000): Promise<T> {
		if (this.closed) return Promise.reject(new Error("link closed"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${m} timed out`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.send({ t: "req", id, m, p });
		});
	}

	close(): void {
		this.socket.destroy();
		this.shutdown();
	}

	private shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("link closed"));
		}
		this.pending.clear();
		this.onClose();
	}
}
