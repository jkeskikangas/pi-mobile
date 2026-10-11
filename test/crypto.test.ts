import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { open, randomKey, ReplayGuard, seal, sealWithNonce, unb64u } from "../src/crypto.ts";
import { render, VECTORS_PATH, vectors } from "./vectors.ts";

test("sealWithNonce round-trips and the committed native vectors match regeneration", () => {
	const v = vectors();
	const key = unb64u(v.key);
	for (const c of v.valid) {
		assert.deepEqual(open(key, c.sealed)?.value, c.value);
		assert.equal(open(key, c.sealed)?.nonce, v.nonce);
	}
	for (const c of v.invalid) assert.equal(open(unb64u(c.key), c.sealed), undefined, c.name);
	assert.equal(sealWithNonce(key, unb64u(v.nonce), 1), sealWithNonce(key, unb64u(v.nonce), 1));
	assert.equal(readFileSync(VECTORS_PATH, "utf8"), render(), "run npm run vectors");
});

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
