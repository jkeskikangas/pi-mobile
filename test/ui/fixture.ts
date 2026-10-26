// UI fixture: a real hub with scripted sessions, for designing and screenshotting the phone app
// without running pi or a model. `npm run ui` prints a pairing link; open it in any browser.
//
//   node --experimental-strip-types test/ui/fixture.ts [port]
//
// Control it on stdin: `work` starts a streaming turn with a running tool, `ask` opens a confirm
// dialog, `pick` a select, `done` finishes the turn, `quiet` empties the second session.
// Composer dictation longer than a chunk becomes a draft through the real drafting engine with a
// scripted recogniser and models (set `window.PiDraftDebug = { minMs: 1500, maxMs: 2500 }` in the
// page for short chunks). `lose` makes the computer lose every open draft (as when pi restarts).
// Several machines: `box` starts a second computer (port + 1) and offers it to paired phones, as
// `/remote add` does; `box off` / `box on` take it away and bring it back.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Hub } from "../../src/hub.ts";
import { HubLink } from "../../src/link.ts";
import type { AgentInfo, Item } from "../../src/protocol.ts";
import { DeviceStore, OfferStore, PushStore } from "../../src/store.ts";
import { personaList } from "pi-speech/personas";
import { DRAFT_SYSTEM, RECONCILE_SYSTEM } from "pi-speech/drafting";
import { PhoneDrafts } from "pi-speech/phone-drafts";

const port = Number(process.argv[2] ?? 7979);
const dir = mkdtempSync(join(tmpdir(), "pi-mobile-ui-"));
const SECRET = "u".repeat(43);
const BOX_PORT = port + 1;
// The page may call the second fixture computer (not on a tailnet, so it is listed explicitly).
const config = { port, enabled: true, machineOrigins: [`http://127.0.0.1:${BOX_PORT}`] };
const laptop = { id: "fx-laptop", name: "MacBook Pro" };
// PI_MOBILE_FIXTURE_HTTPS=https://… pretends Tailscale Serve gave the hub that address (for the secure-address UI).
const https = process.env.PI_MOBILE_FIXTURE_HTTPS;
const hub = new Hub({
	config,
	secret: SECRET,
	devices: new DeviceStore(dir),
	push: new PushStore(dir),
	offers: new OfferStore(dir),
	machine: laptop,
	serve: https ? async () => ({ url: https }) : undefined,
});
await hub.listen();

const now = Date.now();
const md = `Found it. \`add()\` subtracted instead of adding, so every total in the report was off by twice the second operand.

**What I changed**

- \`calc.py\`: \`return a - b\` → \`return a + b\`
- \`test_calc.py\`: a regression test for negative numbers

\`\`\`python
def add(a, b):
    return a + b
\`\`\`

| Check | Result |
|---|---|
| unit tests | 42 passed |
| lint | clean |

All green. Want me to open a PR?`;

