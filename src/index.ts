// pi-mobile: continue pi sessions from a phone.
//
//   /remote                 share this session and show a pairing QR code
//   /remote view            QR for a view-only device (watch, cannot act)
//   /remote stop            stop sharing this session
//   /remote status          hub, endpoints, connected phones, sessions
//   /remote devices         paired devices;  /remote revoke <id|name|all>
//   /remote auto on|off     share every pi session automatically
//   /remote expose network|local|cloudflared,  /remote port <n>
//   /remote url <https://…|off>   HTTPS address in front of the hub (needed for lock-screen notifications)
//   /remote restart         restart the hub (applies port/exposure changes)

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Bridge } from "./bridge.ts";
import { closeProcessHub, type LinkState } from "./link.ts";
import { qrLines } from "./qr.ts";
import { type Config, type Expose, linkSecret, loadConfig, saveConfig } from "./store.ts";

const SHARING = Symbol.for("pi-mobile.sharing");
type G = typeof globalThis & { [SHARING]?: boolean };
const SUBCOMMANDS = ["view", "stop", "status", "devices", "revoke", "auto", "expose", "port", "url", "restart", "help"];

export default function remoteControl(pi: ExtensionAPI): void {
	let bridge: Bridge | undefined;
	let ctx: ExtensionContext | undefined;
	let closePanel: (() => void) | undefined;
	const g = globalThis as G;

	pi.registerFlag("remote", { type: "boolean", description: "Share this session with pi mobile (phone)" });

	const status = (s: LinkState | undefined) => {
		if (!ctx?.hasUI) return;
		const t = ctx.ui.theme;
		if (!s) return ctx.ui.setStatus("remote", undefined);
		if (s.kind === "connecting") return ctx.ui.setStatus("remote", t.fg("dim", "📱 connecting…"));
		if (s.kind === "error") return ctx.ui.setStatus("remote", t.fg("error", "📱 remote error"));
		const n = s.clients.count;
		ctx.ui.setStatus("remote", n ? t.fg("success", `📱 ${n} connected`) : t.fg("dim", "📱 remote on"));
	};

	const start = (c: ExtensionContext) => {
		if (bridge) return bridge;
		let lastError = "";
		const b = new Bridge(pi, c, loadConfig, linkSecret());
		b.onState = (s) => {
			status(s);
			if (s.kind === "error" && s.message !== lastError) {
				lastError = s.message;
				c.ui.notify(`pi mobile: ${s.message}`, "error");
			}
			if (s.kind === "linked") lastError = "";
		};
		b.onMessage = (msg) => {
			if (msg.t === "paired" && closePanel) {
				closePanel();
				ctx?.ui.notify(`📱 Paired ${msg.device.name}${msg.device.role === "view" ? " (view-only)" : ""}`, "info");
			}
		};
		bridge = b;
		g[SHARING] = true;
		b.start();
		return b;
	};

	const stop = () => {
		bridge?.stop();
		bridge = undefined;
		status(undefined);
	};

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		if (g[SHARING] || pi.getFlag("remote") === true || loadConfig().autoStart) start(c);
	});
	pi.on("session_shutdown", async (e) => {
		stop();
		if (e.reason === "quit") closeProcessHub();
	});

	const withBridge = <E>(fn: (b: Bridge, e: E, c: ExtensionContext) => void) =>
		async (e: E, c: ExtensionContext) => {
			ctx = c;
			if (!bridge) return;
			bridge.setContext(c);
			fn(bridge, e, c);
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
		description: "Control this pi session from your phone (QR pairing, end-to-end encrypted)",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, c) => {
			ctx = c;
			const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			switch (sub.toLowerCase()) {
				case "":
				case "on":
				case "start":
					return pairFlow(c, "control");
				case "view":
				case "share":
					return pairFlow(c, "view");
				case "stop":
				case "off":
					g[SHARING] = false;
					stop();
					return c.ui.notify("Phone access stopped for this session.", "info");
				case "status":
					return showStatus(c);
				case "devices":
					return showDevices(c);
				case "revoke":
					return revoke(c, arg);
				case "auto":
					return editConfig(c, (cfg) => {
						cfg.autoStart = arg !== "off";
						return `Auto-share ${cfg.autoStart ? "on: every new pi session is shared with your phone" : "off"}.`;
					});
				case "expose":
					if (!["network", "local", "cloudflared"].includes(arg))
						return c.ui.notify("Usage: /remote expose network|local|cloudflared", "warning");
					return editConfig(c, (cfg) => {
						cfg.expose = arg as Expose;
						return `Exposure set to ${arg}. Run /remote restart to apply.`;
					});
				case "port": {
					const port = Number(arg);
					if (!Number.isInteger(port) || port < 1024 || port > 65535) return c.ui.notify("Usage: /remote port <1024-65535>", "warning");
					return editConfig(c, (cfg) => {
						cfg.port = port;
						return `Port set to ${port}. Run /remote restart in every sharing pi (or restart them) to apply.`;
					});
				}
				case "url":
					if (arg && arg !== "off" && !/^https:\/\/[^\s/]+/.test(arg))
						return c.ui.notify("Usage: /remote url https://<host>[:port]  (e.g. your Tailscale Serve address), or /remote url off", "warning");
					return editConfig(c, (cfg) => {
						cfg.publicUrl = !arg || arg === "off" ? undefined : arg.replace(/\/+$/, "");
						return cfg.publicUrl ? `Public URL set to ${cfg.publicUrl}. Run /remote restart to apply.` : "Public URL removed. Run /remote restart to apply.";
					});
				case "restart":
					return restart(c);
				default:
					return c.ui.notify(
						"Usage: /remote [view|stop|status|devices|revoke <id|all>|auto on|off|expose network|local|cloudflared|port <n>|url <https://…|off>|restart]",
						"info",
					);
			}
		},
	});

	async function linked(c: ExtensionContext, timeoutMs = 8000): Promise<Bridge | undefined> {
		const b = start(c);
		const until = Date.now() + timeoutMs;
		while (!b.isLinked && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
		if (b.isLinked) return b;
		const s = b.linkState;
		c.ui.notify(`pi mobile: ${s.kind === "error" ? s.message : "could not reach the hub"}`, "error");
		return undefined;
	}

	async function pairFlow(c: ExtensionCommandContext, role: "control" | "view"): Promise<void> {
		const b = await linked(c);
		if (!b) return;
		const pairing = await b.hubRequest<{ links: { label: string; url: string }[]; expiresAt: number }>("pair", { role });
		const [primary, ...others] = pairing.links;
		const header = role === "view" ? "Scan to watch this machine's pi sessions (view-only)" : "Scan to control pi from your phone";
		if (c.mode !== "tui") {
			c.ui.notify(`${header}:\n${pairing.links.map((l) => `${l.label}: ${l.url}`).join("\n")}`, "info");
			return;
		}
		const qr = qrLines(primary.url);
		const t = c.ui.theme;
		const lines = [
			t.bold(header),
			"",
			...qr.lines,
			"",
			`${t.fg("accent", primary.label)}  ${primary.url}`,
			...others.filter((o) => o.label !== "this computer").map((o) => t.fg("dim", `${o.label}  ${o.url}`)),
			"",
			t.fg("dim", "Single-use code, valid 10 min. Traffic is end-to-end encrypted."),
			t.fg("dim", primary.label.startsWith("lan") ? "On untrusted Wi-Fi prefer Tailscale or /remote expose cloudflared." : ""),
			t.fg("dim", "Any key closes this panel; the session stays shared."),
		];
		await panel(c, lines);
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

	async function showStatus(c: ExtensionCommandContext): Promise<void> {
		if (!bridge) {
			const cfg = loadConfig();
			return c.ui.notify(`Phone access is off for this session. Config: port ${cfg.port}, expose ${cfg.expose}, auto ${cfg.autoStart ? "on" : "off"}. Run /remote to start.`, "info");
		}
		const b = await linked(c, 3000);
		if (!b) return;
		const s = await b.hubRequest<any>("status");
		const t = c.ui.theme;
		const lines = [
			t.bold("pi mobile"),
			`hub: pid ${s.pid}${s.pid === process.pid ? " (this pi)" : ""} · expose ${s.expose}`,
			...s.endpoints.map((e: any) => `  ${e.label}: ${e.url}`),
			...(s.tunnelError ? [t.fg("error", `  tunnel: ${s.tunnelError}`)] : []),
			"",
			`phones connected: ${s.clients.count}${s.clients.names.length ? ` (${s.clients.names.join(", ")})` : ""}`,
			`paired devices: ${s.devices.length}`,
			"",
			"shared sessions:",
			...s.agents.map((a: any) => `  ${a.status === "idle" ? "○" : a.status === "working" ? "●" : "◐"} ${a.name} — ${a.cwd} (pid ${a.pid})`),
		];
		await panel(c, lines);
	}

	async function showDevices(c: ExtensionCommandContext): Promise<void> {
		const b = await linked(c, 3000);
		if (!b) return;
		const s = await b.hubRequest<any>("status");
		if (!s.devices.length) return c.ui.notify("No paired devices. Run /remote to pair one.", "info");
		const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "never");
		await panel(c, [
			c.ui.theme.bold("Paired devices"),
			"",
			...s.devices.map((d: any) => `${d.id}  ${d.name}  ${d.role}  paired ${fmt(d.createdAt)}  last seen ${fmt(d.lastSeenAt)}`),
			"",
			c.ui.theme.fg("dim", "Revoke with /remote revoke <id|name|all>"),
		]);
	}

	async function revoke(c: ExtensionCommandContext, which: string): Promise<void> {
		if (!which) return c.ui.notify("Usage: /remote revoke <id|name|all>", "warning");
		const b = await linked(c, 3000);
		if (!b) return;
		const s = await b.hubRequest<any>("status");
		const ids = s.devices.filter((d: any) => which === "all" || d.id === which || d.name === which).map((d: any) => d.id);
		if (!ids.length) return c.ui.notify(`No device matches "${which}".`, "warning");
		const removed = await b.hubRequest<any[]>("revoke", { ids });
		c.ui.notify(`Revoked ${removed.map((d) => d.name).join(", ")}.`, "info");
	}

	function editConfig(c: ExtensionCommandContext, edit: (cfg: Config) => string): void {
		const cfg = loadConfig();
		const msg = edit(cfg);
		saveConfig(cfg);
		c.ui.notify(msg, "info");
	}

	async function restart(c: ExtensionCommandContext): Promise<void> {
		const b = bridge && (await linked(c, 3000));
		if (b) await b.hubRequest("restart").catch(() => {});
		else closeProcessHub();
		c.ui.notify("pi-mobile hub restarting with the current config.", "info");
	}
}
