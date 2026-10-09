// Drives the phone app in headless Chromium with a fake microphone that plays a WAV file.
//
//   node test/e2e/browser.mjs dictate <pair-url> <speech.wav>
//   node test/e2e/browser.mjs voice   <pair-url> <speech.wav> [seconds] [eyes-busy|glance]
//
// PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs if playwright is not resolvable from here.
// See docs/voice.md → Verification for the setup (isolated agent dir, demo repo, pi in tmux).

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const [mode, url, wav, secs = "60", attention = "eyes-busy"] = process.argv.slice(2);
if (!mode || !url || !wav) throw new Error("usage: browser.mjs dictate|voice <pair-url> <speech.wav> [seconds] [eyes-busy|glance]");

const browser = await chromium.launch({
	args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await (await browser.newContext({ permissions: ["microphone"], viewport: { width: 390, height: 844 } })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await page.waitForSelector("#composer:not([hidden])", { timeout: 15000 });
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);

if (mode === "dictate") {
	await page.click("#micBtn");
	await page.waitForTimeout(Number(secs) * 1000 || 11000);
	await page.click("#micBtn");
	const stop = Date.now();
	await page.waitForFunction(() => document.getElementById("input").value.length > 0, null, { timeout: 60000 });
	console.log(`distilled ${Date.now() - stop} ms after the mic stopped:\n${await page.inputValue("#input")}`);
	console.log("bar:", await page.textContent("#dictBar .grow"));
	await page.click("#dictBar button:has-text('raw')");
	console.log(`raw:\n${await page.inputValue("#input")}`);
	console.log("bar:", await page.textContent("#dictBar .grow"));
} else {
	await page.evaluate((m) => {
		window.PiVoiceDebug = [];
		localStorage.setItem("pi-mobile-voice-attention", m);
	}, attention);
	await page.click("#voiceBtn");
	const last = {};
	while (Date.now() - t0 < Number(secs) * 1000) {
		const s = await page.evaluate(() => Object.fromEntries(["vState", "vHeard", "vSaid", "vNote", "vEngine"].map((id) => [id, document.getElementById(id).textContent])));
		for (const [k, v] of Object.entries(s)) if (v !== last[k] && v) console.log(at(), k.slice(1).toUpperCase(), v);
		Object.assign(last, s);
		await page.waitForTimeout(250);
	}
	const calls = await page.evaluate(() => window.PiVoiceDebug.filter((e) => e.type === "response.function_call_arguments.done").map((e) => `${e.name} ${e.arguments}`));
	for (const c of calls) console.log("tool:", c);
	await page.click("#vEnd");
}
await page.screenshot({ path: `/tmp/pi-mobile-e2e-${mode}.png` });
await browser.close();
