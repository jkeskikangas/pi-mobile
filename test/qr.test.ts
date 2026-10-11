// Scanning a pairing QR without BarcodeDetector: the vendored decoder (web/qr.js, jsQR) reads the
// exact QR that `/remote` draws in the terminal, in a light and a dark terminal, and the link it
// yields is recognised as a pairing link (web/fleet.js `pairingLink`).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { qrMatrix } from "../src/qr.ts";

// A classic browser script (UMD); this package is ESM, so run it as a script with a CommonJS shim.
const mod = { exports: {} as any };
runInNewContext(readFileSync(new URL("../web/qr.js", import.meta.url), "utf8"), { module: mod, exports: mod.exports });
const jsQR = mod.exports;
const fleetScript = "../web/fleet.js"; // a browser script: importing runs it and sets globalThis.PiFleet
await import(fleetScript);
const { pairingLink } = (globalThis as any).PiFleet;

/** The matrix as camera-like RGBA pixels: `scale` px per module inside a `margin` of `surround`. */
function pixels(m: boolean[][], scale: number, margin: number, surround: number) {
	const size = m.length * scale + margin * 2;
	const data = new Uint8ClampedArray(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const r = Math.floor((y - margin) / scale);
			const c = Math.floor((x - margin) / scale);
			const inside = y >= margin && x >= margin && r < m.length && c < m.length;
			const v = inside ? (m[r][c] ? 0 : 255) : surround;
			data.set([v, v, v, 255], (y * size + x) * 4);
		}
	return { data, size };
}

const LINK = "https://laptop.tail1234.ts.net/#p=Zx9k2mQ4r7.q3V-8lA_0bC1dE2fG3hI4jK5lM6nO7pQ8rS9tU0vW1xY2zA";

for (const [name, surround] of [
	["light terminal", 255],
	["dark terminal", 30],
] as const)
	test(`the vendored decoder reads the /remote QR in a ${name}`, () => {
		const { data, size } = pixels(qrMatrix(LINK), 6, 24, surround);
		const found = jsQR(data, size, size, { inversionAttempts: "dontInvert" });
		assert.equal(found?.data, LINK);
		const p = pairingLink(found.data);
		assert.equal(p.url.origin, "https://laptop.tail1234.ts.net");
		assert.equal(p.id, "Zx9k2mQ4r7");
	});

test("an image with no code decodes to nothing", () => {
	const size = 120;
	const data = new Uint8ClampedArray(size * size * 4).fill(200);
	assert.equal(jsQR(data, size, size), null);
});

test("pairingLink accepts only links with a pairing code", () => {
	assert.ok(pairingLink(" https://box.ts.net/#p=a.b "));
	assert.equal(pairingLink("https://example.com/"), null);
	assert.equal(pairingLink("WIFI:S:home;T:WPA;P:secret;;"), null);
	assert.equal(pairingLink(""), null);
});
