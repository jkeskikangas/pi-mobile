// Issue #2: the phone app a hub serves matches that hub's code until it restarts.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hub, snapshotWeb } from "../src/hub.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { freePort } from "./phone.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-snap-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function hubServing(web: ReturnType<typeof snapshotWeb>) {
	const port = await freePort();
	const hub = new Hub({ config: { port, enabled: false }, secret: "s".repeat(43), devices: new DeviceStore(dir), push: new PushStore(dir), web });
	await hub.listen();
	const get = async (p: string) => {
		const r = await fetch(`http://127.0.0.1:${port}${p}`);
		return { status: r.status, text: await r.text() };
	};
	return { hub, get };
}

test("files changed on disk while a hub runs don't change what it serves; a restarted hub serves the new ones", async () => {
	const web = join(dir, "web");
	mkdirSync(join(web, "sub"), { recursive: true });
	const nacl = join(dir, "nacl.js");
	writeFileSync(join(web, "index.html"), "v1 index");
	writeFileSync(join(web, "app.js"), "v1 app");
	writeFileSync(join(web, "sub", "x.css"), "v1 css");
	writeFileSync(nacl, "v1 nacl");
	const first = await hubServing(snapshotWeb(web, { "/nacl.js": nacl }));
	try {
		// `pi update` replaces the package's files under the running hub.
		writeFileSync(join(web, "index.html"), "v2 index");
		writeFileSync(join(web, "app.js"), "v2 app");
		writeFileSync(join(web, "sub", "x.css"), "v2 css");
		writeFileSync(join(web, "new.js"), "v2 only");
		writeFileSync(nacl, "v2 nacl");
		assert.equal((await first.get("/")).text, "v1 index");
		assert.equal((await first.get("/index.html")).text, "v1 index");
		assert.equal((await first.get("/app.js")).text, "v1 app");
		assert.equal((await first.get("/sub/x.css")).text, "v1 css");
		assert.equal((await first.get("/nacl.js")).text, "v1 nacl");
		assert.equal((await first.get("/new.js")).status, 404);
		assert.equal((await first.get("/../package.json")).status, 404);
	} finally {
		first.hub.close();
	}
	const restarted = await hubServing(snapshotWeb(web, { "/nacl.js": nacl }));
	try {
		assert.equal((await restarted.get("/app.js")).text, "v2 app");
		assert.equal((await restarted.get("/new.js")).text, "v2 only");
		assert.equal((await restarted.get("/nacl.js")).text, "v2 nacl");
	} finally {
		restarted.hub.close();
	}
});

test("by default a hub serves the package's own web app, snapshotted when the hub code loaded", async () => {
	const { hub, get } = await hubServing(undefined as never);
	try {
		const index = await get("/");
		assert.equal(index.status, 200);
		assert.match(index.text, /<html/i);
		assert.equal((await get("/nacl.js")).status, 200);
		assert.equal((await get("/app.js")).status, 200);
	} finally {
		hub.close();
	}
});
