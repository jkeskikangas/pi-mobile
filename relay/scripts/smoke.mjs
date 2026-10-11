#!/usr/bin/env node
// Deploy-time smoke check: proves the deployed relay reaches APNs (HTTP/2, JWT, topic) end to end
// without a real phone. It registers a known-bogus all-zero device token and sends to it.
// Apple answers 400 BadDeviceToken only after accepting the connection and provider token,
// which the relay maps to 410 {gone:true}. Anything else points at the problem.
//
//   node scripts/smoke.mjs https://pi-push-relay.<you>.workers.dev [--sandbox]

const base = process.argv[2]?.replace(/\/$/, "");
if (!base) {
	console.error("usage: node scripts/smoke.mjs <relay-url> [--sandbox]");
	process.exit(2);
}
const sandbox = process.argv.includes("--sandbox");
const post = async (path, body) => {
	const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: await r.json().catch(() => ({})) };
};

const health = await fetch(base + "/");
console.log(`GET /            ${health.status}`);
const reg = await post("/v1/register", { platform: "apns", token: "0".repeat(64), sandbox });
console.log(`POST /v1/register ${reg.status}`);
if (reg.status !== 200) {
	console.error("register failed:", reg.body);
	process.exit(1);
}
const send = await post("/v1/send", { cap: reg.body.cap, sealed: "smoke" });
console.log(`POST /v1/send     ${send.status}`, JSON.stringify(send.body));
if (send.status === 410 && send.body.gone) {
	console.log("OK: Apple accepted the connection and provider token and rejected the bogus device token, as expected.");
	process.exit(0);
}
if (send.status === 502 && send.body.reason === "network") console.error("FAIL: could not reach APNs (HTTP/2 negotiation or network).");
else if (send.status === 502) console.error(`FAIL: APNs rejected the request: ${send.body.reason} (check APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID / APNS_TOPIC).`);
else console.error("FAIL: unexpected response.");
process.exit(1);
