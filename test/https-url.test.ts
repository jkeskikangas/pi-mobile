import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { httpsUrl } from "../bin/https-url.mjs";
import { loadConfig } from "../src/store.ts";

test("https addresses: parsed and normalized, paths allowed, anything odd refused", () => {
	assert.equal(httpsUrl("https://box.tail1.ts.net"), "https://box.tail1.ts.net");
	assert.equal(httpsUrl(" https://Box.example.com:8443/pi/ "), "https://box.example.com:8443/pi");
	assert.equal(httpsUrl("https://example.com:443/"), "https://example.com");
	for (const bad of ["http://box", "https://", "https://user:pw@box", "https://user@box", "https://box/?q=1", "https://box/?", "https://box/#x", "https://box#", "https://bo x", "ftp://box", "https:box", "", undefined, 42])
		assert.equal(httpsUrl(bad), undefined, String(bad));
});

test("config: publicUrl goes through the same rule", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-https-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ publicUrl: "https://pi.example.com/hub/" }));
	assert.equal(loadConfig(dir).publicUrl, "https://pi.example.com/hub");
	writeFileSync(join(dir, "config.json"), JSON.stringify({ publicUrl: "https://me@pi.example.com" }));
	assert.equal(loadConfig(dir).publicUrl, undefined);
});
