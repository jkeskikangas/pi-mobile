// Where the hub can be reached from a phone. Payloads are end-to-end encrypted, so plain HTTP
// on the LAN or the tailnet is acceptable; cloudflared adds HTTPS reachability from anywhere.

import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import type { Expose } from "./store.ts";

export interface Endpoint {
	label: string;
	url: string;
}

function isTailscale(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return a === 100 && b >= 64 && b <= 127;
}

/** RFC 1918 and Tailscale's CGNAT range: reachable from your LAN or tailnet, never the internet. */
export function isPrivate(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || isTailscale(ip);
}

export interface Address {
	ip: string;
	label: string;
}

/**
 * Addresses the hub listens on in `network` mode, best first: Tailscale (WireGuard-protected,
 * works off-LAN), then LAN. Public addresses are left out on purpose, so a cloud box with a public
 * interface is not exposed to the internet.
 */
export function privateAddresses(ifaces = networkInterfaces()): Address[] {
	const tail: Address[] = [];
	const lan: Address[] = [];
	for (const [name, addrs] of Object.entries(ifaces)) {
		for (const a of addrs ?? []) {
			if (a.family !== "IPv4" || a.internal || !isPrivate(a.address)) continue;
			if (isTailscale(a.address)) tail.push({ ip: a.address, label: "tailscale" });
			else lan.push({ ip: a.address, label: `lan ${name}` });
		}
	}
	return [...tail, ...lan];
}

export interface Tunnel {
	url: string;
	stop(): void;
}

// ── Tailscale Serve ────────────────────────────────────────────────────────────────────────────
// Phones need an HTTPS page for the microphone and Web Push. With Tailscale on the computer, pi
// puts the hub behind `tailscale serve` (tailnet only, a real certificate) so nobody has to.

/** The CLI on PATH, else the one inside the macOS app. */
const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
/** HTTPS ports tried in order; one held by another program (a local dev proxy on 443) is skipped. */
const SERVE_PORTS = [443, 8443, 10000];
/** Printed (and waited on) by `tailscale serve` when the tailnet has not enabled Serve/HTTPS yet. */
const ENABLE_LINK = /https:\/\/login\.tailscale\.com\/f\/\S+/;

export interface CliResult {
	/** Exit code; null when it is still running (returned early on `until`) or timed out. */
	code: number | null;
	out: string;
	/** Settles with the exit code once the process ends. */
	exited: Promise<number | null>;
}
export type TailscaleCli = (args: string[], opts?: { timeoutMs?: number; until?: RegExp; keepMs?: number }) => Promise<CliResult | undefined>;

/**
 * Runs the tailscale CLI; undefined when it is not installed. With `until`, resolves as soon as the
 * output matches and lets the process keep running for up to `keepMs`.
 */
