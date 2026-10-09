// pi mobile — phone client. Every API payload is sealed with NaCl secretbox under a per-device key
// that arrived in the pairing QR's URL fragment (never sent to any server in clear).
"use strict";

(() => {
	const nacl = window.nacl;
	const $ = (id) => document.getElementById(id);
	const DEVICE_KEY = "pi-mobile-device";
	const AGENT_KEY = "pi-mobile-agent";
	const MODE_KEY = "pi-mobile-mode";

	// ── storage ────────────────────────────────────────────────────────────────────
	const store = {
		get(k) {
			try {
				return JSON.parse(localStorage.getItem(k) || "null");
			} catch {
				return null;
			}
		},
		set(k, v) {
			try {
				if (v === null || v === undefined) localStorage.removeItem(k);
				else localStorage.setItem(k, JSON.stringify(v));
			} catch {}
		},
	};

	// ── crypto ─────────────────────────────────────────────────────────────────────
	function b64u(bytes) {
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}
	function unb64u(text) {
		const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
		const out = new Uint8Array(s.length);
		for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
		return out;
	}
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	function seal(key, value) {
		const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
		const box = nacl.secretbox(enc.encode(JSON.stringify(value)), nonce, key);
		const out = new Uint8Array(nonce.length + box.length);
		out.set(nonce);
		out.set(box, nonce.length);
		return b64u(out);
	}
	function open(key, sealed) {
		const raw = unb64u(sealed);
		const n = nacl.secretbox.nonceLength;
		const plain = nacl.secretbox.open(raw.subarray(n), raw.subarray(0, n), key);
		if (!plain) throw new Error("could not decrypt (wrong key?)");
		return JSON.parse(dec.decode(plain));
	}

	// ── state ──────────────────────────────────────────────────────────────────────
	const S = {
		device: store.get(DEVICE_KEY), // { d, k, role, host }
		key: null,
		hubId: null,
		seq: 0,
		agents: new Map(), // agent -> info
		prompts: new Map(), // agent -> Map(id -> prompt)
		current: null,
		view: null, // transcript state of the current agent
		mode: store.get(MODE_KEY) || "steer",
		commands: null,
		attachments: [],
		online: false,
		models: null,
		push: { key: null, on: false },
	};
	if (S.device) S.key = unb64u(S.device.k);

	class Unauthorized extends Error {}

	async function rpc(m, p) {
		if (!S.device) throw new Unauthorized("not paired");
		const res = await fetch("api/rpc", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ d: S.device.d, b: seal(S.key, { t: Date.now(), m, p }) }),
		});
		if (res.status === 401) throw new Unauthorized("this device is no longer paired");
		const body = await res.json();
		if (!body.b) throw new Error(body.error || `HTTP ${res.status}`);
		const out = open(S.key, body.b);
		if (out.e !== undefined) throw new Error(out.e);
		return out.r;
	}
	const call = (m, p, agent = S.current) => rpc("agent", { agent, m, p: p || {} });

	// ── pairing ────────────────────────────────────────────────────────────────────
	function deviceName() {
		const ua = navigator.userAgent;
		const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
		const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "";
		return browser ? `${kind} · ${browser}` : kind;
	}

	async function pairFromHash() {
		const m = /[#&]p=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(location.hash);
		if (!m) return false;
		history.replaceState(null, "", location.pathname + location.search);
		showEmpty("<h2>Pairing…</h2>");
		const key = unb64u(m[2]);
		try {
			const res = await fetch("api/pair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ p: m[1], b: seal(key, { t: Date.now(), name: deviceName() }) }),
			});
			const body = await res.json();
			if (!res.ok || !body.b) throw new Error(body.error || `HTTP ${res.status}`);
			const out = open(key, body.b);
			S.device = { d: out.d, k: out.k, role: out.role, host: out.host };
			S.key = unb64u(out.k);
			store.set(DEVICE_KEY, S.device);
			toast(`Paired with ${out.host}${out.role === "view" ? " (view-only)" : ""}`);
			return true;
		} catch (e) {
			if (S.device) {
				toast(`Pairing failed: ${e.message}`, "error");
				return true;
			}
			showEmpty(`<h2>Pairing failed</h2><p>${esc(e.message)}</p><p>Run <code>/remote</code> in pi again and scan the new code.</p>`);
			return "failed";
		}
	}

	function unpaired(reason) {
		S.device = null;
		S.key = null;
		store.set(DEVICE_KEY, null);
		S.online = false;
		$("composer").hidden = true;
		$("viewOnly").hidden = true;
		$("modelBtn").hidden = true;
		$("transcript").replaceChildren();
		$("prompts").replaceChildren();
		$("olderBtn").hidden = true;
		setHeader();
		showEmpty(
			`<h2>Not paired</h2><p>${reason ? `${esc(reason)}.<br>` : ""}In pi on your computer, run <code>/remote</code> and scan the QR code with this phone.</p>`,
		);
	}

	function showEmpty(html) {
		const el = $("empty");
		if (html) {
			el.innerHTML = html;
			el.hidden = false;
		} else el.hidden = true;
	}

	// ── stream ─────────────────────────────────────────────────────────────────────
	let streamAbort = null;
	let lastData = 0;
	let backoff = 500;

	async function streamLoop() {
		for (;;) {
			if (!S.device) return;
			const ctrl = new AbortController();
			streamAbort = ctrl;
			try {
				const b = seal(S.key, { t: Date.now(), hub: S.hubId, since: S.seq, focus: S.current || undefined });
				const res = await fetch(`api/stream?d=${encodeURIComponent(S.device.d)}&b=${b}`, { signal: ctrl.signal, cache: "no-store" });
				if (res.status === 401) return unpaired("This device was revoked or the pairing was lost");
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				const reader = res.body.getReader();
				let buf = "";
				lastData = Date.now();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					lastData = Date.now();
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
						if (data) await onBatch(open(S.key, data));
						i = buf.indexOf("\n\n");
					}
				}
			} catch (e) {
				if (e instanceof Unauthorized) return unpaired(e.message);
			}
			setOnline(false);
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 8000);
		}
	}

	// Mobile browsers silently freeze sockets in the background; the hub pings every 15 s.
	setInterval(() => {
		if (streamAbort && S.online && Date.now() - lastData > 40_000) streamAbort.abort();
	}, 5000);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && streamAbort && Date.now() - lastData > 20_000) {
			backoff = 200;
			streamAbort.abort();
		}
	});

	async function onBatch(batch) {
		for (const ev of batch) {
			if (ev.type === "hello") {
				backoff = 500;
				const fresh = ev.resync;
				S.hubId = ev.hubId;
				S.seq = ev.seq;
				S.clientId = ev.client;
				setOnline(true);
				if (fresh) await resync();
				continue;
			}
			if (ev.seq) S.seq = Math.max(S.seq, ev.seq);
			handleEvent(ev);
		}
	}

	function setOnline(on) {
		S.online = on;
		const b = $("banner");
		if (on) b.hidden = true;
		else if (S.device) {
			b.textContent = "Reconnecting…";
			b.className = "banner";
			b.hidden = false;
		}
		updateComposer();
	}

	async function resync() {
		try {
			const hub = await rpc("hub");
			S.agents = new Map(hub.agents.map((a) => [a.agent, a]));
			S.device.role = hub.device.role;
			S.push = { key: hub.pushKey, on: !!hub.pushOn };
			store.set(DEVICE_KEY, S.device);
			if (!S.agents.has(S.current)) S.current = pickAgent();
			maybeOnboard();
			await loadCurrent();
		} catch (e) {
			if (e instanceof Unauthorized) return unpaired(e.message);
			toast(`Sync failed: ${e.message}`, "error");
		}
	}

	function pickAgent() {
		const saved = store.get(AGENT_KEY);
		if (saved && S.agents.has(saved)) return saved;
		return sortedAgents()[0]?.agent || null;
	}

	// ── transcript model ───────────────────────────────────────────────────────────
	function newView(agent) {
		return { agent, loading: true, pending: [], n: 0, start: 0, total: 0, stream: null, tools: new Map() };
	}

	async function loadCurrent() {
		const agent = S.current;
		S.commands = null;
		S.models = null;
		$("transcript").replaceChildren();
		$("liveTools").replaceChildren();
		$("olderBtn").hidden = true;
		setHeader();
		renderPrompts();
		renderAttention();
		if (!agent) {
			showEmpty("<h2>No shared sessions</h2><p>Run <code>/remote</code> in a pi session on your computer.</p>");
			updateComposer();
			return;
		}
		showEmpty("");
		store.set(AGENT_KEY, agent);
		const view = newView(agent);
		S.view = view;
		try {
			// Detailed events (token stream, tool output) flow only for the session on screen.
			if (S.clientId) await rpc("focus", { client: S.clientId, agent });
			const snap = await call("snapshot", { limit: 120 }, agent);
			if (S.view !== view) return;
			view.n = snap.n || 0;
			view.start = snap.start;
			view.total = snap.total;
			S.agents.set(agent, snap.info);
			S.prompts.set(agent, new Map(snap.prompts.map((p) => [p.id, p])));
			const frag = document.createDocumentFragment();
			for (const item of snap.items) frag.appendChild(renderItem(item));
			$("transcript").replaceChildren(frag);
			linkToolResults();
			if (snap.streaming) {
				view.stream = { key: snap.streaming.id, blocks: snap.streaming.blocks.map((b) => ({ t: b.t === "tool" ? "tool" : b.t, text: b.t === "tool" ? b.args : b.text, name: b.name })) };
				renderStream();
			}
			for (const t of snap.tools) toolStart(t.id, t.name, t.title, t.output);
			$("olderBtn").hidden = view.start === 0;
			view.loading = false;
			for (const ev of view.pending) if (ev.n === undefined || ev.n > view.n) applyAgentEvent(ev);
			view.pending = [];
			setHeader();
			renderPrompts();
			updateComposer();
			scrollToBottom(true);
			if (!snap.items.length && !snap.streaming) showEmpty("<p>No messages yet. Say something.</p>");
		} catch (e) {
			if (e instanceof Unauthorized) return unpaired(e.message);
			if (S.view === view) showEmpty(`<p>Could not load the session: ${esc(e.message)}</p>`);
		}
	}

	async function loadOlder() {
		const view = S.view;
		if (!view || view.start === 0) return;
		$("olderBtn").disabled = true;
		try {
			const snap = await call("snapshot", { limit: 120, before: view.start });
			if (S.view !== view) return;
			const sc = $("scroller");
			const fromBottom = sc.scrollHeight - sc.scrollTop;
			const frag = document.createDocumentFragment();
			for (const item of snap.items) frag.appendChild(renderItem(item));
			$("transcript").prepend(frag);
			linkToolResults();
			view.start = snap.start;
			$("olderBtn").hidden = view.start === 0;
			sc.scrollTop = sc.scrollHeight - fromBottom;
		} catch (e) {
			toast(e.message, "error");
		} finally {
			$("olderBtn").disabled = false;
		}
	}

	function handleEvent(ev) {
		const agent = ev.agent;
		window.PiVoice?.onEvent(ev);
		if (ev.type === "info") {
			S.agents.set(agent, ev.info);
			// A session this phone asked herdr to start has arrived: open it.
			if (S.spawning && ev.info.spawn === S.spawning) {
				S.spawning = null;
				openAgent(agent);
			}
			if (!S.current) {
				S.current = agent;
				loadCurrent();
			}
			if (agent === S.current) setHeader();
			updateTitle();
			renderAttention();
			return;
		}
		if (ev.type === "gone") {
			S.agents.delete(agent);
			S.prompts.delete(agent);
			if (agent === S.current) {
				toast("That pi session stopped sharing", "warning");
				S.current = pickAgent();
				loadCurrent();
			}
			updateTitle();
			return;
		}
		if (ev.type === "prompt" || ev.type === "prompt_end") {
			const map = S.prompts.get(agent) || new Map();
			S.prompts.set(agent, map);
			if (ev.type === "prompt") {
				map.set(ev.prompt.id, ev.prompt);
				navigator.vibrate?.(200);
			} else map.delete(ev.id);
			if (agent === S.current) renderPrompts(ev.type === "prompt_end" ? ev : undefined);
			updateTitle();
			renderAttention();
			return;
		}
		if (agent !== S.current || !S.view) {
			if (ev.type === "notice" && ev.level !== "info") toast(`${agentName(agent)}: ${ev.text}`, ev.level);
			return;
		}
		if (S.view.loading) {
			S.view.pending.push(ev);
			return;
		}
		if (ev.n !== undefined && ev.n <= S.view.n) return;
		applyAgentEvent(ev);
	}

	function applyAgentEvent(ev) {
		const view = S.view;
		const stick = nearBottom();
		switch (ev.type) {
			case "reset":
				loadCurrent();
				return;
			case "notice":
				toast(ev.text, ev.level);
				return;
			case "stream_start":
				showEmpty("");
				view.stream = { key: ev.key, blocks: [] };
				renderStream();
				break;
			case "stream": {
				if (!view.stream || view.stream.key !== ev.key) view.stream = { key: ev.key, blocks: [] };
				const b = (view.stream.blocks[ev.i] ||= { t: ev.kind, text: "", name: ev.name });
				b.text += ev.delta;
				if (ev.name) b.name = ev.name;
				scheduleStreamRender();
				break;
			}
			case "item": {
				showEmpty("");
				const el = renderItem(ev.item);
				const old = ev.replaces && document.getElementById(`i-${ev.replaces}`);
				if (old) old.replaceWith(el);
				else if (ev.item.k === "tool" && attachToolResult(ev.item)) {
					/* merged into its call card */
				} else $("transcript").appendChild(el);
				if (ev.replaces && view.stream && view.stream.key === ev.replaces) view.stream = null;
				if (ev.item.k === "assistant") linkToolResults();
				break;
			}
			case "tool_start":
				toolStart(ev.id, ev.name, ev.title, "");
				break;
			case "tool_update":
				toolUpdate(ev.id, ev.output);
				break;
			case "tool_end":
				toolEnd(ev.id, ev.isError);
				break;
		}
		if (stick) scrollToBottom();
		else $("jumpBtn").hidden = false;
	}

	// ── rendering ──────────────────────────────────────────────────────────────────
	function esc(s) {
		return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	}
	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function renderItem(item) {
		let node;
		switch (item.k) {
			case "user": {
				node = el("div", "msg user");
				node.textContent = item.text;
				if (item.images) node.appendChild(el("div", "meta", `📎 ${item.images} image${item.images > 1 ? "s" : ""}`));
				break;
			}
			case "assistant":
				node = el("div", "msg assistant");
				for (const b of item.blocks) node.appendChild(renderBlock(b));
				if (item.error && item.stop !== "aborted") node.appendChild(el("div", "err-line", `⚠ ${item.error}`));
				else if (item.stop === "aborted") node.appendChild(el("div", "err-line", "⏹ stopped"));
				break;
			case "tool":
				node = toolCard(item.id, item.name, "", "");
				fillToolResult(node, item);
				break;
			case "bash": {
				node = el("details", "tool");
				const s = el("summary");
				s.append(el("span", "tname", "$"), el("span", "ttitle", item.command), el("span", `tstate ${item.exitCode === 0 ? "ok" : "err"}`));
				const body = el("div", "tbody");
				body.appendChild(el("pre", "out", item.output || "(no output)"));
				node.append(s, body);
				node.classList.add("msg");
				break;
			}
			case "custom":
				node = el("div", "msg custom");
				node.append(el("div", "tag", item.customType), mdNode(item.text));
				break;
			case "summary":
				node = el("details", "msg summary");
				node.append(el("summary", "tag", item.kind === "compaction" ? "Context compacted — summary" : "Branch summary"), mdNode(item.text));
				break;
			default:
				node = el("div");
		}
		node.id = `i-${item.id}`;
		return node;
	}

	function renderBlock(b) {
		if (b.t === "text") return mdNode(b.text);
		if (b.t === "thinking") {
			const d = el("details", "thinking");
			d.append(el("summary", "", "Thinking…"), mdNode(b.text));
			return d;
		}
		return toolCard(b.id, b.name, b.title, b.args);
	}

	function toolCard(id, name, title, args) {
		const existing = id && document.getElementById(`t-${id}`);
		if (existing && !existing.closest("#transcript")) existing.remove();
		const d = el("details", "tool");
		d.id = `t-${id}`;
		const s = el("summary");
		s.append(el("span", "tname", name), el("span", "ttitle", title || ""), el("span", "tstate"));
		const body = el("div", "tbody");
		if (args) {
			body.appendChild(el("div", "label", "input"));
			body.appendChild(el("pre", "out", args));
		}
		d.append(s, body);
		return d;
	}

	function fillToolResult(card, item) {
		card.querySelector(".tstate").className = `tstate ${item.isError ? "err" : "ok"}`;
		card.classList.toggle("err", item.isError);
		const body = card.querySelector(".tbody");
		body.querySelectorAll(".result").forEach((n) => n.remove());
		const box = el("div", "result");
		if (item.diff) {
			box.appendChild(el("div", "label", "diff"));
			box.appendChild(diffNode(item.diff));
		} else {
			box.appendChild(el("div", "label", item.isError ? "error" : "output"));
			box.appendChild(el("pre", "out", item.output || "(no output)"));
			if (item.truncated) {
				const more = el("button", "more", "Show full output");
				more.onclick = async () => {
					more.disabled = true;
					try {
						const r = await call("toolOutput", { id: item.id });
						box.querySelector("pre").textContent = r.output;
						more.remove();
					} catch (e) {
						toast(e.message, "error");
						more.disabled = false;
					}
				};
				box.appendChild(more);
			}
		}
		body.appendChild(box);
		if (item.isError) card.open = true;
	}

	function attachToolResult(item) {
		const card = document.getElementById(`t-${item.id}`);
		if (!card || !card.closest("#transcript")) return false;
		fillToolResult(card, item);
		return true;
	}

	/** Moves standalone tool-result items into their call cards (snapshot renders them as separate items). */
	function linkToolResults() {
		for (const res of [...document.querySelectorAll("#transcript > .tool[id^='i-']")]) {
			const id = res.id.slice(2);
			const card = document.getElementById(`t-${id}`);
			if (!card || card === res || !card.closest("#transcript")) continue;
			card.querySelector(".tstate").className = res.querySelector(".tstate").className;
			card.classList.toggle("err", res.classList.contains("err"));
			const result = res.querySelector(".result");
			if (result) {
				card.querySelectorAll(".result").forEach((n) => n.remove());
				card.querySelector(".tbody").appendChild(result);
			}
			res.remove();
		}
	}

	function diffNode(text) {
		const pre = el("pre", "out diff");
		for (const line of text.split("\n")) {
			const c = line[0];
			const span = el("span", c === "+" ? "a" : c === "-" ? "d" : c === "@" ? "h" : "", line || " ");
			if (!span.className) {
				pre.append(document.createTextNode(`${line}\n`));
				continue;
			}
			pre.appendChild(span);
		}
		return pre;
	}

	// Live tool state (between tool_start and the result item).
	function toolStart(id, name, title, output) {
		let card = document.getElementById(`t-${id}`);
		if (!card) {
			card = toolCard(id, name, title, "");
			$("liveTools").appendChild(card);
		}
		card.querySelector(".tstate").className = "tstate run";
		if (output) toolUpdate(id, output);
	}
	function toolUpdate(id, output) {
		const card = document.getElementById(`t-${id}`);
		if (!card) return;
		let live = card.querySelector(".live");
		if (!live) {
			live = el("pre", "out live");
			card.querySelector(".tbody").appendChild(live);
			card.open = true;
		}
		live.textContent = output;
		live.scrollTop = live.scrollHeight;
	}
	function toolEnd(id, isError) {
		const card = document.getElementById(`t-${id}`);
		if (!card) return;
		card.querySelector(".tstate").className = `tstate ${isError ? "err" : "ok"}`;
		card.querySelector(".live")?.remove();
		card.open = isError;
		if (card.parentElement === $("liveTools")) $("transcript").appendChild(card);
	}

	let streamRaf = 0;
	function scheduleStreamRender() {
		if (streamRaf) return;
		streamRaf = setTimeout(() => {
			streamRaf = 0;
			const stick = nearBottom();
			renderStream();
			if (stick) scrollToBottom();
		}, 80);
	}
	function renderStream() {
		const s = S.view?.stream;
		if (!s) return;
		const node = el("div", "msg assistant");
		node.id = `i-${s.key}`;
		for (const [i, b] of s.blocks.entries()) {
			if (!b) continue;
			if (b.t === "text") node.appendChild(mdNode(b.text));
			else if (b.t === "thinking") {
				const d = el("details", "thinking");
				d.open = false;
				d.append(el("summary", "", "Thinking…"));
				node.appendChild(d);
			} else node.appendChild(toolCard(`stream-${s.key}-${i}`, b.name || "tool", "", b.text.slice(-1500)));
		}
		node.lastElementChild?.classList.add("cursor");
		if (!node.children.length) node.appendChild(el("div", "cursor"));
		const old = document.getElementById(node.id);
		if (old) {
			const openThinking = old.querySelector("details.thinking[open]");
			if (openThinking) node.querySelector("details.thinking")?.setAttribute("open", "");
			old.replaceWith(node);
		} else $("transcript").appendChild(node);
	}

	// Minimal, escape-first Markdown: fenced code, headings, lists, quotes, tables, inline code/bold/italic/links.
	function mdNode(text) {
		const div = el("div", "md");
		div.innerHTML = md(String(text || ""));
		return div;
	}
	function inline(s) {
		const codes = [];
		s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
		s = esc(s)
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
			.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
			.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
			.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
		return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
	}
	function md(src) {
		const out = [];
		const lines = src.replace(/\r\n/g, "\n").split("\n");
		let i = 0;
		let para = [];
		const flush = () => {
			if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
			para = [];
		};
		while (i < lines.length) {
			const line = lines[i];
			const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
			if (fence) {
				flush();
				const close = fence[1];
				const body = [];
				i++;
				while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
				i++;
				out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
				continue;
			}
			const h = /^(#{1,4})\s+(.*)$/.exec(line);
			if (h) {
				flush();
				out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
				i++;
				continue;
			}
			if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
				flush();
				out.push("<hr>");
				i++;
				continue;
			}
			if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
				flush();
				const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
				const head = row(line);
				i += 2;
				const rows = [];
				while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(row(lines[i++]));
				out.push(
					`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
						.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
						.join("")}</tbody></table>`,
				);
				continue;
			}
			const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
			if (list) {
				flush();
				const ordered = /\d/.test(list[1]);
				const items = [];
				while (i < lines.length) {
					const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
					if (m) items.push(m[2]);
					else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
					else break;
					i++;
				}
				const tag = ordered ? "ol" : "ul";
				out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
				continue;
			}
			if (/^\s*>/.test(line)) {
				flush();
				const q = [];
				while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
				out.push(`<blockquote>${md(q.join("\n"))}</blockquote>`);
				continue;
			}
			if (!line.trim()) {
				flush();
				i++;
				continue;
			}
			para.push(line);
			i++;
		}
		flush();
		return out.join("");
	}

	// ── header, prompts, composer ──────────────────────────────────────────────────
	function agentName(agent) {
		return S.agents.get(agent)?.name || "pi";
	}

	function shortPath(p) {
		const parts = String(p || "").split("/").filter(Boolean);
		return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p || "";
	}

	function setHeader() {
		const info = S.agents.get(S.current);
		const dot = $("statusDot");
		if (!info) {
			$("sessionName").textContent = S.device ? (S.agents.size ? "Choose a session" : "pi mobile") : "pi mobile";
			$("sessionSub").textContent = S.device?.host || "";
			dot.className = "dot gone";
			$("modelBtn").hidden = true;
			updateTitle();
			return;
		}
		$("sessionName").textContent = info.name;
		const ctx = info.context?.percent != null ? ` · ${Math.round(info.context.percent)}% ctx` : "";
		const cost = info.cost ? ` · $${info.cost.toFixed(2)}` : "";
		$("sessionSub").textContent = `${info.task || shortPath(info.cwd)}${ctx}${cost}`;
		dot.className = `dot ${info.status}`;
		const mb = $("modelBtn");
		if (info.model) {
			mb.textContent = `${info.model.name || info.model.id}${info.model.reasoning && info.thinking ? ` · ${info.thinking}` : ""}`;
			mb.hidden = false;
		} else mb.hidden = true;
		updateComposer();
		updateTitle();
	}

	function updateTitle() {
		let waiting = 0;
		for (const m of S.prompts.values()) waiting += m.size;
		const info = S.agents.get(S.current);
		document.title = `${waiting ? `(${waiting}) ` : ""}${info ? info.name : "pi mobile"}`;
	}

	const answered = new Map();
	function renderPrompts(endEv) {
		const box = $("prompts");
		const map = S.prompts.get(S.current) || new Map();
		if (endEv && answered.has(endEv.id)) answered.delete(endEv.id);
		else if (endEv && endEv.by === "terminal") toast("Answered in the terminal");
		box.replaceChildren(...[...map.values()].map(promptNode));
		updateComposer();
	}

	function promptNode(p) {
		const card = el("div", "prompt");
		card.appendChild(el("div", "ptitle", p.title));
		if (p.message) card.appendChild(el("div", "pmsg", p.message));
		const canAct = S.device?.role === "control";
		const answer = async (value, btn) => {
			card.querySelectorAll("button,input").forEach((b) => (b.disabled = true));
			answered.set(p.id, true);
			try {
				await call("answer", { id: p.id, value });
			} catch (e) {
				answered.delete(p.id);
				toast(e.message, "error");
				card.querySelectorAll("button,input").forEach((b) => (b.disabled = false));
			}
		};
		const act = el("div", "pact");
		if (p.kind === "confirm") {
			const yes = el("button", "primary", "Yes");
			const no = el("button", "", "No");
			yes.onclick = () => answer(true);
			no.onclick = () => answer(false);
			act.append(yes, no);
		} else if (p.kind === "select") {
			act.classList.add("col");
			for (const o of p.options || []) {
				const b = el("button", "", o);
				b.onclick = () => answer(o);
				act.appendChild(b);
			}
			const cancel = el("button", "", "Cancel");
			cancel.onclick = () => answer(undefined);
			act.appendChild(cancel);
		} else {
			const input = el("input");
			input.placeholder = p.placeholder || "";
			input.enterKeyHint = "send";
			card.appendChild(input);
			const ok = el("button", "primary", "Submit");
			const cancel = el("button", "", "Cancel");
			ok.onclick = () => answer(input.value);
			cancel.onclick = () => answer(undefined);
			input.onkeydown = (e) => {
				if (e.key === "Enter") ok.click();
			};
			act.append(ok, cancel);
		}
		if (canAct) card.appendChild(act);
		const foot = el("div", "pfoot", canAct ? "Also open in the terminal — first answer wins." : "Waiting for an answer (view-only device).");
		if (p.expiresAt) {
			const tick = () => {
				const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
				foot.textContent = `${canAct ? "First answer wins" : "View-only"} · times out in ${s}s`;
				if (s > 0 && card.isConnected) setTimeout(tick, 1000);
			};
			tick();
		}
		card.appendChild(foot);
		return card;
	}

	function updateComposer() {
		const control = S.device?.role === "control";
		const info = S.agents.get(S.current);
		$("composer").hidden = !S.device || !control || !info;
		$("viewOnly").hidden = !S.device || control || !info;
		const busy = info && info.status !== "idle";
		$("stopBtn").hidden = !busy || info.status === "waiting";
		$("modeBtn").hidden = !busy;
		$("modeBtn").textContent = S.mode === "followUp" ? "queue" : "steer";
		$("modeBtn").classList.toggle("queue", S.mode === "followUp");
		$("input").placeholder = busy ? (S.mode === "followUp" ? "Queue a follow-up…" : "Steer pi…") : "Message pi…";
		$("sendBtn").disabled = !S.online;
	}

	function autosize() {
		const t = $("input");
		t.style.height = "auto";
		t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
	}

	async function send() {
		const input = $("input");
		const text = input.value;
		if (!text.trim() && !S.attachments.length) return;
		const images = S.attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
		$("sendBtn").disabled = true;
		try {
			const r = await call("send", { text, images, mode: S.mode });
			input.value = "";
			S.attachments = [];
			renderAttachments();
			autosize();
			hideSuggest();
			if (r.delivered === "steer") toast("Steering message queued");
			else if (r.delivered === "followUp") toast("Follow-up queued");
			else if (r.delivered === "command") toast("Command sent");
		} catch (e) {
			toast(e.message, "error");
		} finally {
			$("sendBtn").disabled = !S.online;
		}
	}

	// ── attachments ────────────────────────────────────────────────────────────────
	async function addFiles(files) {
		for (const f of files) {
			if (!f.type.startsWith("image/")) continue;
			try {
				S.attachments.push(await downscale(f));
			} catch (e) {
				toast(`Could not read image: ${e.message}`, "error");
			}
		}
		renderAttachments();
	}

	function downscale(file, max = 1600) {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				const scale = Math.min(1, max / Math.max(img.width, img.height));
				const c = document.createElement("canvas");
				c.width = Math.round(img.width * scale);
				c.height = Math.round(img.height * scale);
				c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
				URL.revokeObjectURL(url);
				const dataUrl = c.toDataURL("image/jpeg", 0.85);
				resolve({ preview: dataUrl, data: dataUrl.split(",")[1], mimeType: "image/jpeg" });
			};
			img.onerror = () => reject(new Error("unsupported image"));
			img.src = url;
		});
	}

	function renderAttachments() {
		const box = $("attachments");
		box.replaceChildren(
			...S.attachments.map((a, i) => {
				const w = el("div", "att");
				const img = el("img");
				img.src = a.preview;
				const x = el("button", "", "×");
				x.setAttribute("aria-label", "Remove image");
				x.onclick = () => {
					S.attachments.splice(i, 1);
					renderAttachments();
				};
				w.append(img, x);
				return w;
			}),
		);
		box.hidden = !S.attachments.length;
	}

	// ── slash command suggestions ──────────────────────────────────────────────────
	async function suggest() {
		const v = $("input").value;
		const m = /^\/(\S*)$/.exec(v);
		if (!m) return hideSuggest();
		if (!S.commands) {
			S.commands = [];
			try {
				S.commands = await call("commands");
			} catch {}
		}
		const q = m[1].toLowerCase();
		const hits = S.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 30);
		const box = $("suggest");
		if (!hits.length) return hideSuggest();
		box.replaceChildren(
			...hits.map((c) => {
				const b = el("button");
				b.append(el("span", "cmd", `/${c.name}`), el("span", "desc", c.description));
				b.onclick = () => {
					$("input").value = `/${c.name} `;
					hideSuggest();
					$("input").focus();
				};
				return b;
			}),
		);
		box.hidden = false;
	}
	function hideSuggest() {
		$("suggest").hidden = true;
	}

	// ── sheets ─────────────────────────────────────────────────────────────────────
	function openSheet(build) {
		const body = $("sheetBody");
		body.replaceChildren();
		build(body);
		$("sheet").hidden = false;
	}
	function closeSheet() {
		$("sheet").hidden = true;
	}

	function sessionsSheet() {
		openSheet((body) => {
			body.appendChild(el("h3", "", `Sessions on ${S.device?.host || "this computer"}`));
			if (!S.agents.size) body.appendChild(el("p", "note", "No pi session is sharing right now. Run /remote in pi."));
			for (const a of sortedAgents()) {
				const row = el("button", `row${a.agent === S.current ? " active" : ""}`);
				const asks = [...(S.prompts.get(a.agent)?.values() || [])];
				const waiting = asks.length;
				const g = el("span", "grow");
				g.append(el("span", "", a.name), el("span", "sub", a.task || shortPath(a.cwd)));
				if (asks.length) g.appendChild(el("span", "ask", `asks: ${asks[0].title}`));
				else if (a.status === "waiting") g.appendChild(el("span", "ask", "needs input in the terminal"));
				else if (a.last) g.appendChild(el("span", "last", a.last));
				row.append(el("span", `dot ${a.status}`), g);
				if (waiting) row.appendChild(el("span", "badge", String(waiting)));
				row.onclick = () => {
					closeSheet();
					if (a.agent !== S.current) {
						S.current = a.agent;
						loadCurrent();
					}
				};
				body.appendChild(row);
			}
			const starter = [...S.agents.values()].find((a) => a.herdr);
			if (starter && S.device?.role === "control") {
				const add = el("button", "row", "＋ New session…");
				add.onclick = () => newSessionSheet(starter.agent);
				body.appendChild(add);
			}
		});
	}

	/** Starts pi in a herdr tab on this computer: pick a folder, optionally give it a first prompt. */
	function newSessionSheet(starter) {
		const folders = [...new Set([...S.agents.values()].map((a) => a.cwd))].sort();
		openSheet((body) => {
			body.appendChild(el("h3", "", "New session"));
			const folder = el("input");
			folder.value = S.agents.get(S.current)?.cwd || folders[0] || "";
			folder.placeholder = "/path/to/project";
			folder.setAttribute("list", "folders");
			const list = el("datalist");
			list.id = "folders";
			for (const f of folders) {
				const o = el("option");
				o.value = f;
				list.appendChild(o);
			}
			const prompt = el("textarea");
			prompt.rows = 3;
			prompt.placeholder = "First prompt (optional)";
			const go = el("button", "row primary", "Start pi");
			go.onclick = async () => {
				go.disabled = true;
				const spawnId = Math.random().toString(36).slice(2, 10);
				try {
					S.spawning = spawnId;
					await call("spawn", { cwd: folder.value.trim(), prompt: prompt.value, spawnId }, starter);
					closeSheet();
					toast("Starting pi…");
				} catch (e) {
					S.spawning = null;
					go.disabled = false;
					toast(e.message, "error");
				}
			};
			body.append(el("p", "note", "Opens a new herdr tab in that folder."), folder, list, prompt, go);
		});
	}

	async function modelSheet() {
		if (S.device?.role !== "control") return;
		openSheet((body) => body.appendChild(el("p", "note", "Loading models…")));
		try {
			S.models = await call("models");
		} catch (e) {
			closeSheet();
			return toast(e.message, "error");
		}
		const m = S.models;
		const info = S.agents.get(S.current);
		openSheet((body) => {
			if (info?.model?.reasoning) {
				body.appendChild(el("h3", "", "Thinking"));
				const lv = el("div", "levels");
				for (const l of m.levels) {
					const b = el("button", l === m.thinking ? "active" : "", l);
					b.onclick = async () => {
						try {
							await call("setThinking", { level: l });
							closeSheet();
						} catch (e) {
							toast(e.message, "error");
						}
					};
					lv.appendChild(b);
				}
				body.appendChild(lv);
			}
			body.appendChild(el("h3", "", "Model"));
			for (const x of m.models) {
				const active = m.current && x.provider === m.current.provider && x.id === m.current.id;
				const row = el("button", `row${active ? " active" : ""}`);
				const g = el("span", "grow");
				g.append(el("span", "", x.name), el("span", "sub", `${x.provider}/${x.id}`));
				row.appendChild(g);
				row.onclick = async () => {
					try {
						await call("setModel", { provider: x.provider, id: x.id });
						closeSheet();
						toast(`Model: ${x.name}`);
					} catch (e) {
						toast(e.message, "error");
					}
				};
				body.appendChild(row);
			}
		});
	}

	function menuSheet() {
		openSheet((body) => {
			const control = S.device?.role === "control";
			const add = (label, fn, cls = "") => {
				const b = el("button", `row ${cls}`, label);
				b.onclick = fn;
				body.appendChild(b);
			};
			body.appendChild(el("h3", "", "Session"));
			if (control && S.current) {
				add("Compact context", async () => {
					closeSheet();
					try {
						await call("compact", {});
						toast("Compacting…");
					} catch (e) {
						toast(e.message, "error");
					}
				});
			}
			add("Reload transcript", () => {
				closeSheet();
				loadCurrent();
			});
			body.appendChild(el("h3", "", "Notifications"));
			if (!pushSupported()) {
				body.appendChild(
					el("p", "note", "Lock-screen notifications need this page on HTTPS (in pi: /remote settings → HTTPS address, e.g. your Tailscale Serve address). On iPhone, also add it to the Home Screen first."),
				);
			} else if (S.push.on) add("Turn off notifications", () => setPush(false));
			else add("Notify me when pi finishes or asks", () => setPush(true));
			body.appendChild(el("h3", "", "Devices"));
			if (control) {
				add("Pair another device…", () => pairSheet("control"));
				add("Share view-only link…", () => pairSheet("view"));
				add("Manage devices…", devicesSheet);
			}
			add(
				"Unpair this device",
				async () => {
					closeSheet();
					try {
						await rpc("revoke", { ids: [S.device.d] });
					} catch {}
					streamAbort?.abort();
					unpaired("You unpaired this device");
				},
				"danger",
			);
			body.appendChild(el("p", "note", `Connected to ${S.device?.host || "?"} · ${S.device?.role === "view" ? "view-only" : "full control"} · end-to-end encrypted`));
		});
	}

	async function pairSheet(role) {
		try {
			const r = await rpc("pair", { role });
			const here = r.links.find((l) => l.url.startsWith(location.origin)) || r.links[0];
			openSheet((body) => {
				body.appendChild(el("h3", "", role === "view" ? "View-only link" : "Pair another device"));
				body.appendChild(el("p", "note", "Single use, valid 10 minutes. Anyone with this link gets " + (role === "view" ? "read access." : "full control.")));
				const pre = el("pre", "out", here.url);
				pre.style.whiteSpace = "pre-wrap";
				pre.style.wordBreak = "break-all";
				body.appendChild(pre);
				const actions = [];
				if (navigator.share) actions.push(["Share…", () => navigator.share({ url: here.url }).catch(() => {})]);
				if (navigator.clipboard) actions.push(["Copy", () => navigator.clipboard.writeText(here.url).then(() => toast("Copied"))]);
				for (const [label, fn] of actions) {
					const b = el("button", "row", label);
					b.onclick = fn;
					body.appendChild(b);
				}
			});
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function devicesSheet() {
		try {
			const list = await rpc("devices");
			openSheet((body) => {
				body.appendChild(el("h3", "", "Paired devices"));
				for (const d of list) {
					const row = el("button", "row");
					const g = el("span", "grow");
					const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never";
					g.append(el("span", "", `${d.name}${d.id === S.device.d ? " (this)" : ""}`), el("span", "sub", `${d.role} · last seen ${seen}`));
					row.append(g, el("span", "danger", "Revoke"));
					row.onclick = async () => {
						if (!confirm(`Revoke ${d.name}?`)) return;
						await rpc("revoke", { ids: [d.id] }).catch((e) => toast(e.message, "error"));
						if (d.id === S.device.d) return unpaired("You revoked this device");
						devicesSheet();
					};
					body.appendChild(row);
				}
			});
		} catch (e) {
			toast(e.message, "error");
		}
	}

	// ── several sessions ───────────────────────────────────────────────────────────
	function urgency(a) {
		return S.prompts.get(a.agent)?.size || a.status === "waiting" ? 0 : a.status === "working" ? 1 : 2;
	}
	function sortedAgents() {
		return [...S.agents.values()].sort((a, b) => urgency(a) - urgency(b));
	}

	/** A pill for other sessions that are waiting on you; tap to go there. */
	function renderAttention() {
		const others = sortedAgents().filter((a) => a.agent !== S.current && urgency(a) === 0);
		const pill = $("attention");
		if (!others.length) {
			pill.hidden = true;
			return;
		}
		const first = others[0];
		const ask = [...(S.prompts.get(first.agent)?.values() || [])][0];
		const what = ask ? `asks: ${ask.title}` : "needs you";
		pill.textContent = others.length === 1 ? `⚠ ${first.name} ${what}` : `⚠ ${others.length} sessions need you — ${first.name} ${what}`;
		pill.onclick = () => (others.length === 1 ? openAgent(first.agent) : sessionsSheet());
		pill.hidden = false;
	}

	/** One-time offer, only where notifications can actually work. */
	function maybeOnboard() {
		const box = $("onboard");
		box.hidden = !(
			pushSupported() &&
			S.device?.role === "control" &&
			!S.push.on &&
			Notification.permission !== "denied" &&
			!store.get("pi-mobile-onboarded")
		);
		$("onboardYes").onclick = () => {
			store.set("pi-mobile-onboarded", true);
			box.hidden = true;
			setPush(true);
		};
		$("onboardNo").onclick = () => {
			store.set("pi-mobile-onboarded", true);
			box.hidden = true;
		};
	}

	// ── lock-screen notifications ─────────────────────────────────────────────────
	function pushSupported() {
		return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
	}

	async function setPush(on) {
		closeSheet();
		try {
			const reg = await navigator.serviceWorker.register("sw.js");
			await navigator.serviceWorker.ready;
			let sub = await reg.pushManager.getSubscription();
			if (on) {
				if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications are blocked for this site");
				sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(S.push.key) });
				await rpc("push", { subscription: sub.toJSON() });
				toast("Notifications on");
			} else {
				await rpc("push", { subscription: null });
				await sub?.unsubscribe();
				toast("Notifications off");
			}
			S.push.on = on;
		} catch (e) {
			toast(`Notifications: ${e.message}`, "error");
		}
	}

	function openAgent(agent) {
		if (!agent || agent === S.current) return;
		S.current = agent;
		store.set(AGENT_KEY, agent);
		if (S.agents.has(agent)) loadCurrent();
	}

	// ── misc ───────────────────────────────────────────────────────────────────────
	function toast(text, level = "info") {
		const t = el("div", `toast ${level}`, text);
		$("toasts").appendChild(t);
		setTimeout(() => t.remove(), level === "error" ? 6000 : 3000);
	}
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	function nearBottom() {
		const s = $("scroller");
		return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
	}
	function scrollToBottom() {
		const s = $("scroller");
		s.scrollTop = s.scrollHeight;
		$("jumpBtn").hidden = true;
	}

	// ── wiring ─────────────────────────────────────────────────────────────────────
	function wire() {
		$("sessionBtn").onclick = () => S.device && sessionsSheet();
		$("modelBtn").onclick = modelSheet;
		$("menuBtn").onclick = () => S.device && menuSheet();
		$("olderBtn").onclick = loadOlder;
		$("jumpBtn").onclick = () => scrollToBottom(true);
		$("scroller").addEventListener("scroll", () => {
			if (nearBottom()) $("jumpBtn").hidden = true;
		});
		$("sheet").addEventListener("click", (e) => {
			if (e.target.hasAttribute("data-close")) closeSheet();
		});
		$("sendBtn").onclick = send;
		$("stopBtn").onclick = async () => {
			try {
				await call("abort");
			} catch (e) {
				toast(e.message, "error");
			}
		};
		$("modeBtn").onclick = () => {
			S.mode = S.mode === "followUp" ? "steer" : "followUp";
			store.set(MODE_KEY, S.mode);
			updateComposer();
		};
		const input = $("input");
		input.addEventListener("input", () => {
			autosize();
			suggest();
		});
		input.addEventListener("keydown", (e) => {
			// Enter sends on a hardware keyboard; on touch keyboards Enter inserts a newline.
			const touch = matchMedia("(pointer: coarse)").matches;
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (!touch || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				send();
			}
		});
		input.addEventListener("paste", (e) => {
			const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
			if (files.length) {
				e.preventDefault();
				addFiles(files);
			}
		});
		$("fileInput").onchange = (e) => {
			addFiles([...e.target.files]);
			e.target.value = "";
		};
	}

	async function main() {
		wire();
		// Opened from a notification: jump to that session.
		const fromPush = new URLSearchParams(location.search).get("agent");
		if (fromPush) {
			store.set(AGENT_KEY, fromPush);
			history.replaceState(null, "", location.pathname + location.hash);
		}
		if (pushSupported()) {
			navigator.serviceWorker.register("sw.js").catch(() => {});
			navigator.serviceWorker.addEventListener("message", (e) => e.data?.type === "open" && openAgent(e.data.agent));
		}
		const paired = await pairFromHash();
		if (paired === "failed") return;
		if (!S.device) return unpaired();
		showEmpty("<p>Connecting…</p>");
		S.current = store.get(AGENT_KEY);
		setHeader();
		streamLoop();
	}

	// What voice.js needs from the app.
	window.PiMobile = {
		S,
		rpc,
		call,
		toast,
		agentName,
		openAgent,
		autosize,
		openSheet,
		sessionsSheet,
		input: () => $("input"),
	};

	main();
})();
