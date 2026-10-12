// A long dictation on the phone becoming a draft, against a real pi: headless Chrome (output muted), the
// microphone a recording decoded in the page into a stream (never to a speaker; Chrome's
// --use-file-for-fake-audio-capture delivered only zeros here, Chrome 154 on macOS), the composer's mic
// tapped for the length of the recording, then ✓. Logs the draft sheet as it forms (blocks, the Hearing
// line, the clock), the check's note and the final Markdown, then optionally a change by voice from a
// second recording, and keeps the result as text.
//
//   node test/e2e/draft.mjs <pair-url> <speech.wav> <seconds> [change.wav]
//
// Uses puppeteer-core with the local Chrome (CHROME=/path to override). Setup as in docs/voice.md →
// Verification (isolated agent dir, demo repo, pi in tmux, test/e2e/pair.ts for the link).

import { existsSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { assertNoSound, NO_SOUND } from "../ui/no-sound.mjs";

const [url, wav, secs, change] = process.argv.slice(2);
if (!url || !wav || !secs) throw new Error("usage: draft.mjs <pair-url> <speech.wav> <seconds> [change.wav]");
const CHROME =
	process.env.CHROME ||
	["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function phone() {
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
	});
	const page = await browser.newPage();
	// No speech or audio may reach whoever runs this: --mute-audio doesn't cover speechSynthesis on macOS.
	await page.evaluateOnNewDocument(NO_SOUND);
	await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
	return { browser, page };
}

/** The next getUserMedia plays this recording into a stream (rendered without an output device). Returns its length in ms. */
const micFrom = (page, file) =>
	page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const c = new AudioContext({ sinkId: { type: "none" } });
		const buf = await c.decodeAudioData(bytes.buffer);
		navigator.mediaDevices.getUserMedia = async () => {
			await c.resume();
			const out = c.createMediaStreamDestination();
			const src = c.createBufferSource();
			src.buffer = buf;
			src.connect(out);
			src.start(c.currentTime + 0.2);
			return out.stream;
		};
		return buf.duration * 1000;
	}, readFileSync(file).toString("base64"));

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const sheet = (page) =>
	page.evaluate(() => {
		const s = document.querySelector("#draftSheet");
		if (!s || s.hidden) return null;
		return {
			ui: s.dataset.ui,
			title: document.querySelector("#draftTitle")?.textContent,
			blocks: [...document.querySelectorAll("#draftBody .draft-block")].map((b) => `${/glow|fade|marked/.test(b.className) && !/\bfade\b/.test(b.className) ? "* " : "  "}${b.classList.contains("removed") ? "~~" : ""}${b.textContent}`),
			glowing: document.querySelectorAll("#draftBody .draft-block.glow, #draftBody .draft-block.fade").length,
			hearing: document.querySelector("#draftHearing .draft-hearing-words")?.textContent,
			note: document.querySelector("#draftNote")?.textContent,
			clock: document.querySelector("#dictBar .rec-time")?.textContent,
		};
	});

const { browser, page } = await phone();
await page.goto(url);
await assertNoSound(page);
await page.waitForFunction(() => !document.querySelector("#composer").hidden, { timeout: 20000 });
await sleep(1000);
await micFrom(page, wav);
await page.tap("#micBtn");
console.log(at(), "mic on");
let last = "";
let shown = 0;
while (Date.now() - t0 < Number(secs) * 1000) {
	const s = await sheet(page);
	if (s && !shown) {
		shown = Date.now();
		console.log(at(), "draft sheet opened");
	}
	const key = JSON.stringify(s && [s.blocks.map((b) => b.slice(2)), s.hearing]);
	if (s && key !== last) {
		last = key;
		console.log(`${at()} [${s.ui}] ${s.clock} · ${s.title} · ${s.blocks.length} blocks, ${s.glowing} changed · hearing: ${s.hearing || "—"}`);
	}
	await sleep(250);
}
await page.screenshot({ path: "/tmp/pi-mobile-e2e-draft-forming.png" });
await page.tap("#dictBar .rec-done");
const stop = Date.now();
console.log(at(), "finished (✓)");
await page
	.waitForFunction(() => document.querySelector("#draftSheet")?.dataset.ui === "ready", { timeout: 120000, polling: 100 })
	.catch(async (e) => {
		console.log("no draft:", await page.evaluate(() => [document.querySelector("#dictBar").textContent, document.querySelector("#input").value]));
		throw e;
	});
const done = await sheet(page);
console.log(`${at()} ready ${((Date.now() - stop) / 1000).toFixed(1)} s after ✓ · note: ${done.note}`);
console.log(done.blocks.join("\n"));
await page.screenshot({ path: "/tmp/pi-mobile-e2e-draft-ready.png" });

if (change) {
	const ms = await micFrom(page, change);
	await sleep(3500);
	await page.tap("#micBtn");
	console.log(at(), "dictating a change");
	await sleep(ms + 1000);
	await page.tap("#dictBar .rec-done");
	const asked = Date.now();
	await page.waitForFunction(() => document.querySelector("#draftSheet")?.dataset.ui === "changing", { timeout: 20000, polling: 50 }).catch(() => {});
	await page.waitForFunction(() => document.querySelector("#draftSheet")?.dataset.ui === "ready", { timeout: 60000, polling: 50 });
	const changed = await sheet(page);
	console.log(`${at()} changed ${((Date.now() - asked) / 1000).toFixed(1)} s after ✓ · note: ${changed.note || "—"}`);
	console.log(changed.blocks.join("\n"));
	await page.screenshot({ path: "/tmp/pi-mobile-e2e-draft-changed.png" });
}

const markdown = await page.evaluate(() => {
	window.PiDraft.keepAsText();
	return document.querySelector("#input").value;
});
console.log(`\nkept as text:\n${markdown}`);
await browser.close();
