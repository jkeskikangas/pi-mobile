// Where the hub can be reached from a phone. Payloads are end-to-end encrypted, so plain HTTP
// on the LAN or the tailnet is acceptable; cloudflared adds HTTPS reachability from anywhere.

import { type ChildProcess, spawn } from "node:child_process";
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

// Tailscale Serve lives in plain JavaScript (bin/tailscale.mjs) so `pi-mobile enrol` on a fresh box
// finds the address exactly as the hub does.
export { type CliResult, ensureServe, portTaken, type ServeResult, serveUrl, type TailscaleCli, tailscaleCli } from "../bin/tailscale.mjs";

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