// A stand-in screenshot for the image thumbnails and viewer.
const shot = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="520"><rect width="780" height="520" fill="#f4f5f7"/><rect x="40" y="40" width="700" height="56" rx="10" fill="#dde3f0"/><text x="64" y="78" font-family="sans-serif" font-size="26" fill="#223">Monthly report · March</text>${[0, 1, 2, 3, 4]
	.map((i) => `<rect x="40" y="${128 + i * 64}" width="700" height="48" rx="8" fill="#fff"/><text x="64" y="${160 + i * 64}" font-family="sans-serif" font-size="22" fill="#334">Line ${i + 1}</text><text x="600" y="${160 + i * 64}" font-family="monospace" font-size="22" fill="${i === 4 ? "#c0392b" : "#334"}">${i === 4 ? "-1 204.50" : `${(i + 2) * 113}.00`}</text>`)
	.join("")}</svg>`;
const images = new Map<string, { data: string; mimeType: string }[]>([["u1", [{ data: Buffer.from(shot).toString("base64"), mimeType: "image/svg+xml" }]]]);

const items: Item[] = [
	{ k: "user", id: "u1", text: "The totals in the monthly report are wrong. Find out why and fix it.", images: 1, ts: now - 600_000 },
	{
		k: "assistant",
		id: "a1",
		ts: now - 590_000,
		model: "claude-opus-5-5",
		stop: "toolUse",
		blocks: [
			{ t: "thinking", text: "The report sums with `add()`; check calc.py first, then the tests." },
			{ t: "text", text: "Let me look at how totals are computed." },
			{ t: "tool", id: "t1", name: "read", title: "src/calc.py", args: '{\n "path": "src/calc.py"\n}' },
			{ t: "tool", id: "t2", name: "bash", title: "pytest -q", args: '{\n "command": "pytest -q"\n}' },
		],
	},
	{ k: "tool", id: "t1", name: "read", output: "def add(a, b):\n    return a - b\n", isError: false, truncated: false, ts: now - 589_000 },
	{
		k: "tool",
		id: "t2",
		name: "bash",
		output: "F.........................................\nFAILED test_calc.py::test_add_negative - assert -1 == 3\n1 failed, 41 passed in 0.31s",
		isError: true,
		truncated: false,
		ts: now - 588_000,
	},
	{
		k: "assistant",
		id: "a2",
		ts: now - 580_000,
		stop: "toolUse",
		blocks: [{ t: "tool", id: "t3", name: "edit", title: "src/calc.py", args: "" }],
	},
	{ k: "tool", id: "t3", name: "edit", output: "", diff: "@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b", isError: false, truncated: false, ts: now - 579_000 },
	{ k: "assistant", id: "a3", ts: now - 570_000, stop: "stop", blocks: [{ t: "text", text: md }] },
	// Extension messages: a long one (a pi-actors delivery, collapsed until tapped) and a short one (plain).
	{
		k: "custom",
		id: "c1",
		customType: "pi-actors",
		text: "■ Message from reviewer (msg reviewer:1:1):\nReviewed the totals fix. The change in `calc.py` is right and the regression test covers negative numbers.\n\nTwo things before the PR:\n- `report.py` still rounds each line before summing, so totals can drift by a cent; round once at the end.\n- The changelog entry is missing.\n\nEverything else looks good; no need to wait for me.",
		ts: now - 560_000,
	},
	{ k: "custom", id: "c2", customType: "notes", text: "Saved the review to `notes/totals.md`.", ts: now - 559_000 },
];

interface Fake {
	info: AgentInfo;
	items: Item[];
	link?: HubLink;
	n: number;
}

const fakes: Fake[] = [
	{
		info: { agent: "f-api", pid: 101, sessionId: "s1", name: "api", task: "The totals in the monthly report are wrong", cwd: "/Users/you/work/api", status: "idle", model: { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true }, thinking: "medium", context: { tokens: 41_000, window: 1_000_000, percent: 4.1 }, cost: 0.42, last: "All green. Want me to open a PR?", herdr: true },
		items,
		n: 0,
	},
	{
		info: { agent: "f-web", pid: 102, sessionId: "s2", name: "web", task: "Migrate the settings page to the new form components", cwd: "/Users/you/work/web", status: "working", since: now - 72_000, model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true }, thinking: "low", cost: 1.87, last: "Moving the validation into the shared hook next.", herdr: true },
		items: [{ k: "user", id: "w1", text: "Migrate the settings page to the new form components", images: 0, ts: now - 300_000 }],
		n: 0,
	},
	{
		info: { agent: "f-infra", pid: 103, sessionId: "s3", name: "infra", task: "Add a staging environment to the OpenTofu stack", cwd: "/Users/you/work/infra", status: "waiting", model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true }, thinking: "high", cost: 0.12, herdr: true },
		items: [],
		n: 0,
	},
];

const prompts = new Map<string, any[]>([["f-infra", [{ id: "pi1", kind: "confirm", title: "Allow tofu apply?", message: "bash wants to run: tofu apply -auto-approve" }]]]);

// Long dictation: the real drafting engine (pi-speech phone-drafts.ts) with a scripted recogniser (each chunk
// "hears" the next part of a ramble about upload retries) and scripted models that turn each part into
// section edits; the finishing check corrects one point, and a change by voice drops one.
const RAMBLE = [
	"So I want to rework how photo uploads behave on a bad connection. Uploads should retry by themselves with exponential backoff.",
	"Cap the retries at five, no wait, make it three. And show the progress of each upload in the list.",
	"The error message should say how long until the next try. Oh and the docs need a section on offline use.",
	"Not sure yet whether downloads should get the same cap.",
	"Also keep the queue when the app restarts.",
];
const CHANGES = ["Drop the point about the progress of each upload.", "Add that the retry button is disabled while the phone is offline."];
let changes = 0;
const EDITS: [RegExp, object[]][] = [
	[/rework how photo uploads/, [{ op: "add", section: "Goal", text: "Make photo uploads survive a bad connection." }, { op: "add", section: "Requirements", text: "Retry uploads automatically with exponential backoff" }]],
	[/Cap the retries/, [{ op: "add", section: "Requirements", text: "Cap retries at 5" }, { op: "add", section: "Requirements", text: "Show the progress of each upload in the list" }]],
	[/error message/, [{ op: "add", section: "Requirements", text: "The error message says how long until the next try" }, { op: "add", section: "Also mentioned", text: "The docs need a section on offline use" }]],
	[/downloads/, [{ op: "add", section: "Open questions", text: "Should downloads get the same retry cap?" }]],
	[/keep the queue/, [{ op: "add", section: "Requirements", text: "Keep the upload queue across app restarts" }]],
];
let heardChunks = 0;
let changing = false;
const openDrafts = new Set<string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drafts = new PhoneDrafts({
	stt: () => ({
		name: "apple",
		transcribe: async () => {
			await wait(300);
			return { text: changing ? CHANGES[changes++ % CHANGES.length]! : RAMBLE[heardChunks++ % RAMBLE.length]!, provider: "fixture" };
		},
	}),
	vocabulary: async () => ({ project: "api", files: [], recent: [] }),
	fast: async (system, user) => {
		await wait(1200);
		if (system !== DRAFT_SYSTEM) return '{"edits": []}';
		const speech = /NEW SPEECH[^\n]*:\n([\s\S]*)$/.exec(user)?.[1] ?? "";
		if (/Drop the point about the progress/.test(speech)) return JSON.stringify({ edits: [{ op: "remove", match: "progress of each upload" }] });
		if (/retry button is disabled/.test(speech)) return JSON.stringify({ edits: [{ op: "add", section: "Requirements", text: "The retry button is disabled while the phone is offline" }] });
		const edits = EDITS.filter(([re]) => re.test(speech)).flatMap(([, e]) => e);
		return JSON.stringify({ kind: "description", shape: "spec", title: "Photo upload retries", edits });
	},
	careful: async (system) => {
		await wait(1500);
		if (system !== RECONCILE_SYSTEM) return '{"edits": []}';
		return JSON.stringify({ edits: [{ op: "change", match: "Cap retries at 5", text: "Cap retries at 3", note: "You first said 5, later 3; kept 3." }] });
	},
	dir: () => join(dir, "drafts"),
});

function emit(f: Fake, ev: any): void {
	f.link?.send({ t: "ev", ev: { ...ev, n: ++f.n } });
}

function link(f: Fake, cfg: typeof config | typeof boxConfig, secret: string): void {
	f.link = new HubLink({
		config: () => cfg,
		secret,
		info: () => f.info,
		onRequest: (m, p) => {
			if (m === "snapshot") return { n: f.n, info: f.info, items: f.items, start: 0, total: f.items.length, tools: [], prompts: prompts.get(f.info.agent) ?? [] };
			if (m === "models")
				return {
					current: f.info.model,
					thinking: f.info.thinking,
					levels: ["off", "minimal", "low", "medium", "high", "xhigh"],
					models: fakes.map((x) => x.info.model).filter((x, i, a) => a.findIndex((y) => y?.id === x?.id) === i),
				};
			// herdr's "New session": logged with the computer it ran on, and the new session appears on that
			// computer, echoing the phone's spawn id so the phone opens it.
			if (m === "spawn") {
				const onBox = cfg === boxConfig;
				const cwd = String(p.cwd);
				console.log(`spawn ${onBox ? box.name : laptop.name} ${cwd}`);
				const n = Date.now();
				const nf: Fake = { info: { ...f.info, agent: `f-new${n}`, pid: n % 100000, sessionId: `s${n}`, name: basename(cwd), task: p.prompt || undefined, cwd, status: "idle", cost: 0, last: undefined, spawn: p.spawnId }, items: [], n: 0 };
				(onBox ? boxFakes : fakes).push(nf);
				link(nf, cfg, secret);
				return { name: nf.info.name, paneId: `p${n}` };
			}
			if (m === "commands") return [{ name: "review", description: "Review the current diff" }, { name: "compact", description: "Compact the conversation context" }];
			if (m === "answer") {
				prompts.set(f.info.agent, (prompts.get(f.info.agent) ?? []).filter((x) => x.id !== p.id));
				emit(f, { type: "prompt_end", id: p.id, by: "remote" });
				f.info = { ...f.info, status: "working" };
				emit(f, { type: "info", info: f.info });
				return { ok: true };
			}
			// Voice: dictation is "transcribed" after a beat; realtime is unavailable so voice mode runs basic.
			if (m === "transcribe") {
				// Logged so native end-to-end checks can see the call (native/ios/scripts/e2e.sh).
				console.log(`transcribe ${f.info.agent} ${String(p?.audio ?? "").length} chars ${p?.mime ?? ""}`);
				return new Promise((r) =>
					setTimeout(
						() =>
							r({
								raw: "um so in the report make the totals use add not subtract no wait also round to cents",
								text: "In the report, make the totals use `add` instead of subtract, and round them to cents.",
								editor: "In the report, make the totals use `add` instead of subtract, and round them to cents.",
								unclear: [],
								provider: "fixture",
								by: "fixture",
							}),
						1200,
					),
				);
			}
			if (m === "draftStart") {
				heardChunks = 0;
				return drafts.start(p).then((v) => {
					openDrafts.add(v.id);
					return v;
				});
			}
			if (m === "draftChunk") return drafts.chunk(p);
			if (m === "draftState") return drafts.state(p);
			if (m === "draftFinish") return drafts.finish(p);
			if (m === "draftEdit") {
				changing = true;
				return drafts.edit(p).finally(() => (changing = false));
			}
			if (m === "draftClose") return drafts.close(p);
			if (m === "distill") return { raw: p.raw, text: p.raw, editor: p.raw, unclear: [], by: "fixture" };
			if (m === "voiceSession") throw new Error("realtime voice is not set up");
			if (m === "speak") throw new Error("tts unavailable");
			if (m === "voices") return { personas: personaList(), sample: false };
			if (m === "voiceStatus") return { speech: "pi is idle.", status: f.info.status, elapsedMs: 0, tools: [], prompts: prompts.get(f.info.agent) ?? [] };
			if (m === "brief") return { speech: "Done. The totals now add instead of subtract.", more: [], report: "", by: "fixture" };
			if (m === "image") {
				const img = images.get(String(p.id))?.[Number(p.i) || 0];
				if (!img) throw new Error("that image is no longer in this session");
				return img;
			}
			if (m === "send") {
				const id = `u${Date.now()}`;
				if (p.images?.length) images.set(id, p.images);
				f.items.push({ k: "user", id, text: p.text, images: p.images?.length ?? 0, ts: Date.now() });
				emit(f, { type: "item", item: f.items.at(-1) });
				return { ok: true, delivered: f.info.status === "idle" ? "prompt" : p.mode === "followUp" ? "followUp" : "steer" };
			}
			return { ok: true };
		},
	});
	f.link.start();
}
for (const f of fakes) link(f, config, SECRET);

// ── a second computer ──────────────────────────────────────────────────────────────────────────
const boxDir = mkdtempSync(join(tmpdir(), "pi-mobile-ui-box-"));
const BOX_SECRET = "b".repeat(43);
const boxConfig = { port: BOX_PORT, enabled: true };
const box = { id: "fx-box", name: "hetzner-box" };
const boxFakes: Fake[] = [
	{
		info: { agent: "f-deploy", pid: 201, sessionId: "s4", name: "deploy", task: "Roll the API out to staging", cwd: "/home/you/api", status: "idle", model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true }, thinking: "low", cost: 0.4, last: "Staging is on 2026.10.3; health checks pass.", herdr: true },
		items: [{ k: "user", id: "d1", text: "Roll the API out to staging", images: 0, ts: now - 900_000 }],
		n: 0,
	},
];
let boxHub: Hub | undefined;
async function boxOn(): Promise<void> {
	if (boxHub) return;
	boxHub = new Hub({ config: boxConfig, secret: BOX_SECRET, devices: new DeviceStore(boxDir), push: new PushStore(boxDir), offers: new OfferStore(boxDir), machine: box });
	await boxHub.listen();
	for (const f of boxFakes) link(f, boxConfig, BOX_SECRET);
}
function boxOff(): void {
	for (const f of boxFakes) f.link?.stop();
	boxHub?.close();
	boxHub = undefined;
}
/** What `/remote add` does, minus ssh and HTTPS: enrol the box for every phone here, offer it to each. */
async function offerBox(prefix = "fx"): Promise<void> {
	await boxOn();
	const cli: any = await import(new URL("../../bin/pi-mobile.mjs", import.meta.url).href);
	const phones = new DeviceStore(dir).list();
	const push = new PushStore(dir);
	const out = await cli.enrol({ from: laptop.name, vapid: push.vapid, origin: `http://127.0.0.1:${BOX_PORT}`, phones: phones.map((p) => ({ id: p.id, name: p.name, sub: push.entries().find(([id]) => id === p.id)?.[1] })) }, boxDir);
	mkdirSync(join(dir, "offers"), { recursive: true });
	for (const d of out.devices)
		writeFileSync(join(dir, "offers", `${prefix}${d.phone}.json`), JSON.stringify({ id: `${prefix}${d.phone}`, device: d.phone, kind: "add", machine: box, origin: out.origin, d: d.d, k: d.k, from: laptop.name, createdAt: Date.now() }));
}

