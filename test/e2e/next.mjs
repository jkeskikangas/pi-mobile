// Next-message chips end to end: a real pi with pi-mobile and a stand-in next-turn engine
// (test/e2e/next-turn-ext.ts), the phone app in headless Chrome. Checks that chips appear, that a tap
// sends the text through pi (the engine logs it), that a new suggestion replaces the old one, and that
// typing in the terminal first clears them on the phone. No model is called.
//
//   mkdir -p /tmp/piagent-next/pi-mobile && echo '{"port":7998,"enabled":true}' > /tmp/piagent-next/pi-mobile/config.json
//   tmux new -d -s pinext -c /tmp "PI_MOBILE_TAILSCALE=off PI_CODING_AGENT_DIR=/tmp/piagent-next NEXT_LOG=/tmp/pi-next.log \
//     pi -e $PWD/src/index.ts -e $PWD/test/e2e/next-turn-ext.ts"
//   URL=$(PI_CODING_AGENT_DIR=/tmp/piagent-next node --experimental-strip-types test/e2e/pair.ts)
//   node test/e2e/next.mjs "$URL" pinext /tmp/pi-next.log
//
// CHROME=/path/to/chrome when it isn't in the usual place.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const [url, tmux, logFile] = process.argv.slice(2);
if (!url || !tmux || !logFile) throw new Error("usage: next.mjs <pair-url> <tmux-target> <engine-log>");
const CHROME =
	process.env.CHROME ||
	["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	await page.goto(url);
	await page.waitForFunction(() => !document.querySelector("#composer").hidden, { timeout: 20000 });
	const chips = () => page.evaluate(() => (document.querySelector("#nextChips").hidden ? [] : [...document.querySelectorAll("#nextChips .next-text")].map((x) => x.textContent)));
	/** Waits until the first chip reads `first`, or (null) until there are none. No eval: the app's CSP forbids it. */
	const waitChips = (first, ms = 10000) =>
		page
			.waitForFunction(
				(want) => {
					const box = document.querySelector("#nextChips");
					const top = box.hidden ? null : (box.querySelector(".next-text")?.textContent ?? null);
					return top === want;
				},
				{ timeout: ms },
				first,
			)
			.then(() => true)
			.catch(() => false);

	check("chips appear", await waitChips("e2e: run the checks"), JSON.stringify(await chips()));

	const h = await page.$("#nextChips .next-chip");
	await h.tap();
	const sentOk = await (async () => {
		for (let i = 0; i < 50; i++) {
			if (/sent "e2e: run the checks" from extension/.test(log())) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	})();
	check("a tap sends the text through pi's send path", sentOk);
	check("the chips go once it is sent", await waitChips(null, 3000));
	check("a new suggestion replaces it", await waitChips("e2e: open a PR"), JSON.stringify(await chips()));

	// The computer's user types first: the engine clears, the phone follows.
	execFileSync("tmux", ["send-keys", "-t", tmux, "x"]);
	check("typing in the terminal clears them on the phone", await waitChips(null, 5000), JSON.stringify(await chips()));
	execFileSync("tmux", ["send-keys", "-t", tmux, "BSpace"]);
	await page.screenshot({ path: "/tmp/pi-mobile-e2e-next.png" });
} finally {
	await browser.close();
}
console.log(log());
process.exit(results.every((r) => r.ok) ? 0 : 1);
