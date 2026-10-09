// pi-mobile: continue pi sessions from a phone.
//
// One switch for the whole machine: `/remote` in any pi shares every pi session on this computer
// (running ones join within seconds, new ones on start) and shows a pairing QR code until a phone
// is paired.
//
//   /remote            connect this machine; QR if no phone is paired yet, otherwise status
//   /remote pair       pair another device (`/remote pair view` for a view-only one)
//   /remote off        stop sharing: this session only, or every session on the machine
//   /remote devices    paired devices; pick one to revoke
//   /remote settings   exposure, HTTPS address, port (the hub restarts by itself)

import { unwatchFile, watchFile } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Bridge } from "./bridge.ts";
import { registerHerdrBlocked } from "./herdr.ts";
import { closeProcessHub, type LinkState } from "./link.ts";
import type { AgentInfo } from "./protocol.ts";
import { qrLines } from "./qr.ts";
import { type Config, configPath, type Expose, linkSecret, loadConfig, saveConfig } from "./store.ts";

/** Set by `/remote off` → "Only this session"; lives on globalThis so it survives /new and /reload. */
const HIDDEN = Symbol.for("pi-mobile.hidden");
/** Set by any `/remote off`, so a `--remote` flag does not re-share the session behind the user's back. */
const FLAG_OFF = Symbol.for("pi-mobile.flag-off");
type G = typeof globalThis & { [HIDDEN]?: boolean; [FLAG_OFF]?: boolean };
const SUBCOMMANDS = [
	{ value: "pair", label: "pair", description: "Pair another device (add 'view' for view-only)" },
	{ value: "off", label: "off", description: "Stop sharing this session or the whole machine" },
	{ value: "devices", label: "devices", description: "Paired devices; revoke one" },
	{ value: "settings", label: "settings", description: "Exposure, HTTPS address, port" },
];
const STATUS_ICON: Record<string, string> = { idle: "○", working: "●", waiting: "◐" };

interface HubStatus {
	pid: number;
	expose: Expose;
	endpoints: { label: string; url: string }[];
	tunnelError?: string;
	agents: AgentInfo[];
	clients: { count: number; names: string[] };
	devices: { id: string; name: string; role: string; createdAt: number; lastSeenAt?: number }[];
}

