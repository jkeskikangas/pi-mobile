// Lock-screen notifications, and a copy of the app so it opens while the computer that serves it
// sleeps (your other computers still answer). Payloads arrive encrypted to this browser (RFC 8291).
"use strict";

const SHELL = "pi-shell-v2";
const FILES = ["./", "app.css", "app.js", "fleet.js", "voice-core.js", "voice.js", "nacl.js", "icon.svg", "manifest.json"];

self.addEventListener("install", (e) => {
	e.waitUntil(
		caches
			.open(SHELL)
			.then((c) => c.addAll(FILES))
			.catch(() => {})
			.then(() => self.skipWaiting()),
	);
});
self.addEventListener("activate", (e) =>
	e.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith("pi-shell-") && k !== SHELL).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	),
);

// The app's own files: the network when it answers quickly, else the copy (refreshed whenever the
// network does answer). The API always goes to the network; it is sealed and never cached.
self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
	event.respondWith(
		(async () => {
			const cache = await caches.open(SHELL);
			const key = req.mode === "navigate" ? "./" : req;
			const cached = await cache.match(key, { ignoreSearch: req.mode === "navigate" });
			const network = fetch(req)
				.then((res) => {
					if (res.ok) cache.put(key, res.clone()).catch(() => {});
					return res;
				})
				.catch(() => undefined);
			if (!cached) return (await network) || Response.error();
			// A sleeping computer over Tailscale can take long to fail; don't wait for it.
			const quick = await Promise.race([network, new Promise((r) => setTimeout(r, 2500))]);
			return quick || cached;
		})(),
	);
});

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {}
	const offer = data.kind === "add" ? data.offer : undefined;
	// One notification per session (per computer): a newer one replaces the older.
	event.waitUntil(
		self.registration.showNotification(data.title || "pi", {
			body: data.body || "",
			tag: `pi-${data.machine || "hub"}-${data.agent || (data.offer ? `offer-${data.offer}` : "hub")}`,
			renotify: true,
			icon: "icon.svg",
			// Android shows the button; iPhone shows none and a tap opens the app's Add sheet.
			actions: offer ? [{ action: "add", title: "Add" }] : [],
			data: { agent: data.agent, offer },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const { agent, offer } = event.notification.data || {};
	// "Add" can't add here: the machine list lives in the page's storage. The page adds it, no second tap.
	const accept = event.action === "add" && offer ? offer : undefined;
	const query = accept ? `?accept=${encodeURIComponent(accept)}` : agent ? `?agent=${encodeURIComponent(agent)}` : "";
	const url = new URL(`./${query}`, self.registration.scope).href;
	event.waitUntil(
		(async () => {
			const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const w of wins) {
				if (accept) w.postMessage({ type: "accept", offer: accept });
				else if (agent) w.postMessage({ type: "open", agent });
				return w.focus();
			}
			return self.clients.openWindow(url);
		})(),
	);
});
