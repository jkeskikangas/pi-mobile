import assert from "node:assert/strict";
import { test } from "node:test";
import { open, randomKey, ReplayGuard, seal } from "../src/crypto.ts";

test("seal/open round-trips and rejects the wrong key or tampering", () => {
	const key = randomKey();
	const sealed = seal(key, { hello: "wörld", n: 1 });
	assert.deepEqual(open(key, sealed)?.value, { hello: "wörld", n: 1 });
	assert.equal(open(randomKey(), sealed), undefined);
	const raw = Buffer.from(sealed, "base64url");
	raw[raw.length - 1] ^= 1;
	assert.equal(open(key, raw.toString("base64url")), undefined);
	assert.equal(open(key, "not-base64!!"), undefined);
});

test("each seal uses a fresh nonce", () => {
	const key = randomKey();
	assert.notEqual(seal(key, 1), seal(key, 1));
});

test("replay guard rejects reused nonces and stale timestamps", () => {
	const g = new ReplayGuard(1000);
	const now = 10_000;
	assert.equal(g.accept("a", now, now), true);
	assert.equal(g.accept("a", now, now), false, "replayed nonce");
	assert.equal(g.accept("b", now - 2000, now), false, "too old");
	assert.equal(g.accept("c", now + 2000, now), false, "from the future");
	assert.equal(g.accept("d", "x", now), false, "no timestamp");
});
