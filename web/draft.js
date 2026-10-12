// pi mobile — long dictation becomes a draft (designs/voice-modalities.md, "Long-form"). While you dictate
// in the composer, the recording is also cut at pauses into 10-15 s chunks and sent to the computer,
// which recognises them and keeps the draft with the terminal's drafting engine (pi-speech
// phone-drafts.ts). Once the dictation is long, or a description, the composer grows into the draft
// sheet: the draft as rendered Markdown, what just changed glowing then fading, the latest words on a
// Hearing line, the time against the 10-minute limit. Finishing runs one check against everything
// you said; the draft then stays for refining: dictate a change, or edit it as text. Send sends it;
// Keep as text puts it in the message box. Nothing is lost: the transcript stays on the computer.
"use strict";

(() => {
	const V = window.PiVoiceCore;
	const $ = (id) => document.getElementById(id);
	const app = () => window.PiMobile;
	const GLOW_MS = 3000;
	const MIN_CHUNK_MS = 10_000;
	const MAX_CHUNK_MS = 15_000;
	/** Recordings this long (or longer) from the iPhone app, which can't send chunks, are checked for a draft at the end. */
	const WHOLE_MS = 30_000;
	/** Tests and screenshots shorten the chunks: window.PiDraftDebug = { minMs, maxMs }. */
	const dbg = () => window.PiDraftDebug || {};
	/** No fades: a reduced-motion setting, or forced colours (a tint wouldn't show). Changes get a margin mark. */
	const still = () => matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)").matches;

	// ── state ──────────────────────────────────────────────────────────────────────────────────────────────────
	// ui: idle | forming (recording) | checking (finishing) | ready | changing (a change by voice) | text (editing as text)
	// One object per recording: whatever awaits holds its own `d` and stops once D is a new one (reset()).
	let D = fresh();
	function fresh() {
		return {
			id: null,
			agent: null,
			started: 0,
			version: 0,
			view: null,
			/** Markdown typed by hand (Edit as text): what Send and Keep as text use, verbatim, until the next change by voice. */
			typed: null,
			shown: false,
			ui: "idle",
			cap: null,
			/** The chunks on their way to the computer (voice-core.js DraftUplink). */
			up: null,
			frames: [],
			following: false,
			finishing: false,
			/** The computer lost this draft (or never had drafts): the recording goes on, as an ordinary dictation. */
			lost: false,
			raw: "",
			note: "",
			glow: new Map(),
			gone: new Map(),
			userScroll: 0,
			maxMs: 600_000,
			warnMs: 540_000,
		};
	}
	let hooks = { message: () => {}, hideMessage: () => {} };

	/** The draft lives in the pi session it was started from (its computer has the transcript). */
	const call = (m, p, d = D) => app().call(m, p, d.agent);
	/** The computer lost the draft, or can't do drafts (an older pi-mobile): dictation goes on as before. */
	const gone = (e) => /unknown request|not available|no longer open|no longer connected|can't listen|unavailable/i.test(String(e?.message || e));

	// ── audio: 16 kHz WAV chunks cut at pauses ────────────────────────────────────────────────────────────────────
	/** 16-bit mono WAV at 16 kHz (base64) from Float32 frames at `rate`, averaging down (a cheap low-pass). */
	function wav64(frames, rate) {
		const n = frames.reduce((s, f) => s + f.length, 0);
		const all = new Float32Array(n);
		let o = 0;
		for (const f of frames) {
			all.set(f, o);
			o += f.length;
		}
		const ratio = Math.max(1, rate / 16000);
		const m = Math.floor(n / ratio);
		const bytes = new Uint8Array(44 + m * 2);
		const v = new DataView(bytes.buffer);
		const str = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
		str(0, "RIFF");
		v.setUint32(4, 36 + m * 2, true);
		str(8, "WAVEfmt ");
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, 16000, true);
		v.setUint32(28, 32000, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		str(36, "data");
		v.setUint32(40, m * 2, true);
		for (let i = 0; i < m; i++) {
			const a = Math.floor(i * ratio);
			const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
			let s = 0;
			for (let j = a; j < b; j++) s += all[j];
			v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s / (b - a))) * 0x7fff, true);
		}
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(bin);
	}

	/**
	 * Starts listening alongside the composer's recorder: every frame is kept until a chunk is cut at the
	 * first pause after 10 s (at 15 s without one); the chunk is numbered and sent, and the first one
	 * opens the draft on the computer. The composer's own recording stays whole: it is the fallback.
	 */
	function capture({ stream, ctx, agent, started }) {
		if (D.id || D.cap || D.up) reset();
		const d = D;
		d.agent = agent;
		d.started = started;
		d.ui = "forming";
		d.up = new V.DraftUplink({
			call: (m, p) => call(m, p, d),
			gone,
			params: () => ({ elapsedMs: Date.now() - d.started, since: d.version }),
			shown: () => d.shown,
			onStart: (s) => {
				d.id = s.id;
				d.maxMs = s.maxMs || d.maxMs;
				d.warnMs = s.warnMs || d.warnMs;
			},
			onView: (r) => {
				if (D !== d) return;
				if (d.ui === "forming") render(r);
				void follow();
			},
			// No drafts here (or the computer lost this one): nothing more is kept; the recording itself is the fallback.
			onOff: () => {
				stopCapture(d);
				d.frames = [];
				d.lost = true;
				if (D === d && d.shown) setUi(d.ui, "The computer lost this draft. Keep talking: when you finish, the whole recording becomes an ordinary dictation.");
			},
		});
		try {
			const src = ctx.createMediaStreamSource(stream);
			const proc = ctx.createScriptProcessor(4096, 1, 1);
			const mute = ctx.createGain();
			mute.gain.value = 0;
			src.connect(proc);
			proc.connect(mute).connect(ctx.destination);
			const chunker = new V.Chunker({ minMs: dbg().minMs ?? MIN_CHUNK_MS, maxMs: dbg().maxMs ?? MAX_CHUNK_MS });
			const rate = ctx.sampleRate;
			proc.onaudioprocess = (e) => {
				if (d.cap?.proc !== proc) return;
				const f = new Float32Array(e.inputBuffer.getChannelData(0));
				let sum = 0;
				for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
				d.frames.push(f);
				if (chunker.feed(Math.sqrt(sum / f.length), (f.length / rate) * 1000)) cut(d);
			};
			d.cap = { src, proc, mute, rate };
		} catch {
			d.up.close();
			d.up = null;
		}
	}

	function stopCapture(d = D) {
		const c = d.cap;
		if (!c?.proc) return;
		d.cap = { rate: c.rate };
		try {
			c.proc.onaudioprocess = null;
			c.src.disconnect();
			c.proc.disconnect();
			c.mute.disconnect();
		} catch {}
	}

	/** A chunk ends at a pause: encoded now (16 kHz, a third of the memory), numbered and sent by the uplink. */
	function cut(d) {
		if (!d.frames.length || !d.up?.live) return;
		const audio = wav64(d.frames, d.cap.rate);
		d.frames = [];
		d.up.add(audio);
	}

	/** While the draft forms: each change as soon as the computer has applied it. */
	async function follow() {
		const d = D;
		if (d.following || !d.id) return;
		d.following = true;
		const live = () => D === d && d.ui === "forming" && !d.finishing;
		try {
			while (live()) {
				const r = await call("draftState", { id: d.id, since: d.version, wait: true }, d);
				if (live()) render(r);
			}
		} catch {
			// A dropped connection: the next chunk's answer catches up.
		} finally {
			d.following = false;
		}
	}

	// ── finishing, refining, sending ─────────────────────────────────────────────────────────────────────────────────────
	/**
	 * The recording ended (✓, release, the limit). Returns null when there is no draft (a short dictation,
	 * or a computer without drafts): the caller distils the whole recording as before; { prompt: raw }
	 * when the computer found it a request after all; { draft: true } when the draft sheet now holds it;
	 * { lost: true } when the computer lost the draft (or never took all of it): the sheet closes and the
	 * caller transcribes the whole recording, so nothing said is lost; { closed: true } when the draft was
	 * closed meanwhile. `keep`: ✕ while a draft formed, stop and keep it as text, without the check.
	 */
	async function finish({ elapsedMs, keep = false }) {
		const d = D;
		stopCapture(d);
		const up = d.up;
		if (!up?.live || !up.started) {
			const lost = !!up?.lost;
			if (lost || !d.shown) reset();
			return lost ? { lost: true } : d.shown ? { draft: true } : null;
		}
		d.finishing = true;
		if (d.shown) setUi("checking", keep ? "" : "Checking the draft against everything you said…");
		const rest = d.frames.length ? wav64(d.frames, d.cap?.rate || 48000) : undefined;
		d.frames = [];
		const r = await up.finish(rest, { elapsedMs, since: d.version, draft: d.shown || keep, check: !keep });
		if (D !== d || r.closed) return { closed: true };
		if (r.lost || (r.none && d.shown)) {
			reset();
			return { lost: true };
		}
		if (r.none) {
			reset();
			return null;
		}
		const v = r.view;
		if (!v.isDraft) {
			reset();
			return { prompt: v.raw || "" };
		}
		d.raw = v.raw || "";
		d.finishing = false;
		if (!d.shown) show();
		render(v, true);
		setUi("ready", v.note || "");
		if (keep) keepAsText();
		return { draft: true };
	}

	/** A whole recording from the iPhone app (it can't send chunks): long ones may become a draft at the end. */
	async function whole({ audio, mime, elapsedMs, agent }) {
		if (elapsedMs < WHOLE_MS || D.shown) return null;
		reset();
		const d = D;
		d.agent = agent;
		try {
			const s = await call("draftStart", {}, d);
			if (D !== d) return { closed: true };
			d.id = s.id;
			const r = await call("draftFinish", { id: d.id, seq: 0, audio, mime, elapsedMs, since: 0 }, d);
			if (D !== d) return { closed: true };
			if (!r.isDraft) {
				reset();
				return { prompt: r.raw || "" };
			}
			d.raw = r.raw || "";
			show();
			render(r, true);
			setUi("ready", r.note || "");
			return { draft: true };
		} catch {
			if (D !== d) return { closed: true };
			const id = d.id;
			reset();
			if (id) call("draftClose", { id, how: "discard" }, d).catch(() => {});
			return null;
		}
	}

	/** A change said out loud while the draft waits ("drop the third point"). */
	async function change({ audio, mime }) {
		const d = D;
		if (!d.shown || !d.id) return;
		const text = d.ui === "text" ? $("draftText").value : null;
		if (text !== null) {
			if (text !== saved()) d.typed = text;
			showText(false);
		}
		// What you typed goes first, so the change applies to it.
		const typed = d.typed ?? undefined;
		setUi("changing", "");
		try {
			const r = await call("draftEdit", { id: d.id, audio, mime, markdown: typed, since: d.version }, d);
			if (D !== d) return;
			// Changed by voice: from now on the computer's draft is the one to send.
			if (r.heard) d.typed = null;
			render(r);
			setUi("ready", r.note || "");
		} catch (e) {
			if (D !== d) return;
			setUi("ready", gone(e) ? "The computer lost this draft. Keep as text keeps what is here." : `Couldn't apply the change (${e.message}).`);
		}
	}

	/** Your own text: kept as you typed it (what Send sends), and sent to the computer so later changes by voice start from it. It never glows. */
	async function saveText() {
		const d = D;
		const text = $("draftText").value;
		showText(false);
		if (text === saved()) return setUi("ready", d.note);
		d.typed = text;
		d.view = { ...d.view, markdown: text, blocks: blocksOf(text) };
		draw(d.view, false);
		setUi("ready", "");
		try {
			const r = await call("draftEdit", { id: d.id, markdown: text, since: d.version }, d);
			if (D === d) render(r);
		} catch {}
	}

	/** A draft typed by hand, for showing until the computer answers: the same blocks the computer keeps. */
	function blocksOf(text) {
		return V.markdownBlocks(text).map((b, i) => ({ id: `t${i}`, ...b }));
	}

	/** What Send and Keep as text use: the text being edited, else what you typed, else the computer's draft. */
	const markdown = () => (D.ui === "text" ? $("draftText").value : saved());
	/** The draft as it stands, apart from text being edited right now. */
	const saved = () => D.typed ?? D.view?.markdown ?? "";

	/**
	 * Send sends the draft to the session on screen, as the composer always does (the draft sheet is the
	 * composer, which stays as it is when you switch sessions), with any images attached in it.
	 */
	async function send() {
		if (!canSend()) return;
		const d = D;
		const md = markdown();
		if (!md.trim()) return setUi(d.ui, "The draft is empty. Keep as text closes it.");
		if (!(await app().sendText(md, app().images(), app().S.current))) return;
		app().clearAttachments();
		if (D === d) close("sent");
	}

	/** Into the message box, after anything in it now; the transcript stays on the computer for a week. */
	function keepAsText() {
		if (!D.shown) return;
		const md = markdown().trim() ? markdown() : D.raw;
		const input = app().input();
		const now = input.value;
		input.value = now.trim() ? `${now.replace(/\s+$/, "")}\n\n${md}` : md;
		close("kept");
		app().autosize();
		hooks.message("The draft is in the message box. What you said stays on the computer for 7 days.");
	}

	function close(how) {
		if (D.id) call("draftClose", { id: D.id, how }).catch(() => {});
		reset();
	}

	function reset() {
		stopCapture();
		D.up?.close();
		clearTimeout(D.sweep);
		const wasShown = D.shown;
		D = fresh();
		if (wasShown) hide();
	}

	// ── the sheet ────────────────────────────────────────────────────────────────────────────────────────────────────
	const STATE = { forming: "Listening", checking: "Checking…", changing: "Changing…", ready: "Ready to send", text: "Editing" };

	/** The composer grows into the draft sheet (built once; updated in place). */
	function show() {
		D.shown = true;
		const sheet = $("draftSheet");
		if (!sheet.firstChild) build(sheet);
		$("draftBody").replaceChildren();
		$("draftText").value = "";
		showText(false);
		sheet.hidden = false;
		$("composer").classList.add("drafting");
		$("draftHint").hidden = false;
		setUi(D.ui, D.note);
	}

	function hide() {
		$("draftSheet").hidden = true;
		$("composer").classList.remove("drafting");
		$("draftHint").hidden = true;
		app().updateSend();
	}

	function build(sheet) {
		const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});
		const head = el("div", "draft-head");
		const names = el("div", "grow");
		names.append(el("p", "draft-eyebrow", "Draft"), Object.assign(el("h2", "draft-title"), { id: "draftTitle" }));
		const state = Object.assign(el("p", "draft-state"), { id: "draftState" });
		state.setAttribute("role", "status");
		state.append(el("span", "draft-live"), el("span", "spinner"), el("span", "draft-state-text"));
		head.append(names, state);
		const body = Object.assign(el("div", "draft-body md"), { id: "draftBody", tabIndex: 0 });
		body.setAttribute("role", "region");
		body.setAttribute("aria-labelledby", "draftTitle");
		// Scrolling yourself stops the view following the latest change for a while.
		const mine = () => (D.userScroll = Date.now());
		body.addEventListener("touchmove", mine, { passive: true });
		body.addEventListener("wheel", mine, { passive: true });
		// Without motion, the margin marks stay until you touch the draft.
		body.addEventListener("pointerdown", () => body.querySelectorAll(".marked").forEach((b) => b.classList.remove("marked")));
		const text = Object.assign(el("textarea", "draft-text"), { id: "draftText", hidden: true, spellcheck: true });
		text.setAttribute("aria-label", "Draft as Markdown");
		text.addEventListener("input", () => app().updateSend());
		const hearing = Object.assign(el("p", "draft-hearing"), { id: "draftHearing" });
		hearing.append(el("span", "draft-hearing-label", "Hearing"), el("span", "draft-hearing-words"));
		const note = Object.assign(el("p", "draft-note"), { id: "draftNote" });
		note.setAttribute("aria-live", "polite");
		const actions = Object.assign(el("div", "draft-actions"), { id: "draftActions" });
		const keep = Object.assign(el("button", "pill", "Keep as text"), { id: "draftKeep", title: "Put the draft in the message box" });
		keep.onclick = () => keepAsText();
		const edit = Object.assign(el("button", "pill", "Edit as text"), { id: "draftEdit" });
		edit.onclick = () => (D.ui === "text" ? saveText() : startText());
		actions.append(keep, edit);
		sheet.append(head, body, text, hearing, note, actions);
	}

	function startText() {
		if (!D.shown || D.ui !== "ready") return;
		const t = $("draftText");
		t.value = markdown();
		showText(true);
		setUi("text", "");
		t.focus({ preventScroll: true });
	}

	function showText(on) {
		$("draftText").hidden = !on;
		$("draftBody").hidden = on;
		$("draftEdit").textContent = on ? "Done" : "Edit as text";
		$("draftEdit").setAttribute("aria-pressed", String(on));
	}

	function setUi(ui, note) {
		D.ui = ui;
		if (note !== undefined) D.note = note;
		if (!D.shown) return;
		const sheet = $("draftSheet");
		sheet.dataset.ui = ui;
		sheet.querySelector(".draft-state-text").textContent = STATE[ui] || "";
		$("draftActions").hidden = !(ui === "ready" || ui === "text");
		// A draft the computer lost no longer forms: the recording goes on, for an ordinary dictation.
		$("draftHearing").hidden = ui !== "forming" || !!D.lost;
		$("draftHint").textContent = ui === "forming" ? (D.lost ? "Still recording" : "Drafting while you talk") : ui === "ready" || ui === "text" ? "Dictate a change, or send" : "One moment…";
		noteLine();
		app().updateSend();
	}

	/** The limit warning wins while recording; otherwise the last note (the check's result, an error). */
	function noteLine(elapsedMs) {
		if (!D.shown) return;
		const n = $("draftNote");
		const c = D.ui === "forming" && elapsedMs !== undefined ? V.draftClock(elapsedMs, D.maxMs, D.warnMs) : null;
		const text = c?.warn ? c.left : D.note;
		if (n.textContent !== text) n.textContent = text;
		n.classList.toggle("warn", !!c?.warn);
		n.hidden = !text;
	}

	/** A view from the computer: newer than what is shown, it is drawn; its changed blocks glow. */
	function render(view, force = false) {
		if (!view || view.id !== D.id || (!force && view.version <= D.version)) return;
		D.version = view.version;
		D.view = view;
		if (view.isDraft && !D.shown && D.ui === "forming") show();
		if (D.shown) draw(view, true);
	}

	function draw(view, dictated) {
		$("draftTitle").textContent = view.title || "Untitled draft";
		// The latest words not yet in the draft; the line keeps its place while there are none.
		const words = $("draftHearing").querySelector(".draft-hearing-words");
		const hearing = view.hearing || "";
		if (words.textContent !== hearing) words.textContent = hearing;
		$("draftHearing").classList.toggle("quiet", !hearing);
		const body = $("draftBody");
		const now = Date.now();
		const byId = new Map([...body.children].map((n) => [n.dataset.id, n]));
		const stillMode = still();
		const glowing = view.blocks.some((b) => b.changed || b.removed) && dictated;
		// Without motion: the marks show the latest dictated change only.
		if (glowing && stillMode) body.querySelectorAll(".marked").forEach((n) => n.classList.remove("marked"));
		let cursor = body.firstChild;
		let last = null;
		const seen = new Set();
		for (const b of view.blocks) {
			const key = String(b.id);
			// A removed point is shown struck through for GLOW_MS, then it goes.
			if (b.removed && D.gone.has(key) && now - D.gone.get(key) >= GLOW_MS) continue;
			seen.add(key);
			let node = byId.get(key);
			if (!node) {
				node = document.createElement("div");
				node.dataset.id = key;
			}
			if (node.dataset.src !== b.src) {
				node.dataset.src = b.src;
				node.className = `draft-block ${b.kind}`;
				const md = app().mdNode(b.src);
				// Each point is its own list: numbered ones keep their number.
				const n = /^\s*(\d+)[.)]\s/.exec(b.src);
				if (n) md.querySelector("ol")?.setAttribute("start", n[1]);
				node.replaceChildren(...md.childNodes);
			}
			if (b.removed) {
				node.classList.add("removed");
				if (!D.gone.has(key)) D.gone.set(key, now);
			}
			if (dictated && (b.changed || b.removed)) {
				glow(node, key, now, stillMode);
				last = node;
			}
			// Removed points stay struck through for a moment where they were.
			while (cursor && cursor !== node && keepGone(cursor, now, seen)) cursor = cursor.nextSibling;
			if (cursor === node) cursor = cursor.nextSibling;
			else body.insertBefore(node, cursor);
		}
		for (const n of [...body.children]) if (!seen.has(n.dataset.id) && !keepGone(n, now, seen)) n.remove();
		if ([...D.gone.values()].some((at) => now - at < GLOW_MS)) {
			clearTimeout(D.sweep);
			D.sweep = setTimeout(() => D.shown && D.view && draw(D.view, false), GLOW_MS + 50);
		}
		// Follow the change, unless you scrolled the draft yourself just now.
		if (last && now - D.userScroll > 4000) last.scrollIntoView({ block: "nearest", behavior: stillMode ? "auto" : "smooth" });
	}

	/** A block the computer no longer lists stays (struck through) for GLOW_MS after it was removed. */
	function keepGone(node, now, seen) {
		const key = node.dataset.id;
		if (seen.has(key)) return false;
		const at = D.gone.get(key);
		if (at !== undefined && now - at < GLOW_MS) {
			node.classList.add("removed");
			return true;
		}
		return false;
	}

	/** Accent tint, fading to nothing over ~3 s (CSS); without motion, a mark in the margin instead. */
	function glow(node, key, now, stillMode) {
		if (stillMode) return node.classList.add("marked");
		// The same change reported twice (two answers raced) doesn't restart its fade.
		if (now - (D.glow.get(key)?.at ?? 0) < GLOW_MS && D.glow.get(key)?.src === node.dataset.src) return;
		D.glow.set(key, { at: now, src: node.dataset.src });
		node.classList.remove("fade");
		node.classList.add("glow");
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				node.classList.remove("glow");
				node.classList.add("fade");
			}),
		);
	}

	/** Called by the recorder's frame loop: the time against the limit once a draft shows, and the warning. */
	function tick(elapsedMs) {
		const c = V.draftClock(elapsedMs, D.maxMs, D.warnMs);
		// Long enough now, between two chunks: ask once whether it is a draft yet (the computer decides).
		if (D.id && !D.shown && !D.asked && D.ui === "forming" && D.up?.live && D.view && elapsedMs >= (D.view.draftAfterMs ?? 30_000)) {
			const d = D;
			d.asked = true;
			call("draftState", { id: d.id, since: d.version, elapsedMs }, d)
				.then((r) => D === d && d.ui === "forming" && !d.finishing && render(r))
				.catch(() => {});
		}
		if (D.shown && D.ui === "forming") noteLine(elapsedMs);
		return { ...c, shown: D.shown && D.ui === "forming" };
	}

	function canSend() {
		return D.shown && !D.recording && (D.ui === "ready" || D.ui === "text") && !!markdown().trim();
	}

	/** A change is being dictated: Send waits for it. */
	function recording(on) {
		D.recording = on;
		if (D.shown) app().updateSend();
	}

	window.PiDraft = {
		capture,
		finish,
		whole,
		change,
		send,
		canSend,
		recording,
		keepAsText,
		tick,
		/** The sheet is on screen. */
		open: () => D.shown,
		/** A recording now changes the waiting draft. */
		refining: () => D.shown && (D.ui === "ready" || D.ui === "text"),
		/** Busy finishing or applying a change: the mic waits. */
		busy: () => D.shown && (D.ui === "checking" || D.ui === "changing"),
		/** A recording feeds a draft that is on screen (✕ keeps it as text). */
		forming: () => D.shown && D.ui === "forming",
		/** Throws a recording away that never became a draft. */
		discard() {
			if (D.shown) return;
			const d = D;
			reset();
			if (d.id) call("draftClose", { id: d.id, how: "discard" }, d).catch(() => {});
		},
		setHooks: (h) => (hooks = { ...hooks, ...h }),
	};
})();
