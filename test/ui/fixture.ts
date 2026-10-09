// UI fixture: a real hub with scripted sessions, for designing and screenshotting the phone app
// without running pi or a model. `npm run ui` prints a pairing link; open it in any browser.
//
//   node --experimental-strip-types test/ui/fixture.ts [port]
//
// Control it on stdin: `work` starts a streaming turn with a running tool, `ask` opens a confirm
// dialog, `pick` a select, `done` finishes the turn, `quiet` empties the second session.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Hub } from "../../src/hub.ts";
import { HubLink } from "../../src/link.ts";
import type { AgentInfo, Item } from "../../src/protocol.ts";
import { DeviceStore, PushStore } from "../../src/store.ts";

const port = Number(process.argv[2] ?? 7979);
const dir = mkdtempSync(join(tmpdir(), "pi-mobile-ui-"));
const SECRET = "u".repeat(43);
const config = { port, expose: "network" as const, enabled: true };
const hub = new Hub({ config, secret: SECRET, devices: new DeviceStore(dir), push: new PushStore(dir) });
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

const items: Item[] = [
	{ k: "user", id: "u1", text: "The totals in the monthly report are wrong. Find out why and fix it.", images: 0, ts: now - 600_000 },
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

function emit(f: Fake, ev: any): void {
	f.link?.send({ t: "ev", ev: { ...ev, n: ++f.n } });
}

for (const f of fakes) {
	f.link = new HubLink({
		config: () => config,
		secret: SECRET,
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
			if (m === "commands") return [{ name: "review", description: "Review the current diff" }, { name: "compact", description: "Compact the conversation context" }];
			if (m === "answer") {
				prompts.set(f.info.agent, (prompts.get(f.info.agent) ?? []).filter((x) => x.id !== p.id));
				emit(f, { type: "prompt_end", id: p.id, by: "remote" });
				f.info = { ...f.info, status: "working" };
				emit(f, { type: "info", info: f.info });
				return { ok: true };
			}
			if (m === "send") {
				f.items.push({ k: "user", id: `u${Date.now()}`, text: p.text, images: p.images?.length ?? 0, ts: Date.now() });
				emit(f, { type: "item", item: f.items.at(-1) });
				return { ok: true, delivered: f.info.status === "idle" ? "prompt" : p.mode === "followUp" ? "followUp" : "steer" };
			}
			return { ok: true };
		},
	});
	f.link.start();
}

const [api, web] = fakes;
async function work(): Promise<void> {
	api.info = { ...api.info, status: "working", since: Date.now() - 4000 };
	emit(api, { type: "info", info: api.info });
	emit(api, { type: "item", item: { k: "user", id: "u9", text: "Yes, open a PR and link the ticket.", images: 0, ts: Date.now() } });
	emit(api, { type: "stream_start", key: "s9", ts: Date.now() });
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
	if (cmd === "pair") console.log(hub.createPairing("control").links.map((l) => l.url).join("\n"));
});

const lan = hub.createPairing("control").links;
console.log(`pi-mobile UI fixture on port ${port}. Pair:`);
for (const l of lan) console.log(`  ${l.label}: ${l.url}`);
console.log("stdin: work | ask | pick | done | quiet | pair");