const [api, web] = fakes;
async function work(): Promise<void> {
	api.info = { ...api.info, status: "working", since: Date.now() - 4000 };
	emit(api, { type: "info", info: api.info });
	emit(api, { type: "item", item: { k: "user", id: "u9", text: "Yes, open a PR and link the ticket.", images: 0, ts: Date.now() } });
	emit(api, { type: "stream_start", key: "s9", ts: Date.now() });
	// The model takes a moment before its first token: the transcript's activity row covers it.
	await new Promise((r) => setTimeout(r, 1500));
	for (const chunk of ["Opening the PR. ", "I'll reference TUL-512 in the description ", "and request a review from the team."]) {
		emit(api, { type: "stream", key: "s9", i: 0, kind: "text", delta: chunk });
		await new Promise((r) => setTimeout(r, 150));
	}
	emit(api, { type: "item", replaces: "s9", item: { k: "assistant", id: "s9", ts: Date.now(), blocks: [{ t: "text", text: "Opening the PR. I'll reference TUL-512 in the description and request a review from the team." }, { t: "tool", id: "t9", name: "bash", title: "gh pr create --fill", args: "" }] } });
	emit(api, { type: "tool_start", id: "t9", name: "bash", title: "gh pr create --fill" });
	emit(api, { type: "tool_update", id: "t9", output: "Creating pull request for fix/add-sign into main in acme/api\n\nhttps://github.com/acme/api/pull/" });
}

