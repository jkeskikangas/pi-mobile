import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivate, privateAddresses } from "../src/expose.ts";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal }) as any;

test("a cloud box's public address is never listened on; tailnet comes first", () => {
	const hetzner = {
		lo: [v4("127.0.0.1", true)],
		eth0: [v4("203.0.113.10"), { address: "2a01:4f8::1", family: "IPv6", internal: false } as any],
		enp7s0: [v4("10.0.0.2")],
		tailscale0: [v4("100.101.102.103")],
		docker0: [v4("172.17.0.1")],
	};
	assert.deepEqual(privateAddresses(hetzner), [
		{ ip: "100.101.102.103", label: "tailscale" },
		{ ip: "10.0.0.2", label: "lan enp7s0" },
		{ ip: "172.17.0.1", label: "lan docker0" },
	]);
});

test("private ranges", () => {
	for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.42", "100.64.0.1", "100.127.255.255"]) assert.equal(isPrivate(ip), true, ip);
	for (const ip of ["203.0.113.10", "172.32.0.1", "100.63.0.1", "100.128.0.1", "8.8.8.8", "169.254.1.1"]) assert.equal(isPrivate(ip), false, ip);
});