export const tailscaleCli: TailscaleCli = async (args, { timeoutMs = 5000, until, keepMs = 10 * 60_000 } = {}) => {
	for (const bin of TAILSCALE_BINS) {
		const r = await new Promise<CliResult | "missing">((resolve) => {
			let child: ChildProcess;
			try {
				child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				resolve("missing");
				return;
			}
			let out = "";
			let settled = false;
			let exit!: (code: number | null) => void;
			const exited = new Promise<number | null>((r) => (exit = r));
			let timer = setTimeout(() => child.kill(), timeoutMs);
			const settle = (code: number | null) => {
				if (settled) return;
				settled = true;
				resolve({ code, out, exited });
			};
			const onData = (d: Buffer) => {
				out += String(d);
				if (!settled && until?.test(out)) {
					clearTimeout(timer);
					timer = setTimeout(() => child.kill(), keepMs);
					timer.unref();
					child.unref();
					settle(null);
				}
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.on("error", (e: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				exit(null);
				if (settled) return;
				settled = true;
				resolve(e.code === "ENOENT" ? "missing" : { code: null, out: out + e.message, exited });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				exit(code);
				settle(code);
			});
		});
		if (r !== "missing") return r;
	}
	return undefined;
};

function json(text: string | undefined): any {
	try {
		return JSON.parse(text ?? "");
	} catch {
		return undefined;
	}
}

/** Whether a `serve` proxy target is this machine's `port` (`http://127.0.0.1:7878`, `localhost:7878`, `7878`). */
function targetsPort(proxy: string, port: number): boolean {
	if (/^\d+$/.test(proxy)) return Number(proxy) === port;
	try {
		const u = new URL(/^[a-z+]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
		return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && Number(u.port || 80) === port;
	} catch {
		return false;
	}
}

/** The HTTPS address an existing Tailscale Serve config forwards to `port`, from `tailscale serve status --json`. */
export function serveUrl(status: any, port: number): string | undefined {
	for (const [hostPort, web] of Object.entries<any>(status?.Web ?? {})) {
		const root = web?.Handlers?.["/"]?.Proxy;
		if (typeof root !== "string" || !targetsPort(root, port)) continue;
		const i = hostPort.lastIndexOf(":");
		const host = hostPort.slice(0, i);
		const p = hostPort.slice(i + 1);
		if (status?.TCP?.[p]?.HTTPS !== true) continue;
		return p === "443" ? `https://${host}` : `https://${host}:${p}`;
	}
	return undefined;
}

/** Something already accepts connections on ip:port (it would shadow a serve listener there). */
export function portTaken(ip: string, port: number, timeoutMs = 800): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host: ip, port });
		const done = (v: boolean) => {
			s.destroy();
			resolve(v);
		};
		s.setTimeout(timeoutMs, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

export interface ServeResult {
	/** HTTPS address that reaches the hub. */
	url?: string;
	/** The tailnet must enable Serve/HTTPS first: one click at this link. */
	enable?: string;
	/** While waiting on `enable`: settles with the address once enabled (undefined if it never is). */
	pending?: Promise<string | undefined>;
}

/**
 * Finds or creates a Tailscale Serve HTTPS address for the hub on `port`. Never changes an existing
 * serve config: ports already served, or held by another program, are skipped.
 */
export async function ensureServe(port: number, cli: TailscaleCli = tailscaleCli, taken = portTaken): Promise<ServeResult> {
	const st = json((await cli(["status", "--json"]))?.out);
	const host = String(st?.Self?.DNSName ?? "").replace(/\.$/, "");
	if (st?.BackendState !== "Running" || !host) return {};
	const sv = json((await cli(["serve", "status", "--json"]))?.out) ?? {};
	const existing = serveUrl(sv, port);
	if (existing) return { url: existing };
	const ip: string | undefined = (st.Self?.TailscaleIPs ?? []).find((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
	for (const p of SERVE_PORTS) {
		if (sv.TCP?.[p] || (ip && (await taken(ip, p)))) continue;
		const r = await cli(["serve", "--bg", `--https=${p}`, `http://127.0.0.1:${port}`], { timeoutMs: 20_000, until: ENABLE_LINK });
		if (!r) return {};
		const url = p === 443 ? `https://${host}` : `https://${host}:${p}`;
		const enable = ENABLE_LINK.exec(r.out)?.[0];
		if (enable) return { enable, pending: r.exited.then((code) => (code === 0 ? url : undefined)) };
		if (r.code === 0) return { url };
	}
	return {};
}

/** Starts a cloudflared quick tunnel and resolves with its https://*.trycloudflare.com URL. */
export function startCloudflared(port: number, timeoutMs = 30_000, bin = "cloudflared"): Promise<Tunnel> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			reject(e);
			return;
		}
		let settled = false;
		const stop = () => {
			if (child.exitCode === null) child.kill();
		};
		const timer = setTimeout(() => finish(new Error("cloudflared did not report a tunnel URL")), timeoutMs);
		const finish = (err?: Error, url?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err || !url) {
				stop();
				reject(err ?? new Error("no tunnel URL"));
			} else resolve({ url, stop });
		};
		const scan = (chunk: Buffer) => {
			const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
			if (m) finish(undefined, m[0]);
		};
		child.stdout?.on("data", scan);
		child.stderr?.on("data", scan);
		child.on("error", (e: NodeJS.ErrnoException) =>
			finish(e.code === "ENOENT" ? new Error("cloudflared is not installed (brew install cloudflared)") : e),
		);
		child.on("exit", (code) => finish(new Error(`cloudflared exited (${code})`)));
	});
}