createInterface({ input: process.stdin }).on("line", async (line) => {
	const cmd = line.trim();
	if (cmd === "work") await work();
	if (cmd === "ask") {
		const p = { id: `pa${Date.now()}`, kind: "confirm", title: "Allow file change?", message: "edit wants to modify src/report.py (+12 −4)" };
		prompts.set("f-api", [p]);
		api.info = { ...api.info, status: "waiting" };
		emit(api, { type: "info", info: api.info });
		emit(api, { type: "prompt", prompt: p });
	}
	if (cmd === "pick") {
		const p = { id: `pp${Date.now()}`, kind: "select", title: "Which branch should the PR target?", options: ["main", "release/2026.10", "develop"] };
		prompts.set("f-api", [p]);
		emit(api, { type: "prompt", prompt: p });
	}
	if (cmd === "perm") {
		const p = { id: `pm${Date.now()}`, kind: "permission", title: "Permission required", message: "api wants to use bash\ntofu apply -auto-approve\nMatched rule: tofu *" };
		prompts.set("f-api", [p]);
		emit(api, { type: "prompt", prompt: p });
	}
	if (cmd === "form") {
		const opt = (label: string, description: string) => ({ label, description });
		const p = {
			id: `pq${Date.now()}`,
			kind: "questionnaire",
			title: "2 questions",
			questions: [
				{ question: "Which database should the service use?", header: "Database", multiSelect: false, options: [opt("Postgres (Recommended)", "Relational, already running in staging"), opt("SQLite", "Embedded, no server to run")] },
				{ question: "Which extras do you want?", header: "Extras", multiSelect: true, options: [opt("Auth", "Login and sessions"), opt("Metrics", "Prometheus endpoint"), opt("Docs", "OpenAPI page")] },
			],
		};
		prompts.set("f-api", [p]);
		emit(api, { type: "prompt", prompt: p });
	}
	if (cmd === "done") {
		emit(api, { type: "tool_end", id: "t9", isError: false });
		emit(api, { type: "item", item: { k: "tool", id: "t9", name: "bash", output: "https://github.com/acme/api/pull/918", isError: false, truncated: false, ts: Date.now() } });
		api.info = { ...api.info, status: "idle" };
		emit(api, { type: "info", info: api.info });
	}
	if (cmd === "quiet") {
		web.items = [];
		emit(web, { type: "reset" });
	}
	if (cmd === "lose") {
		for (const id of openDrafts) drafts.close({ id, how: "discard" });
		openDrafts.clear();
	}
	if (cmd === "box") await offerBox();
	if (cmd === "box again") await offerBox("fx2");
	if (cmd === "box off") boxOff();
	if (cmd === "box on") await boxOn();
	if (cmd === "pair") console.log(hub.createPairing().links.map((l) => l.url).join("\n"));
});

const links = hub.createPairing().links;
console.log(`pi-mobile UI fixture on port ${port}. Pair:`);
for (const l of links) console.log(`  ${l.label}: ${l.url}`);
console.log("stdin: work | ask | pick | done | quiet | lose | pair | box | box again | box off | box on");
