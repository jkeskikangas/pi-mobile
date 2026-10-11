// Tailscale Serve: the HTTPS address phones use. Plain JavaScript with no dependencies, shared by
// the hub inside pi (src/expose.ts) and `pi-mobile enrol` on a fresh box, so both find the same
// address. Types: tailscale.d.mts.

import { spawn } from "node:child_process";
import { connect } from "node:net";

// Phones need an HTTPS page for the microphone and Web Push. With Tailscale on the computer, pi
// puts the hub behind `tailscale serve` (tailnet only, a real certificate) so nobody has to.

/** The CLI on PATH, else the one inside the macOS app. */
const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
/** HTTPS ports tried in order; one held by another program (a local dev proxy on 443) is skipped. */
const SERVE_PORTS = [443, 8443, 10000];
/** Printed (and waited on) by `tailscale serve` when the tailnet has not enabled Serve/HTTPS yet. */
const ENABLE_LINK = /https:\/\/login\.tailscale\.com\/f\/\S+/;

/**
 * Runs the tailscale CLI; undefined when it is not installed. With `until`, resolves as soon as the
 * output matches and lets the process keep running for up to `keepMs`.
 */
export const tailscaleCli = async (args, { timeoutMs = 5000, until, keepMs = 10 * 60_000 } = {}) => {
	for (const bin of TAILSCALE_BINS) {
		const r = await new Promise((resolve) => {
			let child;
			try {
				child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				resolve("missing");
				return;
			}
			let out = "";
			let settled = false;
			let exit;
			const exited = new Promise((r) => (exit = r));
			let timer = setTimeout(() => child.kill(), timeoutMs);
			const settle = (code) => {
				if (settled) return;
				settled = true;
				resolve({ code, out, exited });
			};
			const onData = (d) => {
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
			child.on("error", (e) => {
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

function json(text) {
	try {
		return JSON.parse(text ?? "");
	} catch {
		return undefined;
	}
}

/** Whether a `serve` proxy target is this machine's `port` (`http://127.0.0.1:7878`, `localhost:7878`, `7878`). */
function targetsPort(proxy, port) {
	if (/^\d+$/.test(proxy)) return Number(proxy) === port;
	try {
		const u = new URL(/^[a-z+]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
		return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && Number(u.port || 80) === port;
	} catch {
		return false;
	}
}

/** The HTTPS address an existing Tailscale Serve config forwards to `port`, from `tailscale serve status --json`. */
export function serveUrl(status, port) {
	for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
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
export function portTaken(ip, port, timeoutMs = 800) {
	return new Promise((resolve) => {
		const s = connect({ host: ip, port });
		const done = (v) => {
			s.destroy();
			resolve(v);
		};
		s.setTimeout(timeoutMs, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

/**
 * Finds or creates a Tailscale Serve HTTPS address for the hub on `port`. Never changes an existing
 * serve config: ports already served, or held by another program, are skipped.
 */
export async function ensureServe(port, cli = tailscaleCli, taken = portTaken) {
	const st = json((await cli(["status", "--json"]))?.out);
	const host = String(st?.Self?.DNSName ?? "").replace(/\.$/, "");
	if (st?.BackendState !== "Running" || !host) return {};
	const sv = json((await cli(["serve", "status", "--json"]))?.out) ?? {};
	const existing = serveUrl(sv, port);
	if (existing) return { url: existing };
	const ip = (st.Self?.TailscaleIPs ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
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

/** This machine's tailnet name (e.g. box.tail1234.ts.net), or undefined when Tailscale isn't running. */
export async function tailnetName(cli = tailscaleCli) {
	const st = json((await cli(["status", "--json"]))?.out);
	const host = String(st?.Self?.DNSName ?? "").replace(/\.$/, "");
	return st?.BackendState === "Running" && host ? host : undefined;
}
