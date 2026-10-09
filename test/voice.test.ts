// Voice: vocabulary matching, intent distillation, writing for the ear, realtime setup, voice host.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DISTILL_SYSTEM, distill, distillPrompt, editorText, heuristicDistill, parseDistilled } from "../src/voice/distill.ts";
import { VoiceHost } from "../src/voice/host.ts";
import { pickVoiceModel } from "../src/voice/model.ts";
import { chatgptAccountId, createCall, realtimeSession, VOICE_TOOLS, voiceInstructions } from "../src/voice/realtime.ts";
import { agentVoiceNote, BRIEF_SYSTEM, brief, changedAreas, describeActivity, digestText, heuristicBrief, parseBrief, runDigest, speakable } from "../src/voice/speech.ts";
import { pcmToWav } from "../src/voice/stt.ts";
import { extractNames, matchNames, recentNames, recognizerHints, sayName, spokenWords, type Vocabulary } from "../src/voice/vocab.ts";

const vocab: Vocabulary = {
	project: "pi-mobile",
	branch: "feat/voice-mode",
	files: ["src/auth.ts", "src/users/getUserById.ts", "src/hub.ts", "web/app.js", "README.md"],
	recent: ["validateToken", "src/bridge.ts"],
};

const msg = (role: string, content: any, extra: any = {}) => ({ type: "message", message: { role, content, ...extra } });

test("spoken forms of code names", () => {
	assert.deepEqual(spokenWords("getUserById"), ["get", "user", "by", "id"]);
	assert.deepEqual(spokenWords("auth.ts"), ["auth", "dot", "ts"]);
	assert.deepEqual(spokenWords("HTTPServer2_config"), ["http", "server", "2", "config"]);
	assert.equal(sayName("src/users/getUserById.ts"), "get user by id dot ts");
});

test("recogniser mistakes map back to real names", () => {
	const m = matchNames("Please refractor the get userbide function in orthodotts and run the test.", vocab);
	const names = m.map((x) => x.name);
	assert.ok(names.includes("src/auth.ts"), JSON.stringify(m));
	assert.ok(names.includes("src/users/getUserById.ts"), JSON.stringify(m));
	assert.ok(!names.includes("README.md"));
	assert.equal(m.find((x) => x.name === "validateToken"), undefined);
	assert.ok(matchNames("call validate token first", vocab).some((x) => x.name === "validateToken"));
});

test("name matching stays fast on a large repo", () => {
	const files = Array.from({ length: 5000 }, (_, i) => `src/module${i}/someComponentName${i}.tsx`);
	const t0 = performance.now();
	matchNames("so I want you to look at the user profile component and the settings page and then run all the tests again please".repeat(2), { ...vocab, files });
	const ms = performance.now() - t0;
	assert.ok(ms < 1500, `took ${ms} ms`);
});

test("declared code symbols, compound names first", async () => {
	const { parseSymbols } = await import("../src/voice/vocab.ts");
	const out = "const text\nconst text\nconst text\nfunction getUserById\nclass Hub\ndef parse_config\nlet x\nconst default\nfn validateToken";
	// Compound names outrank a local used three times; names under four letters and keywords are dropped.
	assert.deepEqual(parseSymbols(out), ["getUserById", "parse_config", "validateToken", "text"]);
});

test("names and recogniser hints come from the session and repo", () => {
	assert.deepEqual(extractNames("Edit `src/hub.ts` and call fooBar() then snake_case_name in web/app.js"), ["src/hub.ts", "fooBar", "snake_case_name", "web/app.js"]);
	const branch = [msg("user", "fix parseConfig"), msg("assistant", [{ type: "text", text: "Changed `loadConfig` in store.ts" }])];
	assert.deepEqual(recentNames(branch), ["loadConfig", "store.ts", "parseConfig"]);
	const hints = recognizerHints(vocab);
	assert.ok(hints.includes("pi-mobile") && hints.includes("voice") && hints.includes("auth.ts") && hints.includes("validateToken"));
});

test("distillation prompt grounds the dictation in the workspace and context", () => {
	const branch = [msg("assistant", [{ type: "text", text: "Option one: cache it. Option two: index it." }])];
	const p = distillPrompt("go with the second option in orthodotts", vocab, branch, "Also:");
	assert.match(p, /src\/auth\.ts\s+\(maybe heard as "orthodotts"\)/);
	assert.match(p, /RECENT CONTEXT[\s\S]*Option two/);
	assert.match(p, /ALREADY TYPED[\s\S]*Also:/);
	assert.match(p, /DICTATION:\ngo with the second option/);
	assert.match(DISTILL_SYSTEM, /never answer/i);
});

