// Optional herdr integration. Everything here is a no-op unless pi runs inside herdr
// (HERDR_ENV=1 with a socket), so pi-mobile never depends on herdr.

import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomId } from "./crypto.ts";

export function inHerdr(env = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH;
}

/** One request over herdr's socket API (newline-delimited JSON). */
export function herdrCall<T = any>(method: string, params: unknown, timeoutMs = 15_000, socket = process.env.HERDR_SOCKET_PATH): Promise<T> {
	return new Promise((resolvePromise, reject) => {
		if (!socket) return reject(new Error("not running inside herdr"));
		const id = `pi-mobile:${randomId(6)}`;
		const s = createConnection(process.platform === "win32" ? `\\\\.\\pipe\\${socket}` : socket);
		let buf = "";
		const timer = setTimeout(() => {
			s.destroy();
			reject(new Error(`herdr ${method} timed out`));
		}, timeoutMs);
		s.on("connect", () => s.write(`${JSON.stringify({ id, method, params })}\n`));
		s.on("data", (chunk) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			s.end();
			try {
				const msg = JSON.parse(buf.slice(0, nl));
				if (msg.error) reject(new Error(msg.error.message ?? String(msg.error.code)));
				else resolvePromise(msg.result as T);
			} catch (e) {
				reject(e);
			}
		});
		s.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

/**
 * herdr marks a pi pane "blocked" only when an extension says so on the `herdr:blocked` bus.
 * Every select/confirm/input/editor dialog goes through ctx.ui, so mirroring pi's ui_prompt
 * events makes herdr's sidebar show any extension's question, not just the ones that report it.
 * Counts stay balanced if the asking extension also reports: herdr counts opens and closes.
 */
export function registerHerdrBlocked(pi: ExtensionAPI): void {
	if (!inHerdr()) return;
	const asks = new Set(["select", "confirm", "input", "editor"]);
	pi.on("ui_prompt_start", (e, ctx) => {
		if (ctx.mode === "tui" && asks.has(e.kind)) pi.events.emit("herdr:blocked", { active: true, label: e.title });
	});
	pi.on("ui_prompt_end", (e, ctx) => {
		if (ctx.mode === "tui" && asks.has(e.kind)) pi.events.emit("herdr:blocked", { active: false, label: e.title });
	});
}

/** Extension arguments a new pi needs to load pi-mobile when this one was loaded with `-e`. */
export function extensionArgs(argv = process.argv): string[] {
	const pkg = fileURLToPath(new URL("..", import.meta.url));
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] !== "-e" && argv[i] !== "--extension") continue;
		const p = resolve(argv[i + 1]);
		if (p === resolve(pkg) || p.startsWith(resolve(pkg) + "/")) return ["-e", p];
	}
	return []; // installed as a package: every pi loads it
}

export interface SpawnRequest {
	cwd: string;
	prompt?: string;
	/** Echoed back by the new session (PI_MOBILE_SPAWN) so the phone can open it. */
	spawnId: string;
}

/**
 * Opens a tab in the herdr workspace already working in `cwd` (or a new workspace there) and
 * starts pi in it, shared with the phone, optionally with a first prompt.
 */
export async function spawnPi(req: SpawnRequest, call: typeof herdrCall = herdrCall): Promise<{ name: string; paneId: string }> {
	const cwd = req.cwd.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
	if (!isAbsolute(cwd)) throw new Error("choose an absolute folder");
	let isDir = false;
	try {
		isDir = statSync(cwd).isDirectory();
	} catch {}
	if (!isDir) throw new Error(`${cwd} is not a folder on this machine`);

	const env = { PI_MOBILE_SPAWN: req.spawnId };
	const label = basename(cwd) || cwd;
	const panes = (await call<{ panes: { cwd?: string | null; workspace_id: string }[] }>("pane.list", {})).panes ?? [];
	const home = panes.find((p) => p.cwd === cwd)?.workspace_id;
	const created = home
		? await call<{ root_pane: { pane_id: string } }>("tab.create", { workspace_id: home, cwd, env, label, focus: false })
		: await call<{ root_pane: { pane_id: string } }>("workspace.create", { cwd, env, label, focus: false });
	const paneId = created.root_pane.pane_id;
	const name = `${label}-${randomId(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
	// A leading dash would be read as a pi flag.
	const raw = req.prompt?.trim();
	const prompt = raw?.startsWith("-") ? ` ${raw}` : raw;
	await call("agent.start", {
		name,
		kind: "pi",
		pane_id: paneId,
		// The prompt goes before --remote: pi lets a boolean extension flag swallow the next argument.
		args: [...extensionArgs(), ...(prompt ? [prompt] : []), "--remote"],
		timeout_ms: 60_000,
	});
	return { name, paneId };
}
