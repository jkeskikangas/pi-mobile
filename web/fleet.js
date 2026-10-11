// The phone's machines: one sealed connection per machine (RPC + event stream), merged into one
// session list. No machine relays for another, so a sleeping laptop or a deleted box only takes its
// own sessions with it (designs/multi-machine.md). No DOM here: the page and `node --test` load it.
"use strict";

(() => {
	const MACHINES_KEY = "pi-mobile-machines";
	const DEVICE_KEY = "pi-mobile-device"; // the single pairing before several machines; kept for the primary
	const STALL_MS = 40_000; // the hub pings every 15 s; mobile browsers freeze sockets silently

	class Unauthorized extends Error {}

	/**
	 * deps: { seal(key, value), open(key, sealed), unb64u, fetch, storage: { get, set }, origin,
	 *         onHello(id, ev), onEvent(id, ev), onState(id), onRevoked(id, reason) }
	 * Machine entries: { id, machine, name, origin, d, k, primary?, added, lastSeen }. `id` is this phone's
	 * own handle and never changes; `machine` is the computer's id (from its hub). The primary machine
	 * serves this app and is always reached at the page's own origin.
	 */
	function createFleet(deps) {
		const conns = new Map(); // id -> runtime state
		const agentMachine = new Map(); // agent -> machine id
		const actionKeys = new Map(); // agent+method+params -> { k, at }: idempotency keys of actions with an unknown outcome
		let machines = load();
		let running = false;

		function load() {
			const list = deps.storage.get(MACHINES_KEY);
			if (Array.isArray(list)) return list;
			// One pairing from before several machines: it becomes the primary machine.
			const old = deps.storage.get(DEVICE_KEY);
			if (!old?.d) return [];
			const migrated = [{ id: localId(), machine: "", name: old.host || "", primary: true, d: old.d, k: old.k, added: 0, lastSeen: 0 }];
			deps.storage.set(MACHINES_KEY, migrated);
			return migrated;
		}
		function save() {
			deps.storage.set(MACHINES_KEY, machines);
			const p = machines.find((m) => m.primary);
			deps.storage.set(DEVICE_KEY, p ? { d: p.d, k: p.k, role: "control", host: p.name } : null);
		}
		const byId = (id) => machines.find((m) => m.id === id);
		const originOf = (m) => (m.primary ? deps.origin : m.origin);
		function conn(id) {
			let c = conns.get(id);
			if (!c) {
				c = { state: "connecting", hubId: null, seq: 0, clientId: null, focus: "", abort: null, backoff: 500, lastData: 0, stopped: false, error: "" };
				conns.set(id, c);
			}
			return c;
		}
		function setState(id, state, error = "") {
			const c = conn(id);
			if (c.state === state && c.error === error) return;
			c.state = state;
			c.error = error;
			if (state === "online") {
				const m = byId(id);
				if (m) {
					m.lastSeen = Date.now();
					save();
				}
			}
			deps.onState?.(id);
		}

		async function rpc(id, m, p) {
			const mc = byId(id);
			if (!mc) throw new Error("that computer is no longer in your list");
			const key = deps.unb64u(mc.k);
			const res = await deps.fetch(`${originOf(mc)}/api/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ d: mc.d, b: deps.seal(key, { t: Date.now(), m, p }) }),
			});
			if (res.status === 401) {
				revoked(id, "This phone was removed from that computer");
				throw new Unauthorized("this device is no longer paired");
			}
			const body = await res.json();
			if (!body.b) throw new Error(body.error || `HTTP ${res.status}`);
			const out = deps.open(key, body.b);
			if (out.e !== undefined) throw Object.assign(new Error(out.e), { answered: true });
			return out.r;
		}

		/** One call to a computer that isn't in the list (yet): declining an offer revokes its key there. */
		async function rpcTo(entry, m, p) {
			const key = deps.unb64u(entry.k);
			const res = await deps.fetch(`${entry.origin}/api/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ d: entry.d, b: deps.seal(key, { t: Date.now(), m, p }) }),
			});
			const body = await res.json();
			if (!body.b) throw new Error(body.error || `HTTP ${res.status}`);
			const out = deps.open(key, body.b);
			if (out.e !== undefined) throw new Error(out.e);
			return out.r;
		}

		function machineOf(agent) {
			return agentMachine.get(agent);
		}
		async function call(agent, m, p) {
			const id = agentMachine.get(agent);
			if (!id) throw new Error("that pi session is no longer connected");
			if (conn(id).state === "offline") throw new Error(`${byId(id)?.name || "That computer"} is offline`);
			if (!ACTIONS.has(m)) return rpc(id, "agent", { agent, m, p: p || {} });
			// An action whose reply was lost may have reached pi: repeating it with the same params reuses its key,
			// so pi performs it once and answers with the first result. Changed params (an edited composer) are a new action.
			const now = Date.now();
			for (const [s, v] of actionKeys) if (now - v.at > ACTION_KEY_MS) actionKeys.delete(s);
			const sig = `${agent}\n${m}\n${JSON.stringify(p || {})}`;
			const k = actionKeys.get(sig)?.k ?? actionKey();
			actionKeys.set(sig, { k, at: actionKeys.get(sig)?.at ?? now });
			try {
				const r = await rpc(id, "agent", { agent, m, p: p || {}, k });
				actionKeys.delete(sig);
				return r;
			} catch (e) {
				// The computer answered (an error from pi or the hub): the outcome is known, the next attempt is new.
				if (e instanceof Unauthorized || e?.answered) actionKeys.delete(sig);
				throw e;
			}
		}
		/** The sessions a machine reported (after a resync): they now route there, others of it are gone. */
		function adopt(id, agents) {
			for (const [a, mid] of agentMachine) if (mid === id && !agents.includes(a)) agentMachine.delete(a);
			for (const a of agents) agentMachine.set(a, id);
		}
		function agentsOf(id) {
			return [...agentMachine].filter(([, mid]) => mid === id).map(([a]) => a);
		}

		/** Detailed events (token stream, tool output) flow only for the session on screen. */
		async function focus(agent) {
			const target = agentMachine.get(agent);
			await Promise.all(
				machines.map(async (m) => {
					const c = conn(m.id);
					const want = m.id === target ? agent : "";
					if (!c.clientId || c.focus === want) return;
					c.focus = want;
					await rpc(m.id, "focus", { client: c.clientId, agent: want }).catch(() => {});
				}),
			);
		}

		async function loop(id) {
			const c = conn(id);
			while (running && !c.stopped && byId(id)) {
				const mc = byId(id);
				const key = deps.unb64u(mc.k);
				const ctrl = new AbortController();
				c.abort = ctrl;
				try {
					const b = deps.seal(key, { t: Date.now(), hub: c.hubId, since: c.seq, focus: c.focus || undefined });
					const res = await deps.fetch(`${originOf(mc)}/api/stream?d=${encodeURIComponent(mc.d)}&b=${b}`, { signal: ctrl.signal, cache: "no-store" });
					if (res.status === 401) return revoked(id, "This phone was removed from that computer");
					if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
					const reader = res.body.getReader();
					const dec = new TextDecoder();
					let buf = "";
					c.lastData = Date.now();
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						c.lastData = Date.now();
						buf += dec.decode(value, { stream: true });
						let i = buf.indexOf("\n\n");
						while (i >= 0) {
							const frame = buf.slice(0, i);
							buf = buf.slice(i + 2);
							const data = frame
								.split("\n")
								.filter((l) => l.startsWith("data: "))
								.map((l) => l.slice(6))
								.join("");
							if (data) await batch(id, deps.open(key, data));
							i = buf.indexOf("\n\n");
						}
					}
				} catch (e) {
					if (e instanceof Unauthorized) return;
				}
				if (!running || c.stopped) return;
				c.clientId = null;
				setState(id, "offline");
				await new Promise((r) => setTimeout(r, c.backoff));
				c.backoff = Math.min(c.backoff * 2, 5000);
			}
		}

		async function batch(id, events) {
			const c = conn(id);
			for (const ev of events) {
				if (ev.type === "hello") {
					c.backoff = 500;
					c.hubId = ev.hubId;
					c.seq = ev.seq;
					c.clientId = ev.client;
					c.focus = "";
					setState(id, "online");
					await deps.onHello?.(id, ev);
					continue;
				}
				if (ev.seq) c.seq = Math.max(c.seq, ev.seq);
				if (ev.agent) {
					if (ev.type === "gone") agentMachine.delete(ev.agent);
					else if (ev.type === "info") agentMachine.set(ev.agent, id);
				}
				deps.onEvent?.(id, ev);
			}
		}

		function revoked(id, reason) {
			const c = conn(id);
			c.stopped = true;
			c.abort?.abort();
			setState(id, "revoked", reason);
			deps.onRevoked?.(id, reason);
		}

		function start() {
			running = true;
			for (const m of machines) startOne(m.id);
		}
		function startOne(id) {
			const c = conn(id);
			if (c.running) return;
			c.running = true;
			c.stopped = false;
			loop(id).finally(() => (c.running = false));
		}
		function stop() {
			running = false;
			for (const c of conns.values()) c.abort?.abort();
		}

		/** Adds a computer, replacing an entry for the same computer, then connects to it. */
		function add(entry) {
			const old = entry.machine ? machines.find((x) => x.machine === entry.machine) : undefined;
			if (old) remove(old.id);
			const m = {
				id: localId(),
				machine: entry.machine || "",
				name: entry.name || "",
				origin: String(entry.origin || "").replace(/\/+$/, ""),
				d: entry.d,
				k: entry.k,
				primary: !!(entry.primary || old?.primary),
				added: Date.now(),
				lastSeen: 0,
			};
			machines = [...machines, m];
			save();
			if (running) startOne(m.id);
			return m;
		}
		const byMachine = (machine) => machines.find((m) => m.machine === machine);
		/** Forgets a machine: its connection closes and its sessions leave the list. */
		function remove(id) {
			const c = conns.get(id);
			if (c) {
				c.stopped = true;
				c.abort?.abort();
				conns.delete(id);
			}
			const gone = agentsOf(id);
			for (const a of gone) agentMachine.delete(a);
			machines = machines.filter((m) => m.id !== id);
			save();
			return gone;
		}
		/** The hub said who it is (name changes; a migrated pairing learns its computer's id). */
		function identify(id, machine) {
			const m = byId(id);
			if (!m || !machine?.id) return;
			if (m.name === machine.name && m.machine === machine.id) return;
			const dup = machines.find((x) => x !== m && x.machine === machine.id);
			if (dup) remove(dup.id); // the same computer twice: keep the connection we have
			m.name = machine.name;
			m.machine = machine.id;
			save();
		}

		// Watchdog for frozen sockets, and a quick reconnect when the app comes back to the foreground.
		function watch(now = Date.now(), foreground = false) {
			for (const c of conns.values()) {
				if (!c.abort) continue;
				if (c.state === "online" && now - c.lastData > STALL_MS) c.abort.abort();
				else if (foreground && now - c.lastData > 20_000) {
					c.backoff = 200;
					c.abort.abort();
				}
			}
		}

		return {
			Unauthorized,
			get machines() {
				return machines.map((m) => ({ ...m, ...pick(conn(m.id)) }));
			},
			primary: () => machines.find((m) => m.primary),
			get: byId,
			byMachine,
			state: (id) => conn(id).state,
			anyOnline: () => machines.some((m) => conn(m.id).state === "online"),
			rpc,
			rpcTo,
			call,
			machineOf,
			adopt,
			agentsOf,
			focus,
			add,
			remove,
			identify,
			start,
			stop,
			watch,
		};
	}
	const pick = (c) => ({ state: c.state, error: c.error });
	/** Phone actions that change a session: each carries an idempotency key (issue #1). */
	const ACTIONS = new Set(["send", "answer", "abort", "setModel", "setThinking", "compact", "spawn"]);
	/** Pi remembers a key for 15 minutes; the phone reuses one for 10. */
	const ACTION_KEY_MS = 10 * 60_000;
	function actionKey() {
		const b = new Uint8Array(12);
		globalThis.crypto.getRandomValues(b);
		return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
	}
	function localId() {
		const b = new Uint8Array(6);
		globalThis.crypto.getRandomValues(b);
		return `m${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
	}

	/** The pairing code in a link from `/remote` or `/remote pair` (`https://host/#p=<id>.<key>`), or null. */
	function pairingLink(text) {
		let url;
		try {
			url = new URL(String(text).trim());
		} catch {
			return null;
		}
		const m = /[#&]p=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(url.hash);
		return m ? { url, id: m[1], key: m[2] } : null;
	}

	const api = { createFleet, Unauthorized, pairingLink };
	globalThis.PiFleet = api;
})();
