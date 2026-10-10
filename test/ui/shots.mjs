// Screenshots of every phone UI state, each scanned with axe (WCAG 2.2 AA), against the scripted hub
// in fixture.ts. This is the visual check for any change in web/ (docs/ui.md → Checks).
//
//   npm run shots                        light + dark at 390 and 320 px, into shots/
//   npm run shots -- --out /tmp/s --width 390 --theme dark --only voice
//   npm run shots -- --forced            forced colours (Windows high contrast)
//   npm run shots -- --reduced           reduced motion
//
// Flows: app (pairing, sessions, transcript, tools, questions, sheets, focus ring), voice (dictation and
// every voice-mode state, settings, push to talk), picker (the voice picker from the menu and voice mode).
// Needs Chrome or Chromium: CHROME=/path/to/chrome when it isn't in the usual place. Exits 1 on any axe
// violation, page error or failed step; report.json in the output folder lists them.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";

const { values: opt } = parseArgs({
	options: {
		out: { type: "string", default: "shots" },
		width: { type: "string", default: "390,320" },
		theme: { type: "string", default: "light,dark" },
		only: { type: "string", default: "app,voice,picker" },
		port: { type: "string", default: "7979" },
		forced: { type: "boolean", default: false },
		reduced: { type: "boolean", default: false },
	},
});
const CHROME =
	process.env.CHROME ||
	["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!CHROME) throw new Error("no Chrome found: set CHROME=/path/to/chrome");
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const FIXTURE = new URL("./fixture.ts", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(opt.out, { recursive: true });

// A silent microphone, so basic voice hears nothing instead of Chrome's fake beep.
const silence = join(tmpdir(), "pi-mobile-silence.wav");
if (!existsSync(silence)) {
	const n = 16000 * 4;
	const b = Buffer.alloc(44 + n * 2);
	b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
	b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
	writeFileSync(silence, b);
}

const report = { errors: [], axe: {}, checks: {} };

async function session(theme, width, flow) {
	const fx = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", FIXTURE, opt.port], { stdio: ["pipe", "pipe", "inherit"] });
	let buf = "";
	const link = await new Promise((resolve, reject) => {
		fx.on("exit", (c) => reject(new Error(`fixture exited (${c}); is port ${opt.port} in use?`)));
		fx.stdout.on("data", (d) => {
			buf += d;
			const m = /this computer: (\S+)/.exec(buf);
			if (m) resolve(m[1]);
		});
	});
	await sleep(1500); // let the scripted sessions link
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${silence}`, "--autoplay-policy=no-user-gesture-required"],
	});
	const page = await browser.newPage();
	await page.setViewport({ width, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	await page.emulateMediaFeatures([
		{ name: "prefers-color-scheme", value: theme },
		...(opt.forced ? [{ name: "forced-colors", value: "active" }] : []),
		...(opt.reduced ? [{ name: "prefers-reduced-motion", value: "reduce" }] : []),
	]);
	const tag = `${theme}-${width}${opt.forced ? "-forced" : ""}${opt.reduced ? "-reduced" : ""}`;
	page.on("pageerror", (e) => report.errors.push(`${tag} ${flow}: ${e.message}`));
	page.on("console", (m) => m.type() === "error" && report.errors.push(`${tag} ${flow} console: ${m.text()}`));

	const say = async (cmd) => {
		fx.stdin.write(`${cmd}\n`);
		await sleep(900);
	};
	const shot = async (name) => {
		await sleep(400);
		await page.screenshot({ path: join(opt.out, `${tag}-${name}.png`) });
		const found = await page.evaluate(async (src) => {
			if (!window.axe) (0, eval)(src);
			const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
			return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
		}, AXE);
		if (found.length) report.axe[`${tag}-${name}`] = found;
	};
	// Real taps, as a finger would: a scripted click() counts as keyboard use and shows focus rings.
	const tap = async (sel, text) => {
		const h = await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].find((x) => x.offsetParent && (!t || x.textContent.includes(t))) || null, { timeout: 10000 }, sel, text);
		const node = h.asElement();
		await node.evaluate((e) => e.scrollIntoView({ block: "center" }));
		await node.tap();
		await sleep(350);
	};
	const closeSheet = () => page.evaluate(() => document.querySelector(".sheet-backdrop")?.click()).then(() => sleep(300));
	const step = async (name, fn) => {
		try {
			await Promise.race([fn(), sleep(25000).then(() => Promise.reject(new Error("timeout")))]);
		} catch (e) {
			report.errors.push(`${tag} ${flow} ${name}: ${e.message}`);
		}
	};
	const ready = async () => {
		await page.goto(link);
		await page.waitForFunction(() => !document.querySelector("#composer").hidden, { timeout: 15000 });
		await sleep(800);
		await page.evaluate(() => {
			window.PiVoiceDebug = [];
			document.querySelector("#onboardNo")?.click();
		});
	};
	const openApi = async () => {
		await tap("#sessionBtn");
		await tap(".sheet-panel .row", "api");
		await sleep(500);
	};

	try {
		if (flow === "app") {
			await page.goto(link.split("#")[0]);
			await sleep(600);
			await shot("01-unpaired");
			await page.goto("about:blank");
			await ready();
			await shot("02-opens-on-waiting-session");
			await step("sessions", async () => {
				await tap("#sessionBtn");
				await shot("03-sessions");
				await tap(".sheet-panel .row", "api");
				await sleep(500);
				await shot("04-transcript");
			});
			await page.evaluate(() => {
				for (const d of document.querySelectorAll("#transcript details.tool")) d.open = true;
				document.querySelector("#scroller").scrollTop = 0;
			});
			await shot("05-tools-open-top");
			await page.evaluate(() => (document.querySelector("#scroller").scrollTop = 99999));
			await shot("06-tools-open-bottom");
			await say("work");
			await shot("07-working");
			await say("ask");
			await shot("08-confirm");
			await step("answer", () => tap(".prompt .pact button", "Yes"));
			await say("pick");
			await shot("09-select");
			await step("pick", () => tap(".prompt .pact button"));
			await say("done");
			await step("menu", async () => {
				await tap("#menuBtn");
				await shot("10-menu");
				await closeSheet();
			});
			await step("models", async () => {
				await tap("#modelBtn");
				await sleep(300);
				await shot("11-models");
				await closeSheet();
			});
			await step("new-session", async () => {
				await tap("#sessionBtn");
				await tap(".sheet-panel .btn", "New session");
				await shot("12-new-session");
				await closeSheet();
			});
			await step("slash", async () => {
				await page.type("#input", "/");
				await sleep(400);
				await shot("13-slash");
				await page.evaluate(() => {
					const i = document.querySelector("#input");
					i.value = "";
					i.dispatchEvent(new Event("input"));
					i.blur();
				});
			});
			// Keyboard: the focus ring is visible, and whole inside a sheet's grouped rows.
			await step("keyboard", async () => {
				await page.keyboard.press("Tab");
				await page.keyboard.press("Tab");
				await shot("14-focus");
				await page.focus("#menuBtn");
				await page.keyboard.press("Enter");
				await sleep(400);
				await page.keyboard.press("Tab");
				report.checks[`${tag} focus ring in a sheet`] = await page.evaluate(() => {
					const a = document.activeElement;
					const s = getComputedStyle(a);
					return { focusVisible: a.matches(":focus-visible"), outline: `${s.outlineStyle} ${s.outlineWidth} offset ${s.outlineOffset}` };
				});
				await shot("15-focus-in-sheet");
				await page.keyboard.press("Escape");
			});
		}

		if (flow === "voice") {
			await ready();
			await openApi();
			await step("dictation", async () => {
				await tap("#micBtn");
				await sleep(2000);
				await shot("d1-recording");
				await tap("#dictBar .rec-done");
				await shot("d2-distilling");
				await sleep(1600);
				await shot("d3-review");
			});
			await say("done");
			await step("voice", async () => {
				await tap("#voiceBtn");
				await sleep(2500);
				const pv = (s, o = {}) => page.evaluate((s, o) => window.PiVoice.preview(s, o), s, o);
				const heard = "Can you also round the totals to cents?";
				await pv("listening");
				await shot("v01-listening");
				await pv("hearing", { heard: heard.slice(0, -1) });
				await shot("v02-hearing");
				await pv("thinking", { heard });
				await shot("v03-thinking");
				await pv("working", { heard });
				await shot("v04-working");
				await pv("speaking", { heard, said: "Done. Totals are rounded to cents now, and the report tests pass." });
				await shot("v05-speaking");
				await say("ask");
				await pv("asking", { said: "pi wants to change the report file. Say yes, or no." });
				await shot("v06-asking");
				await tap("#vMute");
				await shot("v07-muted");
				await tap("#vMute");
				await pv("listening");
				await tap("#vSettings");
				await shot("v08-settings");
				await tap(".sheet-panel .seg button", "Push to talk");
				await shot("v09-settings-push-to-talk");
				await tap(".sheet-close");
				await shot("v10-push-to-talk");
				// Hold the circle: listening while held, ends on release; a short tap toggles.
				const box = await (await page.$("#vOrb")).boundingBox();
				const state = () => page.evaluate(() => ({ state: document.querySelector("#voice").dataset.state, hint: document.querySelector("#vHint").textContent }));
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.down();
				await sleep(900);
				const held = await state();
				await shot("v11-holding");
				await page.mouse.up();
				await sleep(400);
				report.checks[`${tag} push to talk`] = { held, released: await state() };
			});
		}

		if (flow === "picker") {
			await ready();
			await openApi();
			await step("menu picker", async () => {
				await tap("#menuBtn");
				await tap(".sheet-panel .row", "voice mode");
				await sleep(500);
				await shot("p1-picker");
				await tap(".sheet-panel .row", "Cedar");
				await shot("p2-picked");
				report.checks[`${tag} persona stored`] = await page.evaluate(() => localStorage.getItem("pi-mobile-voice-persona"));
				await page.keyboard.press("Escape");
			});
			await step("voice-mode picker", async () => {
				await tap("#voiceBtn");
				await sleep(2500);
				await page.evaluate(() => window.PiVoice.preview("listening", {}));
				await tap("#vSettings");
				await tap(".sheet-panel .row", "Cedar");
				await sleep(500);
				await shot("p3-voice-mode-picker");
			});
		}
	} catch (e) {
		report.errors.push(`${tag} ${flow}: ${e.message}`);
	} finally {
		await browser.close();
		fx.kill();
		await new Promise((r) => fx.once("exit", r));
	}
}

for (const theme of opt.theme.split(","))
	for (const width of opt.width.split(",").map(Number))
		for (const flow of opt.only.split(",")) {
			process.stdout.write(`${theme} ${width} ${flow}… `);
			await session(theme, width, flow);
			console.log("done");
		}

writeFileSync(join(opt.out, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
process.exit(report.errors.length || Object.keys(report.axe).length ? 1 : 0);