test("distilled output and unclear points are parsed for the editor", () => {
	const d = parseDistilled("Rename `getUser` to `getUserById`.\n---unclear---\n- In both packages or only the API?\n");
	assert.equal(d.text, "Rename `getUser` to `getUserById`.");
	assert.deepEqual(d.unclear, ["In both packages or only the API?"]);
	assert.equal(editorText(d), "Rename `getUser` to `getUserById`.\n\nUnclear:\n- In both packages or only the API?");
	assert.deepEqual(parseDistilled("Just this."), { text: "Just this.", unclear: [] });
});

test("distill uses the model and falls back to local cleanup", async () => {
	let seen = "";
	const ok = await distill("um so uh fix the get user by id thing", vocab, [], async (_s, u) => {
		seen = u;
		return "Fix `getUserById`.";
	});
	assert.equal(ok.by, "model");
	assert.equal(ok.text, "Fix `getUserById`.");
	assert.match(seen, /getUserById/);
	const failed = await distill("um so uh fix the get user by id thing", vocab, [], async () => {
		throw new Error("offline");
	});
	assert.equal(failed.by, "heuristic");
	assert.equal(failed.error, "offline");
	assert.equal(failed.text, "So fix the `getUserById.ts` thing.");
});

test("heuristic cleanup drops fillers and scratched sentences, flags mid-sentence corrections", () => {
	const a = heuristicDistill("um add a test. scratch that. uh update the readme", vocab);
	assert.equal(a.text, "Update the `README.md`.");
	const b = heuristicDistill("change the port to 80 no wait 8080", vocab);
	assert.equal(b.unclear.length, 1);
});

test("speakable() writes for the ear", () => {
	const s = speakable(
		"## Done\nFixed `getUserById` in `src/users/getUserById.ts`:\n```ts\nconst x = 1;\n```\n- Tests pass -> 12/12\n- See https://example.com/x\n| a | b |\n|---|---|\n| 1 | 2 |",
	);
	assert.doesNotMatch(s, /```|`|#|https?:|\||const x/);
	assert.match(s, /get user by id/);
	assert.match(s, /a link/);
	assert.equal(speakable("Run with `--force` on snake_case_name"), "Run with dash dash force on snake case name");
});

const runBranch = [
	msg("user", "fix the login bug"),
	msg("assistant", [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/auth.ts" } }, { type: "toolCall", id: "t2", name: "bash", arguments: { command: "npm test" } }]),
	msg("toolResult", [{ type: "text", text: "ok" }], { toolCallId: "t1", toolName: "edit", details: { diff: "+a\n+b\n-c" } }),
	msg("toolResult", [{ type: "text", text: "2 failing\nFAIL login.test.ts" }], { toolCallId: "t2", toolName: "bash", isError: true }),
	msg("assistant", [{ type: "text", text: "Fixed the token check in `src/auth.ts`, but two tests still fail. Should I update the fixtures?" }], { stopReason: "stop" }),
];

test("run digest captures edits, commands and the reply", () => {
	const d = runDigest(runBranch);
	assert.equal(d.request, "fix the login bug");
	assert.deepEqual(d.edits, [{ path: "src/auth.ts", added: 2, removed: 1 }]);
	assert.equal(d.commands[0].ok, false);
	assert.match(d.commands[0].tail, /FAIL login/);
	assert.match(d.final, /Should I update the fixtures\?/);
});

test("spoken brief: model output is cleaned, fallback leads with the outcome and keeps the question", async () => {
	const b = parseBrief("Fixed the login bug in `auth.ts`; two tests still fail.\nMORE: the failing tests; the change");
	assert.equal(b.speech, "Fixed the login bug in auth dot ts; two tests still fail.");
	assert.deepEqual(b.more, ["the failing tests", "the change"]);
	const h = heuristicBrief(runDigest(runBranch), "eyes-busy");
	assert.match(h.speech, /^Fixed the token check in auth dot ts, but two tests still fail\./);
	assert.match(h.speech, /Should I update the fixtures\?$/);
	const viaModel = await brief(runDigest(runBranch), "glance", async (sys, user) => {
		assert.match(sys, /may glance/);
		assert.match(sys, /behaviour, design, decisions/);
		assert.match(user, /AREAS CHANGED: auth \(1 file\); 1 files, about 3 lines/);
		assert.match(user, /FAILED COMMANDS \(routine[^)]*\): npm test/);
		return "Login fixed, two tests fail. Update the fixtures?";
	});
	assert.equal(viaModel.by, "model");
});

test("the voice report talks in areas and significant actions, not tool chatter", () => {
	assert.deepEqual(changedAreas([
		{ path: "src/voice/stt.ts", added: 10, removed: 2 },
		{ path: "src/voice/mic.ts", added: 5, removed: 0 },
		{ path: "web/app.js", added: 1, removed: 1 },
	]), [{ area: "voice", files: 2, lines: 17 }, { area: "web", files: 1, lines: 2 }]);
	const d = runDigest([
		msg("user", "ship it"),
		msg("assistant", [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "rg foo" } }, { type: "toolCall", id: "b", name: "bash", arguments: { command: "git push origin main" } }]),
		msg("toolResult", [{ type: "text", text: "x" }], { toolCallId: "a", toolName: "bash" }),
		msg("toolResult", [{ type: "text", text: "rejected: non-fast-forward" }], { toolCallId: "b", toolName: "bash", isError: true }),
		msg("assistant", [{ type: "text", text: "The push was rejected." }]),
	]);
	const r = digestText(d);
	assert.match(r, /SIGNIFICANT ACTION FAILED: git push origin main\n  last output: rejected/);
	assert.doesNotMatch(r, /rg foo/);
	assert.match(BRIEF_SYSTEM("eyes-busy"), /No identifiers, file names/);
});