export default function piMobile(pi: ExtensionAPI): void {
	let bridge: Bridge | undefined;
	let ctx: ExtensionContext | undefined;
	let closePanel: (() => void) | undefined;
	let watching = false;
	let offInput: (() => void) | undefined;
	const g = globalThis as G;

	pi.registerFlag("remote", { type: "boolean", description: "Share this session with your phone (pi-mobile)" });
	registerHerdrBlocked(pi);

	const footer = (s: LinkState | undefined) => {
		if (!ctx?.hasUI) return;
		const t = ctx.ui.theme;
		if (!s) return ctx.ui.setStatus("remote", undefined);
		if (s.kind === "connecting") return ctx.ui.setStatus("remote", t.fg("dim", "📱 connecting…"));
		if (s.kind === "error") return ctx.ui.setStatus("remote", t.fg("error", "📱 error"));
		const n = s.clients.count;
		ctx.ui.setStatus("remote", n ? t.fg("success", `📱 ${n} connected`) : t.fg("dim", "📱 shared"));
	};

	const start = (c: ExtensionContext) => {
		if (bridge) return bridge;
		let lastError = "";
		const b = new Bridge(pi, c, loadConfig, linkSecret());
		b.onState = (s) => {
			footer(s);
			if (s.kind === "error" && s.message !== lastError) {
				lastError = s.message;
				c.ui.notify(`pi-mobile: ${s.message}`, "error");
			}
			if (s.kind === "linked") lastError = "";
		};
		b.onMessage = (msg) => {
			if (msg.t === "paired" && closePanel) {
				closePanel();
				ctx?.ui.notify(
					`📱 Paired ${msg.device.name}${msg.device.role === "view" ? " (view-only)" : ""}. Every pi session on this machine is on your phone.`,
					"info",
				);
			}
		};
		bridge = b;
		b.start();
		return b;
	};

	const stop = () => {
		bridge?.stop();
		bridge = undefined;
		footer(undefined);
	};

	const shouldShare = () => !g[HIDDEN] && (loadConfig().enabled || (pi.getFlag("remote") === true && !g[FLAG_OFF]));
	const sync = () => {
		if (!ctx) return;
		if (shouldShare()) start(ctx);
		else stop();
	};

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		sync();
		// Keystrokes here mean you are at the computer; the hub holds phone notifications meanwhile.
		offInput?.();
		offInput =
			c.mode === "tui"
				? c.ui.onTerminalInput(() => {
						bridge?.presence();
						return undefined;
					})
				: undefined;
		if (!watching) {
			// `/remote` or `/remote off` in another terminal flips the machine switch; follow it.
			watching = true;
			watchFile(configPath(), { interval: 1500, persistent: false }, sync);
		}
	});
	pi.on("session_shutdown", async (e) => {
		stop();
		offInput?.();
		offInput = undefined;
		if (watching) unwatchFile(configPath(), sync);
		watching = false;
		if (e.reason === "quit") closeProcessHub();
	});

	const withBridge =
		<E>(fn: (b: Bridge, e: E) => void) =>
		async (e: E, c: ExtensionContext) => {
			ctx = c;
			if (!bridge) return;
			bridge.setContext(c);
			fn(bridge, e);
		};
	pi.on("agent_start", withBridge((b) => b.agentStart()));
	pi.on("agent_settled", withBridge((b, e: any) => b.agentSettled(!!e.aborted)));
	pi.on("message_start", withBridge((b, e: any) => b.messageStart(e.message)));
	pi.on("message_update", withBridge((b, e: any) => b.messageUpdate(e.message, e.assistantMessageEvent)));
	pi.on("message_end", withBridge((b, e: any) => b.messageEnd(e.message)));
	pi.on("tool_execution_start", withBridge((b, e: any) => !e.parentToolCallId && b.toolStart(e.toolCallId, e.toolName, e.args)));
	pi.on("tool_execution_update", withBridge((b, e: any) => !e.parentToolCallId && b.toolUpdate(e.toolCallId, e.partialResult)));
	pi.on("tool_execution_end", withBridge((b, e: any) => !e.parentToolCallId && b.toolEnd(e.toolCallId, !!e.isError)));
	pi.on("turn_end", withBridge((b) => b.pushInfo()));
	pi.on("model_select", withBridge((b) => b.pushInfo()));
	pi.on("thinking_level_select", withBridge((b) => b.pushInfo()));
	pi.on("session_info_changed", withBridge((b) => b.pushInfo()));
	pi.on("session_compact", withBridge((b) => b.reset()));
	pi.on("session_tree", withBridge((b) => b.reset()));
	pi.on("ui_prompt_start", withBridge((b, e: any) => b.terminalPromptChanged(1, e.kind, e.title)));
	pi.on("ui_prompt_end", withBridge((b, e: any) => b.terminalPromptChanged(-1, e.kind, e.title)));

	pi.registerCommand("remote", {
		description: "Use every pi session on this machine from your phone (end-to-end encrypted)",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, c) => {
			ctx = c;
			const [sub = "", arg = ""] = args.trim().toLowerCase().split(/\s+/);
			switch (sub) {
				case "":
					return connect(c);
				case "pair":
					return pair(c, arg === "view" ? "view" : "control");
				case "off":
					return off(c);
				case "devices":
					return devices(c);
				case "settings":
					return settings(c);
				default:
					return c.ui.notify("Usage: /remote [pair [view] | off | devices | settings]", "info");
			}
		},
	});

	async function linked(c: ExtensionContext, timeoutMs = 8000): Promise<Bridge | undefined> {
		const b = start(c);
		const until = Date.now() + timeoutMs;
		while (!b.isLinked && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
		if (b.isLinked) return b;
		const s = b.linkState;
		c.ui.notify(`pi-mobile: ${s.kind === "error" ? s.message : "could not reach the hub"}`, "error");
		return undefined;
	}

	/** Turns the machine switch on and un-hides this session. */
	function enable(): void {
		g[HIDDEN] = false;
		const cfg = loadConfig();
		if (!cfg.enabled) saveConfig({ ...cfg, enabled: true });
	}

	/** `/remote`: connect the machine, then pair (first time) or show where things stand. */
	async function connect(c: ExtensionCommandContext): Promise<void> {
		enable();
		const b = await linked(c);
		if (!b) return;
		const s = await b.hubRequest<HubStatus>("status");
		if (!s.devices.length) return pair(c, "control");
		await overview(c, s);
	}

	async function overview(c: ExtensionCommandContext, s: HubStatus): Promise<void> {
		const t = c.ui.theme;
		const [primary, ...others] = s.endpoints;
		const sessions = [...s.agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		const phones = s.clients.count ? `${s.clients.count} phone${s.clients.count === 1 ? "" : "s"} connected` : "no phone connected right now";
		await panel(c, [
			t.bold(`pi-mobile · ${sessions.length} session${sessions.length === 1 ? "" : "s"} shared · ${phones}`),
			"",
			`Open on your phone: ${t.fg("accent", primary.url)}  ${t.fg("dim", primary.label)}`,
			...others.filter((o) => o.label !== "this computer").map((o) => t.fg("dim", `                    ${o.url}  ${o.label}`)),
			...(s.tunnelError ? [t.fg("error", `tunnel: ${s.tunnelError}`)] : []),
			"",
			...sessions.map((a) => {
				const me = a.pid === process.pid ? t.fg("dim", " (this one)") : "";
				return `${STATUS_ICON[a.status] ?? "○"} ${a.name}${me}  ${t.fg("dim", a.task ?? "")}`;
			}),
			"",
			t.fg("dim", "/remote pair  another device · /remote off  stop sharing · /remote settings"),
		]);
	}

	async function pair(c: ExtensionCommandContext, role: "control" | "view"): Promise<void> {
		enable();
		const b = await linked(c);
		if (!b) return;
		const pairing = await b.hubRequest<{ links: { label: string; url: string }[] }>("pair", { role });
		const [primary, ...others] = pairing.links;
		const header =
			role === "view" ? "Scan to watch this machine's pi sessions (view-only)" : "Scan with your phone to use every pi session on this machine";
		if (c.mode !== "tui") {
			c.ui.notify(`${header}:\n${pairing.links.map((l) => `${l.label}: ${l.url}`).join("\n")}`, "info");
			return;
		}
		const t = c.ui.theme;
		await panel(c, [
			t.bold(header),
			"",
			...qrLines(primary.url).lines,
			"",
			`${t.fg("accent", primary.label)}  ${primary.url}`,
			...others.filter((o) => o.label !== "this computer").map((o) => t.fg("dim", `${o.label}  ${o.url}`)),
			"",
			t.fg("dim", "Single-use code, valid 10 min. Traffic is end-to-end encrypted."),
			...(primary.label.startsWith("lan") ? [t.fg("dim", "On untrusted Wi-Fi use Tailscale or an HTTPS address (/remote settings).")] : []),
			t.fg("dim", "Closes by itself once your phone is paired; any key closes it now."),
		]);
	}

	async function off(c: ExtensionCommandContext): Promise<void> {
		const choice = c.hasUI
			? await c.ui.select("Stop sharing with your phone", ["Only this session", "Every session on this machine", "Cancel"])
			: "Every session on this machine";
		if (choice === "Only this session" || choice === "Every session on this machine") g[FLAG_OFF] = true;
		if (choice === "Only this session") {
			g[HIDDEN] = true;
			stop();
			c.ui.notify("This session is hidden from your phone. /remote shares it again.", "info");
		} else if (choice === "Every session on this machine") {
			saveConfig({ ...loadConfig(), enabled: false });
			g[HIDDEN] = false;
			stop();
			c.ui.notify("No pi session on this machine is shared now. Paired phones stay paired; /remote turns sharing back on.", "info");
		}
	}

	async function devices(c: ExtensionCommandContext): Promise<void> {
		const b = await linked(c, 3000);
		if (!b) return;
		const s = await b.hubRequest<HubStatus>("status");
		if (!s.devices.length) return c.ui.notify("No paired devices. /remote pairs one.", "info");
		const label = (d: HubStatus["devices"][number]) =>
			`${d.name} · ${d.role === "view" ? "view-only" : "full control"} · last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}`;
		const pick = await c.ui.select("Paired devices — choose one to revoke", [...s.devices.map(label), "Revoke all", "Done"]);
		if (!pick || pick === "Done") return;
		const ids = pick === "Revoke all" ? s.devices.map((d) => d.id) : s.devices.filter((d) => label(d) === pick).map((d) => d.id);
		const what = pick === "Revoke all" ? "every device" : pick.split(" · ")[0];
		if (!(await c.ui.confirm(`Revoke ${what}?`, "It loses access immediately and must be paired again."))) return;
		const removed = await b.hubRequest<{ name: string }[]>("revoke", { ids });
		c.ui.notify(`Revoked ${removed.map((d) => d.name).join(", ")}.`, "info");
	}

	async function settings(c: ExtensionCommandContext): Promise<void> {
		const cfg = loadConfig();
		const expose = `How phones reach this computer: ${cfg.expose}`;
		const url = `HTTPS address (for lock-screen notifications): ${cfg.publicUrl ?? "none"}`;
		const port = `Port: ${cfg.port}`;
		const pick = await c.ui.select("pi-mobile settings", [expose, url, port, "Done"]);
		const next: Config = { ...cfg };
		if (pick === expose) {
			const e = await c.ui.select("How phones reach this computer", [
				"network — Wi-Fi and Tailscale (default)",
				"local — this computer only (SSH forward or your own proxy)",
				"cloudflared — public HTTPS tunnel (needs cloudflared)",
			]);
			if (!e) return;
			next.expose = e.split(" ")[0] as Expose;
		} else if (pick === url) {
			const v = await c.ui.input(`HTTPS address that forwards to port ${cfg.port} (e.g. tailscale serve); empty to remove`, cfg.publicUrl ?? "https://");
			if (v === undefined) return;
			const trimmed = v.trim().replace(/\/+$/, "");
			const empty = !trimmed || trimmed === "https:";
			if (!empty && !/^https:\/\/[^\s/]+/.test(trimmed)) return c.ui.notify("That is not an https:// address.", "warning");
			next.publicUrl = empty ? undefined : trimmed;
		} else if (pick === port) {
			const v = await c.ui.input("Port (1024–65535)", String(cfg.port));
			if (v === undefined) return;
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1024 || n > 65535) return c.ui.notify("Port must be 1024–65535.", "warning");
			next.port = n;
		} else return;
		saveConfig(next);
		// Linked pi processes re-read the config when they reconnect, so restarting the hub applies it everywhere.
		if (bridge?.isLinked) await bridge.hubRequest("restart").catch(() => {});
		else closeProcessHub();
		c.ui.notify("Saved. The hub restarts with the new settings and phones reconnect by themselves (pair again if the address changed).", "info");
	}

	async function panel(c: ExtensionCommandContext, lines: string[]): Promise<void> {
		if (c.mode !== "tui") {
			c.ui.notify(lines.join("\n"), "info");
			return;
		}
		await c.ui.custom<void>(
			(_tui, theme, _kb, done) => {
				closePanel = () => {
					closePanel = undefined;
					done();
				};
				return {
					render(width: number) {
						const inner = Math.max(10, width - 4);
						const border = (s: string) => theme.fg("borderAccent", s);
						const out = [border(`╭${"─".repeat(inner + 2)}╮`)];
						for (const l of lines) {
							const cut = truncateToWidth(l, inner);
							out.push(`${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`);
						}
						out.push(border(`╰${"─".repeat(inner + 2)}╯`));
						return out;
					},
					handleInput() {
						closePanel?.();
					},
					invalidate() {},
				};
			},
			{
				overlay: true,
				overlayOptions: () => {
					const cols = process.stdout.columns || 100;
					const widest = Math.max(...lines.map((l) => visibleWidth(l)));
					return { anchor: "center", width: Math.min(widest + 4, cols - 2), maxHeight: "95%" };
				},
			},
		);
		closePanel = undefined;
	}
}

function rank(a: AgentInfo): number {
	return a.status === "waiting" ? 0 : a.status === "working" ? 1 : 2;
}

