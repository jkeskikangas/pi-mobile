import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// The npm package is the extension only: never the iPhone app or a signing key that sits in the repo.
test("npm pack excludes native/ and key files", () => {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
	const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
	assert.ok(files.includes("src/index.ts"), "sanity: the extension is packed");
	assert.deepEqual(files.filter((f) => f.startsWith("native/") || /\.(p8|pem)$/i.test(f)), []);
});