test("the agent is told when its user listens instead of reads", () => {
	assert.match(agentVoiceNote("eyes-busy"), /cannot look at a screen/);
	assert.match(agentVoiceNote("eyes-busy"), /explicit confirmation that names the action/);
	assert.doesNotMatch(agentVoiceNote("glance"), /cannot look/);
});

test("running tools are described by what they do, never by name or path", () => {
	assert.equal(describeActivity("bash", "npm test -- --watch=false"), "running the tests");
	assert.equal(describeActivity("edit", "src/auth.ts, src/hub.ts"), "changing code");
	assert.equal(describeActivity("grep", "foo"), "searching the code");
	assert.equal(describeActivity("bash", "psql $PROD_DATABASE_URL -c 'delete from users'"), "running a production database command");
	assert.equal(describeActivity("bash", "git push --force"), "running a change to shared version history");
});

test("voice model: a fast model from the session's provider first", () => {
	const models = [
		{ provider: "claude-sdk", id: "claude-opus-5-5" },
		{ provider: "claude-sdk", id: "claude-haiku-5-5" },
		{ provider: "openai-codex", id: "gpt-6-mini" },
	];
	assert.equal(pickVoiceModel(models, models[0])?.id, "claude-haiku-5-5");
	assert.equal(pickVoiceModel(models, { provider: "openai-codex", id: "gpt-6" })?.id, "gpt-6-mini");
	assert.equal(pickVoiceModel(models, models[0], "openai-codex/gpt-6-mini")?.id, "gpt-6-mini");
	assert.equal(pickVoiceModel([models[0]], models[0])?.id, "claude-opus-5-5");
});

test("realtime session: voice layer instructions, tools, semantic turn detection", () => {
	const s: any = realtimeSession({ mode: "eyes-busy", project: "pi-mobile", hints: ["getUserById"], language: "fi-FI" });
	assert.equal(s.type, "realtime");
	assert.equal(s.audio.input.turn_detection.type, "semantic_vad");
	assert.equal(s.audio.input.turn_detection.interrupt_response, true);
	assert.equal(s.audio.input.transcription.language, "fi");
	assert.equal(s.audio.input.transcription.prompt, undefined, "a transcription prompt leaks into transcripts of short audio");
	assert.match(s.instructions, /getUserById/, "names go to the voice model instead");
	assert.deepEqual(
		VOICE_TOOLS.map((t) => t.name),
		["ask_pi", "answer_question", "stop_pi", "pi_status", "pi_details", "switch_session", "remain_silent"],
	);
	const i = voiceInstructions("eyes-busy", "pi-mobile");
	assert.match(i, /\[PI\]/);
	assert.match(i, /Never read code/);
	assert.match(i, /only answer yes when the developer confirms that action by name/);
	assert.match(i, /Consent given before the question appeared does not count/);
	assert.match(i, /ask them to repeat instead of guessing a task/);
});

