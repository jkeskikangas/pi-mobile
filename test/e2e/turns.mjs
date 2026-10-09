// Turn-taking check for voice mode, with a scriptable microphone: getUserMedia is replaced by a
// WebAudio stream, and the test "speaks" clips at exact moments (a backchannel while pi talks, an
// interruption). Prints what happened and the latencies that matter.
//
//   node test/e2e/turns.mjs <pair-url> <question.wav> <mm-hmm.wav> <wait-stop.wav>
//
// PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs if playwright is not resolvable from here.

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const [url, question, mmhmm, stop] = process.argv.slice(2);
if (!stop) throw new Error("usage: turns.mjs <pair-url> <question.wav> <mm-hmm.wav> <wait-stop.wav>");

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(() => {
	const ac = new AudioContext({ sampleRate: 48000 });
	const dest = ac.createMediaStreamDestination();
	// A quiet room: real microphones never deliver digital silence, and end-of-turn detection
	// does not close a turn on it (seen with Chrome's fake device too).
	const noise = ac.createBuffer(1, 48000 * 2, 48000);
	const d = noise.getChannelData(0);
	for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.004;
	const room = ac.createBufferSource();
	room.buffer = noise;
	room.loop = true;
	room.connect(dest);
	room.start();
	window.__say = async (url) => {
		await ac.resume();
		const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
		const src = ac.createBufferSource();
		src.buffer = buf;
		src.connect(dest);
		src.start();
		return buf.duration;
	};
	navigator.mediaDevices.getUserMedia = async () => dest.stream;
});
const clips = { q: question, mm: mmhmm, stop };
await ctx.route("**/__clip/*", (route) => route.fulfill({ path: clips[route.request().url().split("/").pop()], contentType: "audio/wav" }));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await page.waitForSelector("#composer:not([hidden])", { timeout: 15000 });
await page.evaluate(() => {
	window.PiVoiceDebug = [];
	localStorage.setItem("pi-mobile-voice-intro", "1");
});
await page.click("#voiceBtn");
const state = () => page.evaluate(() => document.getElementById("voice").dataset.state);
const waitState = async (want, ms) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (want.includes(await state())) return true;
		await page.waitForTimeout(100);
	}
	return false;
};
const say = (k) => page.evaluate((u) => window.__say(u), `/__clip/${k}`);
const mark = (label) => page.evaluate((l) => window.PiVoiceDebug.push({ type: `#${l}`, _t: performance.now() }), label);

await waitState(["listening"], 15000);
await mark("question");
await say("q");
const spoke = await waitState(["speaking"], 60000);
console.log("pi answered out loud:", spoke);
await page.waitForTimeout(700);
await mark("mm-hmm");
await say("mm");
await page.waitForTimeout(2500);
const afterMm = await state();
console.log("after a backchannel while pi talks, state:", afterMm);

// Ask again, then interrupt.
await waitState(["listening"], 30000);
await mark("question2");
await say("q");
await waitState(["speaking"], 60000);
await page.waitForTimeout(600);
await mark("wait-stop");
const stopLen = await say("stop");
await page.waitForTimeout(stopLen * 1000 + 6000);

const ev = await page.evaluate(() => window.PiVoiceDebug.map((e) => ({ type: e.type, t: e._t, name: e.name })));
const after = (label, type) => {
	const m = ev.find((e) => e.type === `#${label}`);
	return m && ev.find((e) => e.t > m.t && e.type === type);
};
const between = (label, nextLabel, type) => {
	const m = ev.find((e) => e.type === `#${label}`);
	const n = nextLabel ? ev.find((e) => e.type === `#${nextLabel}`) : undefined;
	return ev.filter((e) => m && e.t > m.t && (!n || e.t < n.t) && e.type === type);
};
const ms = (a, b) => (a && b ? `${Math.round(b.t - a.t)} ms` : "n/a");
const q1Stop = after("question", "input_audio_buffer.speech_stopped");
console.log("end of question → pi's first audio:", ms(q1Stop, after("question", "output_audio_buffer.started")));
console.log("end of question → handed to pi:", ms(q1Stop, after("question", "response.function_call_arguments.done")));
console.log("backchannel: cancels sent:", between("mm-hmm", "question2", ">response.cancel").length, "(want 0)");
const stopAt = ev.find((e) => e.type === "#wait-stop");
console.log("interruption: you start talking → pi ducks:", ms(stopAt, after("wait-stop", "#duck")));
console.log("interruption: you start talking → pi silenced:", ms(stopAt, after("wait-stop", ">output_audio_buffer.clear")));
const committed = after("wait-stop", ">input_audio_buffer.commit");
console.log("interruption: your turn committed and answered:", !!committed && !!after("wait-stop", ">response.create"));
console.log("errors from the realtime API:", ev.filter((e) => e.type === "error").length);
if (process.env.DEBUG) console.log(ev.map((e) => `${Math.round(e.t)} ${e.type}`).join("\n"));
await page.screenshot({ path: "/tmp/pi-mobile-e2e-turns.png" });
await browser.close();
