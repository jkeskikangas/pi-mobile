// Lock-screen notifications. Payloads arrive encrypted to this browser (RFC 8291).
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {}
	// One notification per session: a newer one replaces the older.
	event.waitUntil(
		self.registration.showNotification(data.title || "pi", {
			body: data.body || "",
			tag: `pi-${data.agent || "hub"}`,
			renotify: true,
			icon: "icon.svg",
			data: { agent: data.agent },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const agent = event.notification.data?.agent;
	const url = new URL(agent ? `./?agent=${encodeURIComponent(agent)}` : "./", self.registration.scope).href;
	event.waitUntil(
		(async () => {
			const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const w of wins) {
				if (agent) w.postMessage({ type: "open", agent });
				return w.focus();
			}
			return self.clients.openWindow(url);
		})(),
	);
});