test("realtime call: ChatGPT sign-in posts JSON to the Codex endpoint, an API key posts multipart", async () => {
	const calls: { url: string; init: any }[] = [];
	const fake = (async (url: string, init: any) => {
		calls.push({ url, init });
		return new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_abc" } });
	}) as any;
	const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.y`;
	assert.equal(chatgptAccountId(jwt), "acct-1");
	const r = await createCall({ kind: "chatgpt", token: jwt, accountId: "acct-1" }, "v=0 offer", { type: "realtime" }, fake);
	assert.deepEqual(r, { sdp: "v=0\r\nanswer", callId: "rtc_abc" });
	assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/realtime/calls");
	assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct-1");
	assert.deepEqual(JSON.parse(calls[0].init.body), { sdp: "v=0 offer", session: { type: "realtime" } });
	await createCall({ kind: "api-key", token: "sk-1" }, "v=0 offer", {}, fake);
	assert.equal(calls[1].url, "https://api.openai.com/v1/realtime/calls");
	assert.ok(calls[1].init.body instanceof FormData);
	const blocked = (async () => new Response("<html>challenge</html>", { status: 403 })) as any;
	await assert.rejects(createCall({ kind: "chatgpt", token: jwt }, "v=0", {}, blocked), /blocked by the service/);
});

function host(over: Partial<ConstructorParameters<typeof VoiceHost>[0]> = {}) {
	const branch = runBranch;
	const ctx: any = { cwd: "/tmp/not-a-repo-pi-mobile", sessionManager: { getBranch: () => branch }, modelRegistry: {} };
	return new VoiceHost({
		ctx: () => ctx,
		config: () => ({}),
		stateDir: () => "/tmp",
		complete: async () => "Fix the token check.",
		stt: () => ({ name: "apple", transcribe: async (audio, mime) => ({ text: `heard ${audio.length} bytes of ${mime}`, provider: "fake" }) }),
		credentials: async () => undefined,
		...over,
	});
}

test("voice host: transcribe then distil", async () => {
	const r: any = await host().transcribe({ audio: Buffer.from("abcd").toString("base64"), mime: "audio/webm" });
	assert.equal(r.raw, "heard 4 bytes of audio/webm");
	assert.equal(r.text, "Fix the token check.");
	assert.equal(r.by, "model");
	const plain: any = await host().transcribe({ audio: Buffer.from("ab").toString("base64"), mime: "audio/mp4", distill: false });
	assert.equal(plain.text, "heard 2 bytes of audio/mp4");
	await assert.rejects(host().transcribe({}), /no audio/);
});

test("voice host: brief, details without a model, and listening state", async () => {
	const h = host();
	const b = await h.brief({ mode: "eyes-busy" });
	assert.equal(b.speech, "Fix the token check.");
	assert.match(b.report, /AREAS CHANGED/);
	assert.equal((await h.details({ topic: "which files changed?" })).speech, "one file changed: auth dot ts, two lines added and one line removed.");
	assert.equal(h.listeningMode(), undefined);
	h.setListening({ on: true, mode: "glance" });
	assert.equal(h.listeningMode(), "glance");
	assert.equal(h.listeningMode(Date.now() + 200_000), undefined);
	h.setListening({ on: false });
	assert.equal(h.listeningMode(), undefined);
});

test("voice host: realtime needs credentials and is explained when missing", async () => {
	await assert.rejects(host().voiceSession({ sdp: "v=0" }), /realtime unavailable: sign in/);
	await assert.rejects(host({ config: () => ({ realtime: "off" }) }).voiceSession({ sdp: "v=0" }), /realtime unavailable: turned off/);
	let body: any;
	const h = host({
		credentials: async () => ({ kind: "chatgpt", token: "t" }),
		fetch: (async (_u: string, init: any) => {
			body = JSON.parse(init.body);
			return new Response("v=0 answer", { status: 201 });
		}) as any,
	});
	const r = await h.voiceSession({ sdp: "v=0 offer", mode: "glance" });
	assert.equal(r.sdp, "v=0 answer");
	assert.equal(body.session.audio.input.turn_detection.type, "semantic_vad");
	const server: any = realtimeSession({ mode: "glance", project: "p", turnDetection: "server" });
	assert.equal(server.audio.input.turn_detection.type, "server_vad");
});

test("OpenAI transcription: vocabulary as a prompt, and a leaked prompt is not speech", async () => {
	const { openaiProvider } = await import("../src/voice/stt.ts");
	let sent: FormData | undefined;
	const reply = (text: string) =>
		(async (_u: string, init: any) => {
			sent = init.body;
			return new Response(JSON.stringify({ text }), { status: 200 });
		}) as any;
	const ok = await openaiProvider("sk", reply("Fix the hub.")).transcribe(Buffer.from("x"), "audio/webm", ["getUserById"]);
	assert.equal(ok.text, "Fix the hub.");
	assert.match(String(sent!.get("prompt")), /getUserById/);
	assert.equal(sent!.get("model"), "gpt-4o-transcribe");
	const leaked = await openaiProvider("sk", reply("Software development dictation. Names: getUserById")).transcribe(Buffer.from("x"), "audio/webm", ["getUserById"]);
	assert.equal(leaked.text, "");
});

test("PCM is wrapped as WAV", () => {
	const w = pcmToWav(Buffer.alloc(320), 16000);
	assert.equal(w.toString("ascii", 0, 4), "RIFF");
	assert.equal(w.readUInt32LE(24), 16000);
	assert.equal(w.length, 364);
});
