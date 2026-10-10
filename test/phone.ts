// A test phone: speaks the same sealed protocol as web/app.js.

import { createServer } from "node:net";
import { open, seal, unb64u } from "../src/crypto.ts";

// Hubs started by tests must never run the real `tailscale serve` on the developer's tailnet.
process.env.PI_MOBILE_TAILSCALE = "off";

export async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as any).port;
			s.close(() => resolve(port));
		});
	});
}

export class Phone {
	base = "";
	d = "";
	key: Uint8Array = new Uint8Array();
	role = "";
	events: any[] = [];
	private ctrl?: AbortController;

	async pair(link: string, name = "test phone"): Promise<Response> {
		const url = new URL(link);
		this.base = url.origin;
		const [p, k] = url.hash.replace("#p=", "").split(".");
		const key = unb64u(k);
		const res = await fetch(`${this.base}/api/pair`, {
			method: "POST",
			body: JSON.stringify({ p, b: seal(key, { t: Date.now(), name }) }),
		});
		if (res.ok) {
			const out = open<any>(key, (await res.clone().json()).b)!.value;
			this.d = out.d;
			this.key = unb64u(out.k);
			this.role = out.role;
		}
		return res;
	}

	body(m: string, p?: unknown): string {
		return JSON.stringify({ d: this.d, b: seal(this.key, { t: Date.now(), m, p }) });
	}

	async raw(body: string): Promise<Response> {
		return fetch(`${this.base}/api/rpc`, { method: "POST", body });
	}

	async rpc<T = any>(m: string, p?: unknown): Promise<T> {
		const res = await this.raw(this.body(m, p));
		if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
		const out = open<any>(this.key, (await res.json()).b)!.value;
		if (out.e !== undefined) throw new Error(out.e);
		return out.r;
	}

	/** Opens the event stream; resolves once the hub's hello arrives. */
	async stream(since?: { hub: string; seq: number }, focus?: string): Promise<any> {
		this.ctrl = new AbortController();
		const b = seal(this.key, { t: Date.now(), hub: since?.hub, since: since?.seq, focus });
		const res = await fetch(`${this.base}/api/stream?d=${this.d}&b=${b}`, { signal: this.ctrl.signal });
		if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let hello: (v: any) => void = () => {};
		const gotHello = new Promise((r) => (hello = r));
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					buf += dec.decode(value, { stream: true });
					let i = buf.indexOf("\n\n");
					while (i >= 0) {
						const frame = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
						if (data) {
							for (const ev of open<any[]>(this.key, data)!.value) {
								if (ev.type === "hello") hello(ev);
								else this.events.push(ev);
							}
						}
						i = buf.indexOf("\n\n");
					}
				}
			} catch {}
		})();
		return gotHello;
	}

	close(): void {
		this.ctrl?.abort();
	}

	async waitFor(pred: (ev: any) => boolean, ms = 3000): Promise<any> {
		const until = Date.now() + ms;
		for (;;) {
			const hit = this.events.find(pred);
			if (hit) return hit;
			if (Date.now() > until) throw new Error(`timed out; got ${JSON.stringify(this.events.map((e) => e.type))}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	}
}

export async function until(pred: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 20));
	}
}
