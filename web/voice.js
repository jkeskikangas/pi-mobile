// pi mobile voice — voice input in the composer, and voice mode: a hands-free conversation with pi.
//
// Voice mode prefers a realtime speech model (WebRTC straight to OpenAI; pi on the computer sets up
// the call with your ChatGPT sign-in or API key) acting as pi's voice: it relays requests to pi and
// speaks pi's spoken briefs. Without it, the cascade: on-phone VAD → recognition on the computer →
// pi → spoken brief → the phone's speech synthesis. Both use the same earcons, local commands,
// voice answers to pi's dialogs (destructive ones must be confirmed by name), and status on demand.
"use strict";

(() => {
	const V = window.PiVoiceCore;
	const $ = (id) => document.getElementById(id);
	const app = () => window.PiMobile;
	const MODE_KEY = "pi-mobile-voice-attention";
	const TURN_KEY = "pi-mobile-voice-turns";

	// ── audio basics ────────────────────────────────────────────────────────────────────────────────
	let actx = null;
	function audioCtx() {
		actx ||= new (window.AudioContext || window.webkitAudioContext)();
		if (actx.state === "suspended") actx.resume().catch(() => {});
		return actx;
	}

	function earcon(name) {
		const steps = V.EARCONS[name];
		if (!steps) return;
		try {
			const c = audioCtx();
			let t = c.currentTime + 0.01;
			for (const [f, ms, g] of steps) {
				if (f) {
					const o = c.createOscillator();
					const gain = c.createGain();
					o.type = "sine";
					o.frequency.value = f;
					gain.gain.setValueAtTime(0, t);
					gain.gain.linearRampToValueAtTime(g, t + 0.01);
					gain.gain.linearRampToValueAtTime(0, t + ms / 1000);
					o.connect(gain).connect(c.destination);
					o.start(t);
					o.stop(t + ms / 1000 + 0.02);
				}
				t += ms / 1000;
			}
		} catch {}
	}

	function blobToBase64(blob) {
		return new Promise((resolve, reject) => {
			const r = new FileReader();
			r.onload = () => resolve(String(r.result).split(",")[1] || "");
			r.onerror = () => reject(r.error);
			r.readAsDataURL(blob);
		});
	}

	function recorderMime() {
		for (const m of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]) if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
		return "";
	}

	const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

	function micError(e) {
		if (!window.isSecureContext) return "The microphone needs this page on HTTPS (pi: /remote settings → HTTPS address) or on this computer.";
		if (e?.name === "NotAllowedError") return "Microphone access is blocked for this page. Allow it in the browser's site settings.";
		if (e?.name === "NotFoundError") return "No microphone found.";
		return `Microphone: ${e?.message || e}`;
	}

	/** 16-bit mono WAV from Float32 samples. */
	function wav(samples, rate) {
		const buf = new ArrayBuffer(44 + samples.length * 2);
		const v = new DataView(buf);
		const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
		str(0, "RIFF");
		v.setUint32(4, 36 + samples.length * 2, true);
		str(8, "WAVEfmt ");
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, rate, true);
		v.setUint32(28, rate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		str(36, "data");
		v.setUint32(40, samples.length * 2, true);
		for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
		return new Blob([buf], { type: "audio/wav" });
	}

	// ── voice input in the composer ───────────────────────────────────────────────────────────────
	// Hold the mic and talk, let go (walkie-talkie); or tap once to start and tap again to finish.
	// The computer recognises the speech and distils it into the message you meant, which lands in
	// the composer for review. "raw" shows what was heard, "undo" restores your text.
	const HOLD_MS = 350;
	const dict = { rec: null, stream: null, chunks: [], started: 0, raf: 0, last: null, busy: false, analyser: null, held: false, levels: [] };

	async function startDictation(held) {
		if (dict.busy || dict.rec) return;
		dict.held = held;
		try {
			dict.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
		} catch (e) {
			return showDictMessage(micError(e), "error");
		}
		const mime = recorderMime();
		dict.rec = new MediaRecorder(dict.stream, mime ? { mimeType: mime } : undefined);
		dict.chunks = [];
		dict.levels = [];
		dict.rec.ondataavailable = (e) => e.data.size && dict.chunks.push(e.data);
		dict.rec.start(250);
		dict.started = Date.now();
		try {
			const c = audioCtx();
			dict.analyser = c.createAnalyser();
			dict.analyser.fftSize = 512;
			c.createMediaStreamSource(dict.stream).connect(dict.analyser);
		} catch {}
		$("micBtn").classList.add("rec");
		$("micBtn").setAttribute("aria-pressed", "true");
		$("micBtn").setAttribute("aria-label", "Finish dictation");
		showRecorder();
		navigator.vibrate?.(15);
		earcon("listen");
	}

	function stopStream() {
		cancelAnimationFrame(dict.raf);
		dict.stream?.getTracks().forEach((t) => t.stop());
		dict.stream = null;
		dict.analyser = null;
		$("micBtn").classList.remove("rec");
		$("micBtn").setAttribute("aria-pressed", "false");
		$("micBtn").setAttribute("aria-label", "Dictate: hold to talk, or tap to start and stop");
	}

	async function finishDictation(keep) {
		const rec = dict.rec;
		dict.rec = null;
		if (!rec) return;
		const stopped = new Promise((r) => (rec.onstop = r));
		rec.stop();
		await stopped;
		stopStream();
		if (!keep) return hideDictBar();
		navigator.vibrate?.(10);
		const blob = new Blob(dict.chunks, { type: rec.mimeType || "audio/webm" });
		if (Date.now() - dict.started < 600 || blob.size < 1500) return showDictMessage(dict.held ? "Hold the mic while you talk, or tap once to start." : "Too short. Tap the mic, talk, then tap again.");
		const input = app().input();
		const before = input.value;
		dict.busy = true;
		showDictMessage("Understanding what you meant…", "busy");
		try {
			const r = await app().call("transcribe", { audio: await blobToBase64(blob), mime: blob.type, draft: before });
			if (!r.raw?.trim()) return showDictMessage("Didn't catch anything. Try again a little closer to the mic.");
			input.value = r.editor || r.text;
			app().autosize();
			input.focus({ preventScroll: true });
			dict.last = { raw: r.raw, text: input.value, before };
			const bar = showDictMessage(r.by === "model" ? "Distilled from your speech — check it, then send." : "Cleaned up locally (no model reachable).", "done");
			const label = bar.querySelector(".grow");
			const distilledLabel = label.textContent;
			dictChip(bar, "raw", "Show what you said word for word", (b) => {
				const showRaw = input.value !== dict.last.raw;
				input.value = showRaw ? dict.last.raw : dict.last.text;
				b.textContent = showRaw ? "distilled" : "raw";
				label.textContent = showRaw ? "What you said, word for word." : distilledLabel;
				app().autosize();
			});
			dictChip(bar, "undo", "Put back what you had typed", () => {
				input.value = dict.last.before;
				app().autosize();
				hideDictBar();
			});
			clearTimeout(dict.hideTimer);
			dict.hideTimer = setTimeout(() => bar.dataset.kind === "done" && hideDictBar(), 20000);
		} catch (e) {
			showDictMessage(`Voice input failed: ${e.message}`, "error");
		} finally {
			dict.busy = false;
		}
	}

	function dictChip(bar, label, title, fn) {
		const b = document.createElement("button");
		b.className = "chip";
		b.textContent = label;
		b.title = title;
		b.onclick = () => fn(b);
		bar.appendChild(b);
		return b;
	}

	function hideDictBar() {
		const bar = $("dictBar");
		bar.replaceChildren();
		bar.hidden = true;
		delete bar.dataset.kind;
	}

	function showDictMessage(text, kind = "info") {
		const bar = $("dictBar");
		bar.replaceChildren(Object.assign(document.createElement("span"), { className: "grow", textContent: text }));
		bar.dataset.kind = kind;
		bar.hidden = false;
		if (kind === "info" || kind === "error") {
			clearTimeout(dict.hideTimer);
			dict.hideTimer = setTimeout(() => bar.dataset.kind === kind && hideDictBar(), 6000);
		}
		return bar;
	}

	/** The recording strip: live waveform, timer, cancel and done. Built once, animated per frame. */
	function showRecorder() {
		const bar = $("dictBar");
		bar.dataset.kind = "rec";
		bar.hidden = false;
		const cancel = Object.assign(document.createElement("button"), { className: "rec-x", title: "Cancel", innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' });
		cancel.setAttribute("aria-label", "Cancel dictation");
		cancel.onclick = () => finishDictation(false);
		const wave = Object.assign(document.createElement("canvas"), { className: "wave" });
		wave.setAttribute("aria-hidden", "true");
		const time = Object.assign(document.createElement("span"), { className: "rec-time", textContent: "0:00" });
		const hint = Object.assign(document.createElement("span"), { className: "rec-hint", textContent: dict.held ? "Release to finish" : "Tap ✓ when done" });
		const done = Object.assign(document.createElement("button"), { className: "rec-done", title: "Done", innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' });
		done.setAttribute("aria-label", "Finish dictation");
		done.onclick = () => finishDictation(true);
		bar.replaceChildren(cancel, wave, time, hint, done);
		const draw = () => {
			if (!dict.rec) return;
			const secs = Math.floor((Date.now() - dict.started) / 1000);
			time.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
			if (secs >= 300) return void finishDictation(true);
			dict.levels.push(rmsOf(dict.analyser));
			drawWave(wave, dict.levels);
			dict.raf = requestAnimationFrame(draw);
		};
		dict.raf = requestAnimationFrame(draw);
	}

	function rmsOf(analyser) {
		if (!analyser) return 0;
		const a = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(a);
		let s = 0;
		for (const x of a) s += x * x;
		return Math.sqrt(s / a.length);
	}

	/** Scrolling level bars, newest on the right. */
	function drawWave(canvas, levels) {
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (!w || !h) return;
		if (canvas.width !== Math.round(w * dpr)) {
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
		}
		const g = canvas.getContext("2d");
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, w, h);
		g.fillStyle = getComputedStyle(canvas).color;
		const step = 4;
		const n = Math.floor(w / step);
		const start = Math.max(0, levels.length - n);
		for (let i = start; i < levels.length; i++) {
			const v = Math.min(1, Math.sqrt(levels[i]) * 2.2);
			const bh = Math.max(2, v * h);
			const x = w - (levels.length - i) * step;
			g.globalAlpha = 0.35 + 0.65 * v;
			g.beginPath();
			g.roundRect?.(x, (h - bh) / 2, 2, bh, 1) ?? g.rect(x, (h - bh) / 2, 2, bh);
			g.fill();
		}
		g.globalAlpha = 1;
	}

	/** When a distilled dictation is sent, what you changed in it teaches the computer for next time. */
	function wireLearning() {
		const learn = () => {
			const sent = app().input().value;
			const last = dict.last;
			if (!last || last.learned || !sent.trim() || sent === last.text || sent === last.raw) return;
			last.learned = true;
			app().call("learn", { distilled: last.text, sent }).catch(() => {});
		};
		$("sendBtn").addEventListener("click", learn, true);
		app().input().addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && learn(), true);
	}

	/** Pointer: hold = walkie-talkie, quick tap = toggle. Keyboard: Enter/Space toggles. */
	function wireMic() {
		const btn = $("micBtn");
		let downAt = 0;
		btn.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			btn.setPointerCapture?.(e.pointerId);
			downAt = Date.now();
			if (dict.rec) {
				downAt = 0;
				return void finishDictation(true);
			}
			startDictation(true);
		});
		const up = () => {
			if (!downAt) return;
			const held = Date.now() - downAt >= HOLD_MS;
			downAt = 0;
			if (held && dict.rec) finishDictation(true);
			else if (dict.rec) {
				// A quick tap: keep recording until the next tap.
				dict.held = false;
				const hint = document.querySelector("#dictBar .rec-hint");
				if (hint) hint.textContent = "Tap ✓ or the mic when done";
			} else dict.held = false;
		};
		btn.addEventListener("pointerup", up);
		btn.addEventListener("pointercancel", up);
		btn.addEventListener("contextmenu", (e) => e.preventDefault());
		btn.addEventListener("click", (e) => {
			if (e.detail !== 0) return; // pointer handled above; keyboard activation has detail 0
			if (dict.rec) finishDictation(true);
			else startDictation(false);
		});
	}

	// ── voice mode ─────────────────────────────────────────────────────────────────────────────────────
	const LABEL = {
		connecting: "Connecting…",
		listening: "Listening",
		hearing: "Listening…",
		thinking: "Got it",
		working: "pi is on it",
		speaking: "",
		asking: "pi needs you",
		paused: "Mic off",
		offline: "Reconnecting…",
	};
	const INTRO_KEY = "pi-mobile-voice-intro";
	const GRACE_MS = 4000;
	/** Voiced speech over pi that takes the turn. Hume's default is 800 ms; pi ducks at once meanwhile. */
	const BARGE_MS = 800;
	/** Turns shorter than this (server-measured, including its end-of-speech wait) wait for their words. */
	const SHORT_TURN_MS = 1300;
	const USES_KEY = "pi-mobile-voice-uses";
	const TRY = ["Try “what's it doing?”", "Try “stop” — it works any time", "Try “tell me more”", "Try “switch to another session”", "Try “say that again”"];
	const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

	/**
	 * The orb: a soft, audio-reactive blob. It swells with your voice while listening, with pi's while
	 * speaking, breathes slowly while pi works, and takes the state's colours from the CSS.
	 */
	class Orb {
		constructor(canvas, owner) {
			this.canvas = canvas;
			this.owner = owner;
			this.level = 0;
			this.colors = [
				[91, 147, 245],
				[34, 211, 238],
			];
			this.target = this.colors;
			this.raf = 0;
			this.t0 = performance.now();
		}
		start() {
			const frame = (now) => {
				this.raf = requestAnimationFrame(frame);
				if (document.visibilityState !== "visible") return;
				this.draw(now);
			};
			this.raf = requestAnimationFrame(frame);
		}
		stop() {
			cancelAnimationFrame(this.raf);
		}
		retint() {
			const cs = getComputedStyle($("voice"));
			const rgb = (v) => {
				const m = /#([0-9a-f]{6})/i.exec(v);
				return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [128, 128, 128];
			};
			this.target = [rgb(cs.getPropertyValue("--c1")), rgb(cs.getPropertyValue("--c2"))];
		}
		draw(now) {
			const c = this.canvas;
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const w = c.clientWidth;
			const h = c.clientHeight;
			if (!w || !h) return;
			if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
				c.width = Math.round(w * dpr);
				c.height = Math.round(h * dpr);
			}
			const g = c.getContext("2d");
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, w, h);
			const t = (now - this.t0) / 1000;
			const still = reducedMotion();
			const state = this.owner.state;
			const raw = this.owner.level(state);
			this.level += (raw - this.level) * (raw > this.level ? 0.35 : 0.08);
			for (let k = 0; k < 2; k++) this.colors[k] = this.colors[k].map((v, i) => v + (this.target[k][i] - v) * 0.06);
			const [a, b] = this.colors.map(([r, gg, bb]) => `${r | 0},${gg | 0},${bb | 0}`);
			const breathe = still ? 0 : state === "working" ? 0.06 * Math.sin(t * 2.2) : state === "thinking" ? 0.04 * Math.sin(t * 6) : 0.025 * Math.sin(t * 1.3);
			const dim = state === "paused" || state === "connecting" || state === "offline";
			const cx = w / 2;
			const cy = h * 0.42;
			const r0 = Math.min(w, h) * 0.24;
			const r = r0 * (1 + breathe + this.level * (still ? 0.15 : 0.5));
			// Glow.
			const glow = g.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.1);
			glow.addColorStop(0, `rgba(${a},${dim ? 0.12 : 0.32})`);
			glow.addColorStop(1, `rgba(${a},0)`);
			g.fillStyle = glow;
			g.fillRect(0, 0, w, h);
			// Body: a gently wobbling blob, more alive the louder the voice.
			const wobble = still ? 0 : 0.035 + this.level * 0.12;
			g.beginPath();
			const N = 72;
			for (let i = 0; i <= N; i++) {
				const ang = (i / N) * Math.PI * 2;
				const n = Math.sin(ang * 3 + t * 1.7) * 0.5 + Math.sin(ang * 5 - t * 2.3) * 0.3 + Math.sin(ang * 2 + t * 0.9) * 0.2;
				const rr = r * (1 + wobble * n);
				const x = cx + Math.cos(ang) * rr;
				const y = cy + Math.sin(ang) * rr;
				if (i) g.lineTo(x, y);
				else g.moveTo(x, y);
			}
			const rot = still ? 0 : t * 0.4;
			const body = g.createLinearGradient(cx + Math.cos(rot) * r, cy + Math.sin(rot) * r, cx - Math.cos(rot) * r, cy - Math.sin(rot) * r);
			body.addColorStop(0, `rgba(${a},${dim ? 0.35 : 0.95})`);
			body.addColorStop(1, `rgba(${b},${dim ? 0.3 : 0.9})`);
			g.fillStyle = body;
			g.fill();
			// Highlight for depth.
			const hl = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, 0, cx - r * 0.35, cy - r * 0.4, r * 0.9);
			hl.addColorStop(0, `rgba(255,255,255,${dim ? 0.08 : 0.28})`);
			hl.addColorStop(1, "rgba(255,255,255,0)");
			g.fillStyle = hl;
			g.fill();
			// Waiting on you: a slow ring.
			if (state === "asking" && !still) {
				const p = (t % 1.6) / 1.6;
				g.beginPath();
				g.arc(cx, cy, r * (1.1 + p * 0.6), 0, Math.PI * 2);
				g.strokeStyle = `rgba(${a},${0.5 * (1 - p)})`;
				g.lineWidth = 3;
				g.stroke();
			}
		}
	}

	function analyserFor(stream) {
		try {
			const c = audioCtx();
			const an = c.createAnalyser();
			an.fftSize = 512;
			c.createMediaStreamSource(stream).connect(an);
			return an;
		} catch {
			return null;
		}
	}

	class VoiceMode {
		constructor() {
			this.attention = localStorage.getItem(MODE_KEY) === "glance" ? "glance" : "eyes-busy";
			this.turns = localStorage.getItem(TURN_KEY) === "tap" ? "tap" : "open";
			this.state = "connecting";
			this.engine = null; // "realtime" | "cascade"
			this.agent = app().S.current;
			this.statusOf = new Map();
			this.lastSpoken = "";
			this.more = [];
			this.pendingConfirm = null;
			this.optionPage = 0;
			this.closed = false;
			this.timers = [];
			this.workingSince = 0;
			this.lastTick = 0;
			this.significant = new Map();
			this.muted = false;
			this.talking = false; // tap-to-talk: currently holding the floor
			this.micAn = null;
			this.outAn = null;
			this.saidLive = "";
			this.heardLive = "";
			this.uses = Number(localStorage.getItem(USES_KEY) || 0);
			this.orb = new Orb($("vCanvas"), this);
		}

		/** 0..1 for the orb: your voice while listening, pi's while speaking. */
		level(state) {
			if (state === "hearing" || state === "listening") return Math.min(1, rmsOf(this.micAn) * 6);
			if (state === "speaking") {
				if (this.outAn) return Math.min(1, rmsOf(this.outAn) * 5);
				// The phone's own synthesis can't be measured; a gentle speech-like motion instead.
				const t = performance.now() / 1000;
				return 0.25 + 0.2 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.9));
			}
			return 0;
		}

		// ── lifecycle ──
		async open() {
			$("voice").hidden = false;
			document.body.classList.add("voice-on");
			this.render();
			this.orb.start();
			this.renderAsk();
			audioCtx();
			this.unlockSpeech();
			try {
				this.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
			} catch (e) {
				this.note(`${micError(e)} Tap the circle to try again.`);
				return this.setState("paused");
			}
			this.micAn = analyserFor(this.stream);
			const track = this.stream.getAudioTracks()[0];
			track.onmute = () => this.note("The phone paused the microphone. Keep pi mobile on screen; on iPhone the mic stops when the screen locks.");
			track.onunmute = () => this.note("");
			track.onended = () => this.note("The microphone stopped. Tap the circle to restart.");
			this.keepAwake();
			this.mediaSession();
			for (const a of app().S.agents.values()) this.statusOf.set(a.agent, a.status);
			this.heartbeat(true);
			this.timers.push(setInterval(() => this.heartbeat(true), 60_000));
			this.timers.push(setInterval(() => this.tick(), 1000));
			let realtimeError = "";
			try {
				await this.startRealtime();
			} catch (e) {
				realtimeError = e.message;
				this.stopRealtime();
				await this.startCascade();
			}
			this.render();
			if (realtimeError) this.note(`Basic voice (${/unavailable/.test(realtimeError) ? realtimeError.replace(/^.*unavailable:\s*/, "") : realtimeError}).`);
			earcon("listen");
			localStorage.setItem(USES_KEY, String(++this.uses));
			if (!localStorage.getItem(INTRO_KEY)) {
				localStorage.setItem(INTRO_KEY, "1");
				this.tell(
					"I'm listening. Just talk to pi, and say stop any time.",
					"[PI] This is the developer's first time in voice mode. In one short sentence, say you're listening, they can just talk, and \"stop\" works any time.",
				);
			}
		}

		async restart() {
			for (const t of this.timers) clearInterval(t);
			this.timers = [];
			this.orb.stop();
			this.stream?.getTracks().forEach((t) => t.stop());
			this.note("");
			this.setState("connecting");
			await this.open();
		}

		close() {
			if (this.closed) return;
			this.closed = true;
			this.dropGrace(); // pi's question stays open in the app and the terminal
			earcon("off");
			this.heartbeat(false);
			for (const t of this.timers) clearInterval(t);
			this.orb.stop();
			this.stopRealtime();
			this.stopCascade();
			this.silence();
			this.stream?.getTracks().forEach((t) => t.stop());
			this.wake?.release?.().catch(() => {});
			this.keep?.pause();
			try {
				if (navigator.audioSession) navigator.audioSession.type = "auto";
			} catch {}
			if (navigator.mediaSession) for (const a of ["play", "pause", "togglemicrophone"]) try { navigator.mediaSession.setActionHandler(a, null); } catch {}
			document.removeEventListener("visibilitychange", this.onVisible);
			$("voice").hidden = true;
			document.body.classList.remove("voice-on");
		}

		heartbeat(on) {
			const agent = this.agent;
			if (agent) app().call("voiceState", { on, mode: this.attention }, agent).catch(() => {});
		}

		keepAwake() {
			const get = () => navigator.wakeLock?.request("screen").then((w) => (this.wake = w)).catch(() => {});
			get();
			if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
			this.onVisible = () => {
				if (document.visibilityState === "visible" && !this.closed) get();
			};
			document.addEventListener("visibilitychange", this.onVisible);
		}

		/** Headset / lock-screen play-pause acts like tapping the circle; needs an audio element as the active media session. */
		mediaSession() {
			if (!navigator.mediaSession) return;
			try {
				this.keep = new Audio(URL.createObjectURL(wav(new Float32Array(16000), 16000)));
				this.keep.loop = true;
				this.keep.volume = 0.01;
				this.keep.play().catch(() => {});
				navigator.mediaSession.metadata = new MediaMetadata({ title: "pi voice", artist: app().agentName(this.agent) });
				const toggle = () => this.tap();
				for (const a of ["play", "pause"]) {
					try {
						navigator.mediaSession.setActionHandler(a, toggle);
					} catch {}
				}
				// AirPods stem / headset mute button; WebKit reports speech while muted as "voiceactivity".
				try {
					navigator.mediaSession.setActionHandler("togglemicrophone", () => this.setMuted(!this.muted));
				} catch {}
				try {
					navigator.mediaSession.setActionHandler("voiceactivity", () => {
						if (!this.muted) return;
						earcon("off");
						this.note("You're muted. Press your headset or tap the mic to talk.");
					});
				} catch {}
			} catch {}
			// iOS: a voice session (record and play) rather than media playback that ducks and pauses.
			try {
				if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
			} catch {}
		}

		// ── UI ──
		setState(s) {
			if (s !== this.state && (s === "asking" || s === "speaking")) navigator.vibrate?.(s === "asking" ? [30, 60, 30] : 10);
			this.state = s;
			this.render();
		}

		render() {
			const root = $("voice");
			root.dataset.state = this.state;
			this.orb.retint();
			const info = app().S.agents.get(this.agent);
			let label = LABEL[this.state] ?? this.state;
			if (this.state === "paused") label = this.muted ? "Mic off" : this.turns === "tap" ? "Tap to talk" : "Paused";
			$("vState").textContent = label;
			$("vHint").textContent = this.hint();
			$("vOrb").setAttribute("aria-label", this.stageAction());
			$("vSessionName").textContent = app().agentName(this.agent);
			// The same status line as the app's header: one truth about the session.
			const line = info ? app().statusLine(info) : { text: "", cls: "" };
			$("vSub").textContent = line.text;
			$("vSub").className = `session-sub ${line.cls}`;
			$("vDot").className = `dot ${line.cls === "waiting" ? "waiting" : info?.status || "gone"}`;
			$("vSession").setAttribute("aria-label", `${app().agentName(this.agent)}${line.text ? `: ${line.text}` : ""}. Switch session`);
			$("vEngine").textContent = this.engine === "cascade" ? "basic" : "";
			$("vEyesFree").setAttribute("aria-pressed", String(this.attention === "eyes-busy"));
			$("vGlance").setAttribute("aria-pressed", String(this.attention === "glance"));
			$("vOpen").setAttribute("aria-pressed", String(this.turns === "open"));
			$("vTap").setAttribute("aria-pressed", String(this.turns === "tap"));
			$("vMute").setAttribute("aria-pressed", String(this.muted));
			$("vMute").setAttribute("aria-label", this.muted ? "Unmute microphone" : "Mute microphone");
		}

		/** One line under the state: what you can do now. Example commands fade out once you know them. */
		hint() {
			switch (this.state) {
				case "listening":
					if (this.uses > 6) return "";
					return this.uses <= 1 ? "Just talk — say “stop” any time" : TRY[Math.floor(Date.now() / 8000) % TRY.length];
				case "working": {
					const s = this.workingSince ? Math.floor((Date.now() - this.workingSince) / 1000) : 0;
					return `${s >= 60 ? `${Math.floor(s / 60)} min ` : ""}${s % 60}s · ask “what's it doing?” any time`;
				}
				case "speaking":
					return "Talk or tap to interrupt";
				case "asking":
					return "Answer out loud, or tap below";
				case "paused":
					return this.muted ? "Tap to unmute" : this.turns === "tap" ? "Tap anywhere here, talk, tap again" : "Tap to resume";
				case "hearing":
					return this.turns === "tap" ? "Tap when you're done" : "";
				default:
					return "";
			}
		}

		stageAction() {
			if (!this.engine) return "Retry the microphone";
			if (this.state === "speaking") return "Interrupt";
			if (this.muted) return "Unmute";
			if (this.turns === "tap") return this.talking ? "Done talking" : "Talk";
			return "Listening";
		}

		note(text) {
			$("vNote").textContent = text || "";
		}

		heard(text, live = false) {
			const el = $("vHeard");
			el.textContent = text || "";
			el.classList.toggle("live", live);
		}

		said(text, live = false) {
			const el = $("vSaid");
			el.textContent = text || "";
			el.classList.toggle("live", live);
		}

		/** pi's open question as a card: answer by voice, or with a tap when you can glance. */
		renderAsk() {
			const box = $("vAsk");
			const p = [...(app().S.prompts.get(this.agent)?.values() || [])][0];
			if (!p) {
				box.hidden = true;
				box.replaceChildren();
				return;
			}
			const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
			const eyebrow = (text) => {
				const e = el("div", "eyebrow", "");
				e.append(app().icon("alert"), text);
				return e;
			};
			if (this.grace?.prompt.id === p.id) {
				const left = Math.max(0, this.grace.until - Date.now());
				let bar = box.querySelector(".grace-bar > span");
				if (box.dataset.grace !== p.id) {
					box.dataset.grace = p.id;
					const acts = el("div", "pact");
					const cancel = el("button", "primary", "Cancel");
					cancel.onclick = () => this.cancelGrace();
					const now = el("button", "", "Do it now");
					now.onclick = () => this.finishGrace(true);
					acts.append(cancel, now);
					const track = el("div", "grace-bar");
					bar = el("span");
					track.appendChild(bar);
					box.replaceChildren(eyebrow("Going ahead"), el("div", "ptitle", `${p.title.replace(/\?\s*$/, "")}`), el("p", "grace-left", ""), track, acts);
				}
				box.querySelector(".grace-left").textContent = `Going ahead in ${Math.ceil(left / 1000)} s, as you asked. Say “stop” or tap Cancel.`;
				bar.style.width = `${(left / GRACE_MS) * 100}%`;
				box.hidden = false;
				return;
			}
			delete box.dataset.grace;
			const acts = el("div", "pact");
			const answer = async (value, label) => {
				acts.querySelectorAll("button").forEach((b) => (b.disabled = true));
				try {
					await app().call("answer", { id: p.id, value }, this.agent);
					if (this.engine === "realtime") this.inject(`[PI] The developer answered on screen: ${label}. Do not ask again.`, false);
					this.silence();
					if (this.engine === "realtime") this.rt({ type: "response.cancel" });
					earcon("heard");
				} catch (e) {
					this.note(e.message);
					acts.querySelectorAll("button").forEach((b) => (b.disabled = false));
				}
			};
			const button = (label, cls, value) => {
				const b = el("button", cls, label);
				b.onclick = () => answer(value, label);
				acts.appendChild(b);
			};
			if (p.kind === "confirm") {
				const destructive = V.isDestructive(p);
				button(destructive ? "Yes, do it" : "Yes", destructive ? "danger" : "primary", true);
				button("No", "", false);
			} else if (p.kind === "select") {
				acts.classList.add("col");
				for (const o of (p.options || []).slice(0, 6)) button(o, V.isDestructive({ title: o }) ? "danger" : "", o);
				button("Cancel", "ghost", undefined);
			}
			box.replaceChildren(
				eyebrow("pi asks"),
				el("div", "ptitle", p.title),
				...(p.message ? [el("div", "pmsg", p.message)] : []),
				...(acts.children.length ? [acts] : [el("p", "grace-left", "Say your answer.")]),
			);
			box.hidden = false;
		}

		/**
		 * The stage: interrupt pi speaking; otherwise unmute, or (tap to talk) take and give back the
		 * floor. In open mic, a tap while listening just confirms with a sound that you're heard.
		 */
		tap() {
			navigator.vibrate?.(15);
			if (!this.engine) {
				if (this.state !== "connecting") this.restart();
				return;
			}
			if (this.state === "speaking") return this.interrupt();
			if (this.muted) return this.setMuted(false);
			if (this.turns === "tap") {
				if (this.engine === "realtime") {
					const t = this.stream?.getAudioTracks()[0];
					if (!t) return;
					this.talking = !this.talking;
					t.enabled = this.talking;
					if (this.talking && this.state === "speaking") this.hardInterrupt();
					if (!this.talking) {
						this.rt({ type: "input_audio_buffer.commit" });
						this.shortTurn = false;
						this.respond();
					}
					earcon(this.talking ? "listen" : "heard");
					return this.setState(this.talking ? "hearing" : "thinking");
				}
				return this.manualTurn();
			}
			if (this.engine === "cascade" && this.state === "paused") return this.setState("listening");
			earcon("listen");
		}

		setMuted(m) {
			this.muted = m;
			if (m) this.clientTurns(false);
			try {
				navigator.mediaSession?.setMicrophoneActive?.(!m);
			} catch {}
			if (!m) this.note("");
			const t = this.stream?.getAudioTracks()[0];
			if (this.engine === "realtime" && t) t.enabled = !m && (this.turns === "open" || this.talking);
			if (m) this.capture = null;
			earcon(m ? "off" : "listen");
			this.setState(m ? "paused" : this.listenState());
		}

		setAttention(a) {
			if (a === this.attention) return;
			this.attention = a;
			localStorage.setItem(MODE_KEY, this.attention);
			this.heartbeat(true);
			if (this.engine === "realtime")
				this.inject(
					this.attention === "glance"
						? "[PI] The developer can now glance at the screen. You may be a little more detailed; still no code read aloud."
						: "[PI] The developer cannot look at the screen any more (driving, running or similar). Keep it very short; defer anything visual.",
					false,
				);
			this.render();
		}

		setTurns(turns) {
			if (turns === this.turns) return;
			this.turns = turns;
			this.talking = false;
			if (turns === "tap") this.clientTurns(false);
			localStorage.setItem(TURN_KEY, this.turns);
			const t = this.stream?.getAudioTracks()[0];
			if (this.engine === "realtime" && t) t.enabled = !this.muted && this.turns === "open";
			this.setState(this.muted ? "paused" : this.listenState());
		}

		// ── pi events ──
		onEvent(ev) {
			if (this.closed) return;
			const current = app().S.current;
			if (current !== this.agent) this.follow(current);
			if (ev.type === "info") {
				const prev = this.statusOf.get(ev.agent);
				this.statusOf.set(ev.agent, ev.info.status);
				if (ev.agent !== this.agent) return;
				if (ev.info.status === "working" && prev !== "working") this.workingSince = Date.now();
				if (ev.info.status === "idle" && prev && prev !== "idle") this.settled();
				if (ev.info.status !== "idle" && this.state === "listening" && ev.info.status === "working") this.render();
				return;
			}
			if (ev.type === "prompt") {
				earcon("attention");
				if (ev.agent === this.agent) return this.ask(ev.prompt);
				const name = app().agentName(ev.agent);
				return this.tell(`${name} needs you: ${ev.prompt.title}. Say "switch to ${name}" to answer it.`, `[PI] Another session, "${name}", asks: ${ev.prompt.title}. Tell the developer briefly; they can say "switch to ${name}".`);
			}
			if (ev.type === "prompt_end" && ev.agent === this.agent) {
				if (this.pendingConfirm?.prompt.id === ev.id) this.pendingConfirm = null;
				if (this.grace?.prompt.id === ev.id) this.dropGrace();
				if (ev.by === "terminal" && this.engine === "realtime") this.inject("[PI] That question was answered in the terminal.", false);
				this.renderAsk();
				if (this.state === "asking") this.setState(this.listenState());
				return;
			}
			if (ev.type === "gone" && ev.agent === this.agent) this.tell("That session stopped.", "[PI] The session the developer was following stopped.");
			// Tool calls are pi's business, except significant ones: the voice knows when one runs, and
			// the developer hears about it when one fails.
			if (ev.agent !== this.agent) return;
			if (ev.type === "tool_start" && V.isSignificant(ev.title)) {
				this.significant.set(ev.id, ev.title);
				if (this.engine === "realtime") this.inject(`[PI] pi is running a significant action: ${ev.title}`, false);
			}
			if (ev.type === "tool_end" && this.significant.has(ev.id)) {
				const title = this.significant.get(ev.id);
				this.significant.delete(ev.id);
				if (ev.isError) {
					earcon("failed");
					this.tell("Heads-up: a significant action pi ran just failed.", `[PI] A significant action FAILED: ${title}. Tell the developer in one sentence what kind of action failed (no command text); pi is still working.`);
				}
			}
		}

		follow(agent) {
			if (this.agent) app().call("voiceState", { on: false }, this.agent).catch(() => {});
			this.agent = agent;
			this.heartbeat(true);
			this.render();
			if (this.engine === "realtime") this.inject(`[PI] Now following the session "${app().agentName(agent)}". ${this.statusLine()}`, false);
		}

		statusLine() {
			const info = app().S.agents.get(this.agent);
			return info ? `Status: ${info.status}.${info.task ? ` Its task: ${info.task}.` : ""}${info.last ? ` Its latest reply begins: ${info.last}` : ""}` : "";
		}

		/** Soft working tick every few seconds while pi works and nobody talks: "still on it", eyes-free. */
		tick() {
			// The session can also change from the session list.
			if (app().S.current && app().S.current !== this.agent) this.follow(app().S.current);
			const info = app().S.agents.get(this.agent);
			if (info?.status !== "working") {
				if (this.state === "working") this.setState(this.listenState());
				else if (this.state === "listening") $("vHint").textContent = this.hint();
				return;
			}
			if (this.state === "listening" || (this.state === "paused" && !this.muted)) this.setState("working");
			if (this.state === "working") {
				$("vHint").textContent = this.hint();
				if (Date.now() - this.lastTick > 6000) {
					this.lastTick = Date.now();
					earcon("working");
				}
			}
		}

		listenState() {
			if (this.muted) return "paused";
			if (this.turns === "tap") return this.talking ? "hearing" : "paused";
			return "listening";
		}

		async settled() {
			let b;
			try {
				b = await app().call("brief", { mode: this.attention }, this.agent);
			} catch (e) {
				return this.tell("pi finished, but I couldn't get the summary.", `[PI] pi finished but the summary failed: ${e.message}`);
			}
			const failed = /SIGNIFICANT ACTION FAILED|^ERROR:/m.test(b.report || "");
			earcon(failed ? "failed" : "done");
			this.more = b.more || [];
			const offer = this.more.length && this.engine === "cascade" ? ` Want ${this.more[0]}?` : "";
			this.tell(
				b.speech + offer,
				`[PI] pi finished.\nSPOKEN BRIEF: ${b.speech}\n${this.more.length ? `MORE AVAILABLE: ${this.more.join("; ")} (offer at most one, briefly)\n` : ""}REPORT (for follow-up questions, do not read out):\n${b.report}`,
			);
		}

		/** What the developer said lately (both engines), to check an earlier request really named an action. */
		rememberHeard(text, echo = false) {
			if (!text) return;
			const now = Date.now();
			this.lastHeardEcho = echo;
			this.recentHeard = [...(this.recentHeard || []).filter((h) => now - h.at < 180_000), { text, at: now, echo }].slice(-12);
		}

		/** The claim that an earlier request named this action must hold for something actually heard. */
		namedEarlier(prompt, claimed) {
			if (!V.isDestructive(prompt)) return false;
			const heard = (this.recentHeard || []).filter((h) => !h.echo).map((h) => h.text);
			return (!claimed || V.requestNames(prompt, claimed)) && heard.some((t) => V.requestNames(prompt, t));
		}

		cancelsGrace(text) {
			const cmd = V.parseCommand(text)?.kind;
			return cmd === "stop" || cmd === "quiet" || /^(no|nope|cancel|wait|hold on|don't|do not|abort)\b/.test(V.norm(text));
		}

		/**
		 * The undo window: you asked for this irreversible action by name, pi asks to confirm it, and
		 * instead of asking you a second time it goes ahead after a few seconds unless you say stop or
		 * tap cancel.
		 */
		startGrace(prompt) {
			this.cancelGrace(true);
			const until = Date.now() + GRACE_MS;
			this.grace = {
				prompt,
				until,
				timer: setTimeout(() => this.finishGrace(true), GRACE_MS),
				tick: setInterval(() => this.renderAsk(), 200),
			};
			earcon("attention");
			this.renderAsk();
		}

		/** Forgets the undo window without answering (answered elsewhere, or voice mode ended). */
		dropGrace() {
			if (!this.grace) return;
			clearTimeout(this.grace.timer);
			clearInterval(this.grace.tick);
			this.grace = null;
		}

		async finishGrace(value) {
			const g = this.grace;
			if (!g) return;
			clearTimeout(g.timer);
			clearInterval(g.tick);
			this.grace = null;
			try {
				await app().call("answer", { id: g.prompt.id, value }, this.agent);
				earcon(value ? "heard" : "off");
			} catch (e) {
				this.note(e.message);
			}
			this.renderAsk();
		}

		/** Cancels the undo window: pi's question is answered no. `quiet` skips the spoken confirmation. */
		cancelGrace(quiet = false) {
			if (!this.grace) return;
			const title = this.grace.prompt.title;
			this.finishGrace(false);
			if (quiet) return;
			this.silence();
			this.tell("Cancelled.", `[PI] The developer cancelled: ${title}. Say "Cancelled" and nothing else.`);
		}

		ask(prompt) {
			this.optionPage = 0;
			this.renderAsk();
			// You just asked for exactly this by name: go ahead with an undo window instead of asking again.
			// Decided here, from what the phone heard you say, not left to the voice model.
			if (this.namedEarlier(prompt)) {
				this.startGrace(prompt);
				const what = prompt.title.replace(/\?\s*$/, "");
				return this.tell(
					`${what}: going ahead in a few seconds. Say stop to cancel.`,
					`[PI] pi asks to confirm "${prompt.title}". The developer already asked for exactly this, so the phone confirms it in ${GRACE_MS / 1000} seconds unless they say stop. Say only, in a few words: "${what}, say stop to cancel." Do not call answer_question.`,
				);
			}
			const destructive = V.isDestructive(prompt);
			const opts = prompt.options?.length ? `\nOptions: ${prompt.options.map((o, i) => `${i + 1}. ${o}`).join("; ")}` : "";
			this.tell(
				V.speakPrompt(prompt),
				`[PI] QUESTION (id ${prompt.id}, ${prompt.kind}${destructive ? ", DESTRUCTIVE: needs explicit confirmation naming the action" : ""}): ${prompt.title}${prompt.message ? ` — ${prompt.message}` : ""}${opts}`,
				"asking",
			);
		}

		/** Speaks to the developer: the realtime voice gets context to say it in its own voice; the cascade speaks `speech`. */
		tell(speech, context, state) {
			if (state) this.setState(state);
			if (this.engine === "realtime") return this.inject(context, true);
			if (this.engine === "cascade") this.speak(speech);
		}

		interrupt() {
			if (this.engine === "realtime") {
				this.rt({ type: "response.cancel" });
				this.rt({ type: "output_audio_buffer.clear" });
			} else this.silence();
			this.setState(this.listenState());
		}

		// ── tools: what the voice can do with pi (realtime tool calls, and the cascade's own intents) ──
		async tool(name, args) {
			const a = app();
			switch (name) {
				case "ask_pi": {
					const text = String(args.request || "").trim();
					if (!text) return { error: "empty request" };
					const r = await a.call("send", { text, mode: args.when === "after" ? "followUp" : "steer" }, this.agent);
					this.workingSince ||= Date.now();
					return { delivered: r.delivered, note: r.delivered === "prompt" ? "pi started working on it" : r.delivered === "steer" ? "pi is busy; the request steers its current work" : "queued until pi finishes" };
				}
				case "answer_question": {
					const prompts = [...(a.S.prompts.get(this.agent)?.values() || [])];
					const p = prompts.find((x) => x.id === args.id) || prompts[0];
					if (!p) return { error: "pi is not waiting on a question" };
					if (this.lastHeardEcho && V.isDestructive(p))
						return { error: "Not answered: the microphone picked up your own voice, not the developer. Ask them, naming the action." };
					const r = V.answerFor(p, String(args.answer ?? ""));
					if (r.needConfirm && r.value === undefined && this.namedEarlier(p, args.earlier_request)) {
						this.startGrace(p);
						return { pending: `Confirming in ${GRACE_MS / 1000} seconds unless the developer says stop. Tell them in a few words that it is going ahead and that stop cancels.` };
					}
					if (r.needConfirm) return { error: `Not answered: this is an irreversible action. Ask the developer to confirm by saying "yes, ${r.needConfirm}".` };
					if (r.unclear) return { error: "Not answered: the answer does not fit the question. Ask again briefly." };
					await a.call("answer", { id: p.id, value: r.value }, this.agent);
					return { answered: r.value === undefined ? "cancelled" : r.value };
				}
				case "stop_pi":
					await a.call("abort", {}, this.agent);
					return { stopped: true };
				case "pi_status":
					return a.call("voiceStatus", {}, this.agent);
				case "pi_details":
					return a.call("details", { topic: String(args.topic || ""), mode: this.attention }, this.agent);
				case "switch_session": {
					const list = [...a.S.agents.values()];
					const q = V.norm(args.name);
					if (!q || q === "list" || q === "sessions")
						return { sessions: list.map((x) => ({ name: x.name, status: x.status, task: x.task, waiting: a.S.prompts.get(x.agent)?.size || 0 })) };
					const score = (x) => {
						const hay = V.norm(`${x.name} ${x.cwd?.split("/").pop() || ""} ${x.task || ""}`);
						return q.split(" ").filter((w) => w.length > 1 && hay.includes(w)).length;
					};
					const best = list.map((x) => [x, score(x)]).sort((p, q2) => q2[1] - p[1])[0];
					if (!best || !best[1]) return { error: `no session matches "${args.name}"`, sessions: list.map((x) => x.name) };
					a.openAgent(best[0].agent);
					return { switched: best[0].name, status: best[0].status, waiting: a.S.prompts.get(best[0].agent)?.size || 0 };
				}
				case "remain_silent":
					return { ok: true };
				default:
					return { error: `unknown tool ${name}` };
			}
		}

		// ── realtime engine ──
		async startRealtime() {
			if (!window.RTCPeerConnection) throw new Error("realtime unavailable: no WebRTC in this browser");
			const pc = new RTCPeerConnection();
			this.pc = pc;
			this.remote = $("vRemote");
			pc.ontrack = (e) => {
				this.remote.srcObject = e.streams[0];
				this.remote.play().catch(() => {});
				this.outAn = analyserFor(e.streams[0]); // the orb moves with pi's voice
			};
			const track = this.stream.getAudioTracks()[0];
			track.enabled = !this.muted && (this.turns === "open" || this.talking);
			pc.addTrack(track, this.stream);
			const dc = pc.createDataChannel("oai-events");
			this.dc = dc;
			this.active = false;
			this.wantResponse = false;
			this.userSpeaking = false;
			this.calls = new Map();
			let openTimer;
			const opened = new Promise((resolve, reject) => {
				dc.onopen = () => {
					clearTimeout(openTimer);
					resolve();
				};
				openTimer = setTimeout(() => reject(new Error("realtime voice did not connect")), 15000);
			});
			opened.catch(() => {}); // awaited below; if setup fails first, nobody awaits it
			this.cancelOpen = () => clearTimeout(openTimer);
			dc.onmessage = (e) => {
				try {
					this.onRealtime(JSON.parse(e.data));
				} catch (err) {
					console.warn("voice event", err);
				}
			};
			pc.onconnectionstatechange = () => {
				if (this.closed || this.engine !== "realtime") return;
				if (pc.connectionState === "failed" || pc.connectionState === "closed") this.realtimeLost();
			};
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			const r = await app().call("voiceSession", { sdp: offer.sdp, mode: this.attention }, this.agent);
			await pc.setRemoteDescription({ type: "answer", sdp: r.sdp });
			await opened;
			this.engine = "realtime";
			this.inject(`[PI] Voice mode started. The developer is following the session "${app().agentName(this.agent)}". ${this.statusLine()} Do not greet; wait for them to speak.`, false);
			const open = [...(app().S.prompts.get(this.agent)?.values() || [])];
			this.setState(this.listenState());
			if (open.length) this.ask(open[0]);
		}

		async realtimeLost() {
			this.stopRealtime();
			this.note("Realtime voice dropped; continuing with basic voice.");
			earcon("failed");
			await this.startCascade();
		}

		stopRealtime() {
			this.cancelOpen?.();
			clearInterval(this.vadTimer);
			this.vadTimer = null;
			try {
				this.dc?.close();
				this.pc?.close();
			} catch {}
			this.dc = this.pc = null;
			if (this.engine === "realtime") this.engine = null;
		}

		rt(ev) {
			window.PiVoiceDebug?.push({ type: `>${ev.type}`, _t: performance.now() });
			if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(ev));
		}

		inject(text, respond) {
			this.rt({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
			if (respond) this.respond();
		}

		/** response.create, deferred while a response is active or the developer is talking. */
		respond() {
			if (this.active || this.userSpeaking) {
				this.wantResponse = true;
				return;
			}
			this.wantResponse = false;
			this.active = true;
			this.rt({ type: "response.create" });
		}

		/**
		 * Turn-taking while pi speaks, done on the phone. The realtime server clears pi's audio the
		 * moment its VAD hears anything (whatever interrupt_response says), so a cough or "mm-hmm"
		 * would cut pi off. While pi speaks, server VAD is off and the phone listens: pi's voice ducks
		 * at your first sound, stops after BARGE_MS of voiced speech, and that turn is committed when
		 * you finish; shorter sounds are dropped and pi carries on at full volume.
		 */
		clientTurns(on) {
			if (this.engine !== "realtime" || this.turns !== "open" || this.muted) on = false;
			if (on === !!this.vadTimer) return;
			if (on) {
				this.rt({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } });
				this.cvad = new V.Vad({ hangMs: 800, minSpeechMs: 120 });
				this.cturn = null;
				this.vadTimer = setInterval(() => this.clientVadFrame(), 20);
				return;
			}
			clearInterval(this.vadTimer);
			this.vadTimer = null;
			this.cturn = null;
			if (this.serverTurns) this.rt({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: this.serverTurns } } } });
		}

		clientVadFrame() {
			const rms = rmsOf(this.micAn);
			const speaking = this.state === "speaking";
			// Echo cancellation is good, not perfect: over pi's voice only clearly louder speech counts.
			this.cvad.setGain(speaking ? 3 : 1);
			const e = this.cvad.feed(rms, performance.now());
			if (e === "start") {
				this.cturn = { voiced: 0, interrupted: false };
				this.overlap = speaking;
				if (speaking) this.duck();
			}
			const t = this.cturn;
			if (t && rms > this.cvad.threshold()) {
				t.voiced += 20;
				if (!t.interrupted && t.voiced >= BARGE_MS) {
					t.interrupted = true;
					if (this.state === "speaking") this.hardInterrupt();
					else this.setState("hearing");
				}
			}
			if (e === "end" && t) {
				this.cturn = null;
				if (t.interrupted || this.state !== "speaking") {
					// Your turn: commit what you said; the server's VAD takes over again. A short sound after pi
					// finished waits for its words like any short turn (a late "mm-hmm" gets no reply).
					this.rt({ type: "input_audio_buffer.commit" });
					this.shortTurn = !t.interrupted && t.voiced < 600;
					this.setState("thinking");
					if (!this.shortTurn) {
						earcon("heard");
						this.respond();
					}
					this.clientTurns(false);
				} else {
					// Short and over pi: "mm-hmm"? a cough? or "stop", "no"? Never drop it unheard. Commit it
					// for its words while pi stays ducked; the transcript decides (backchannel, echo, or a turn).
					this.rt({ type: "input_audio_buffer.commit" });
					this.shortTurn = true;
				}
			}
		}

		/** Lowers pi's voice while it finds out whether you are taking the turn. */
		duck() {
			window.PiVoiceDebug?.push({ type: "#duck", _t: performance.now() });
			if (this.remote) this.remote.volume = 0.2;
			if (this.player) this.player.volume = 0.2;
			if (this.engine === "cascade" && speechSynthesis.speaking) speechSynthesis.pause();
			this.ducked = true;
		}

		unduck() {
			if (!this.ducked) return;
			this.ducked = false;
			if (this.remote) this.remote.volume = 1;
			if (this.player) this.player.volume = 1;
			if (speechSynthesis.paused) speechSynthesis.resume();
		}

		/** You took the turn: pi stops talking. */
		hardInterrupt() {
			clearTimeout(this.bargeTimer);
			this.ducked = false;
			if (this.engine === "realtime") {
				// The response may be fully generated while its audio still plays: cancel only a live one.
				if (this.active) this.rt({ type: "response.cancel" });
				this.rt({ type: "output_audio_buffer.clear" });
				if (this.remote) this.remote.volume = 1;
			} else this.silence();
			this.setState("hearing");
		}

		onRealtime(ev) {
			// Set window.PiVoiceDebug = [] (console or test) to record the realtime events with timestamps.
			window.PiVoiceDebug?.push({ ...ev, _t: performance.now() });
			switch (ev.type) {
				// While pi is silent the server's semantic VAD finds your turns; while pi speaks the phone
				// does (clientTurns below), because the server cuts pi's audio on any sound at all.
				case "session.updated":
					if (ev.session?.audio?.input?.turn_detection && !this.serverTurns) this.serverTurns = ev.session.audio.input.turn_detection;
					break;
				case "input_audio_buffer.speech_started":
					this.userSpeaking = true;
					this.turnStart = performance.now();
					this.overlap = false;
					this.heardLive = "";
					this.heard("", true);
					this.setState("hearing");
					break;
				// Live captions: your words as they are recognised, pi's as they are spoken.
				case "conversation.item.input_audio_transcription.delta":
					this.heardLive += ev.delta || "";
					this.heard(this.heardLive, true);
					break;
				case "response.output_audio_transcript.delta":
					// A second spoken part in the same response starts a new sentence.
					if (/[.!?]$/.test(this.saidLive) && ev.delta && !/^\s/.test(ev.delta)) this.saidLive += " ";
					this.saidLive += ev.delta || "";
					this.said(this.saidLive, true);
					break;
				case "input_audio_buffer.speech_stopped": {
					this.userSpeaking = false;
					const dur = performance.now() - (this.turnStart || 0);
					// A long turn is a turn: reply now. A short one waits for its words ("stop" or "mm-hmm"?).
					this.shortTurn = dur < SHORT_TURN_MS;
					this.setState("thinking");
					if (!this.shortTurn) {
						earcon("heard");
						this.respond();
					}
					if (this.wantResponse && !this.active) this.respond();
					break;
				}
				case "conversation.item.input_audio_transcription.completed": {
					const text = String(ev.transcript || "").trim();
					this.heardLive = "";
					this.heard(text);
					const echo = this.overlap && V.isEcho(text, `${this.lastSpoken} ${this.saidLive}`);
					this.rememberHeard(text, echo);
					const answering = !!app().S.prompts.get(this.agent)?.size;
					// "Stop" during an undo window cancels the confirmation, not pi's work. First, before anything
					// else makes a reply of it.
					if (this.grace && !echo && this.cancelsGrace(text)) {
						this.shortTurn = false;
						if (this.state === "speaking") this.hardInterrupt();
						this.unduck();
						this.cancelGrace();
						break;
					}
					if (this.shortTurn) {
						this.shortTurn = false;
						// Listening noises, coughs and pi's own voice are not turns: pi carries on.
						if (echo || V.isBackchannel(text, answering)) {
							this.unduck();
							if (this.state === "thinking" || this.state === "hearing") this.setState(this.listenState());
							break;
						}
						if (this.state === "speaking") this.hardInterrupt();
						earcon("heard");
						this.respond();
					}
					// Instant local stop, before the model has even answered; its own stop_pi is then a no-op.
					if (V.parseCommand(text)?.kind === "stop" && app().S.agents.get(this.agent)?.status === "working") app().call("abort", {}, this.agent).catch(() => {});
					if (V.parseCommand(text)?.kind === "end") setTimeout(() => this.close(), 1200);
					break;
				}
				case "response.created":
					this.active = true;
					this.saidLive = "";
					break;
				case "output_audio_buffer.started":
					this.setState("speaking");
					this.clientTurns(true);
					break;
				case "output_audio_buffer.stopped":
				case "output_audio_buffer.cleared":
					if (this.state === "speaking") this.setState(app().S.prompts.get(this.agent)?.size ? "asking" : this.listenState());
					if (!this.cturn) this.clientTurns(false);
					break;
				case "response.output_audio_transcript.done":
					this.lastSpoken = String(ev.transcript || "");
					this.saidLive = "";
					this.said(this.lastSpoken);
					break;
				case "response.function_call_arguments.done":
					// Handing a request to pi needs no words ("got it, passing that on"): the working sound
					// says it. Cut whatever the voice was about to say with it.
					if (ev.name === "ask_pi") this.rt({ type: "output_audio_buffer.clear" });
					this.runCall(ev.call_id, ev.name, ev.arguments);
					break;
				case "response.done": {
					this.active = false;
					if (ev.response?.status === "failed") this.note(`Voice: ${ev.response?.status_details?.error?.message || "response failed"}`);
					if (this.state === "thinking") this.setState(this.listenState());
					if (this.wantResponse) this.respond();
					break;
				}
				case "error":
					if (!/no active response|cancel/i.test(ev.error?.message || "")) this.note(`Voice: ${ev.error?.message || "error"}`);
					if (/active response/i.test(ev.error?.message || "")) this.wantResponse = true;
					break;
			}
		}

		async runCall(callId, name, rawArgs) {
			if (!callId || this.calls.has(callId)) return;
			this.calls.set(callId, true);
			let args = {};
			try {
				args = JSON.parse(rawArgs || "{}");
			} catch {}
			let out;
			try {
				out = await this.tool(name, args);
			} catch (e) {
				out = { error: e.message };
			}
			this.rt({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(out) } });
			if (name === "ask_pi" && !out.error) {
				// Delegated: say nothing more unless it was queued; the working tick tells them pi is on it.
				if (out.delivered !== "prompt") this.respond();
				else this.setState("working");
				return;
			}
			if (name !== "remain_silent") this.respond();
		}

		// ── cascade engine: VAD on the phone, recognition on the computer, speech synthesis here ──
		async startCascade() {
			this.engine = "cascade";
			const c = audioCtx();
			const src = c.createMediaStreamSource(this.stream);
			const proc = c.createScriptProcessor(2048, 1, 1);
			const mute = c.createGain();
			mute.gain.value = 0;
			src.connect(proc);
			proc.connect(mute).connect(c.destination);
			this.proc = proc;
			this.src = src;
			this.rate = c.sampleRate;
			this.vad = new V.Vad({ hangMs: this.attention === "eyes-busy" ? 1100 : 900 });
			this.pre = []; // pre-roll so the first syllable is not lost
			this.capture = null;
			this.pendingText = "";
			proc.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
			this.setState(this.listenState());
			const open = [...(app().S.prompts.get(this.agent)?.values() || [])];
			if (open.length) this.ask(open[0]);
		}

		stopCascade() {
			try {
				this.proc?.disconnect();
				this.src?.disconnect();
			} catch {}
			this.proc = this.src = null;
			if (this.engine === "cascade") this.engine = null;
		}

		onFrame(data) {
			if (this.closed) return;
			const frame = new Float32Array(data);
			let sum = 0;
			for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
			const rms = Math.sqrt(sum / frame.length);
			if (this.capture) this.capture.push(frame);
			else {
				this.pre.push(frame);
				if (this.pre.length > 6) this.pre.shift();
			}
			if (this.manual) return;
			if (this.turns === "tap" || this.state === "thinking" || this.state === "paused") return;
			// While our own voice plays, only clearly louder speech counts (echo cancellation is not perfect).
			this.vad.setGain(this.state === "speaking" ? 4 : 1);
			const ev = this.vad.feed(rms, performance.now());
			// While ducked: count voiced time, not elapsed time (the VAD's end waits out a long hangover).
			if (this.ducked && rms > this.vad.threshold() && (this.voicedMs += (frame.length / this.rate) * 1000) >= BARGE_MS) this.hardInterrupt();
			if (ev === "start") {
				// Soft barge-in, as in realtime: duck now, stop only if the speech goes on.
				this.overlap = this.state === "speaking";
				if (this.overlap) {
					this.duck();
					this.voicedMs = 0;
				}
				clearTimeout(this.continueTimer);
				if (!this.capture) this.capture = [...this.pre];
				this.setState("hearing");
			} else if (ev === "end" && this.capture) this.endTurn();
		}

		manualTurn() {
			if (!this.manual) {
				this.silence();
				this.manual = this.talking = true;
				this.capture = [...this.pre];
				earcon("listen");
				return this.setState("hearing");
			}
			this.manual = this.talking = false;
			this.endTurn();
		}

		async endTurn() {
			const frames = this.capture || [];
			this.capture = null;
			const n = frames.reduce((s, f) => s + f.length, 0);
			if (n < this.rate * 0.35) {
				if (this.ducked) {
					this.unduck();
					return this.setState("speaking");
				}
				return this.setState(this.listenState());
			}
			earcon("heard");
			this.setState("thinking");
			const all = new Float32Array(n);
			let o = 0;
			for (const f of frames) {
				all.set(f, o);
				o += f.length;
			}
			// Downsample to 16 kHz: smaller upload, what recognisers want.
			const ratio = this.rate / 16000;
			const out = new Float32Array(Math.floor(n / ratio));
			for (let i = 0; i < out.length; i++) out[i] = all[Math.floor(i * ratio)];
			let text = "";
			try {
				const r = await app().call("transcribe", { audio: await blobToBase64(wav(out, 16000)), mime: "audio/wav", distill: false }, this.agent);
				text = String(r.raw || "").trim();
			} catch (e) {
				this.note(`Recognition failed: ${e.message}`);
				earcon("failed");
				return this.setState(this.listenState());
			}
			if (!text) return this.setState(this.listenState());
			text = `${this.pendingText} ${text}`.trim();
			clearTimeout(this.bargeTimer);
			// Over pi's voice: a listening noise, a cough or pi's own echo is not a turn; pi carries on.
			if (this.ducked) {
				const answering = !!app().S.prompts.get(this.agent)?.size;
				if (V.isEcho(text, this.lastSpoken) || V.isBackchannel(text, answering)) {
					this.unduck();
					return this.setState("speaking");
				}
				this.hardInterrupt();
			}
			this.heard(text);
			// Trailing "and…" / "um": wait a moment for the rest of the thought.
			if (V.incomplete(text) && !this.manual && this.turns === "open") {
				this.pendingText = text;
				this.setState("listening");
				this.continueTimer = setTimeout(() => {
					const t = this.pendingText;
					this.pendingText = "";
					if (t) this.handleUtterance(t);
				}, 2200);
				return;
			}
			this.pendingText = "";
			await this.handleUtterance(text);
		}

		/** The cascade's own conversation logic: commands, answers to dialogs, then requests to pi. */
		async handleUtterance(text) {
			const a = app();
			this.rememberHeard(text);
			try {
				const cmd = V.parseCommand(text);
				if (this.grace && this.cancelsGrace(text)) return this.cancelGrace();
				const prompts = [...(a.S.prompts.get(this.agent)?.values() || [])];
				if (cmd?.kind === "end") return this.close();
				if (cmd?.kind === "help") return this.speak(V.HELP);
				if (cmd?.kind === "stop") {
					await this.tool("stop_pi", {});
					return this.speak("Stopped.");
				}
				if (cmd?.kind === "quiet") return this.setState(this.listenState());
				if (cmd?.kind === "repeat") return this.speak(this.lastSpoken || "I haven't said anything yet.");
				if (cmd?.kind === "status") return this.speak((await this.tool("pi_status", {})).speech);
				if (cmd?.kind === "shorter") {
					this.attention = "eyes-busy";
					this.render();
					return this.speak("Okay, shorter.");
				}
				if (prompts.length) {
					const p = prompts[0];
					if (/more options/.test(V.norm(text)) && p.kind === "select") return this.speak(V.speakPrompt(p, ++this.optionPage));
					const r = V.answerFor(p, text);
					if (r.needConfirm) return this.speak(`To be safe: say "yes, ${r.needConfirm}" to go ahead, or no.`);
					if (!r.unclear) {
						await a.call("answer", { id: p.id, value: r.value }, this.agent);
						return this.speak(r.value === false ? "Okay, no." : r.value === undefined ? "Cancelled." : "Okay.");
					}
					if (p.kind !== "input" && text.split(" ").length < 4) return this.speak(`Sorry. ${V.speakPrompt(p, this.optionPage)}`);
				}
				if ((cmd?.kind === "more" || /^(yes|yeah|sure|ok|okay)\b/.test(V.norm(text))) && this.more.length) {
					const topic = this.more.shift();
					return this.speak((await this.tool("pi_details", { topic })).speech);
				}
				if (cmd?.kind === "more") return this.speak("That's all I have.");
				if (/^(?:switch to|go to|open)\s+(.+)$/.test(V.norm(text))) {
					const name = V.norm(text).replace(/^(?:switch to|go to|open)\s+/, "");
					const r = await this.tool("switch_session", { name });
					return this.speak(r.error ? `I can't find ${name}.` : `Now on ${r.switched}${r.waiting ? ". It has a question for you" : ""}.`);
				}
				// A request for pi: distil it into what was meant (names grounded in the repo), then send.
				let request = text;
				try {
					const d = await a.call("distill", { raw: text }, this.agent);
					if (d.text) request = d.editor || d.text;
				} catch {}
				const r = await this.tool("ask_pi", { request });
				if (r.error) return this.speak(`I couldn't send that: ${r.error}`);
				this.more = [];
				if (r.delivered === "prompt") return this.setState("working");
				return this.speak(r.delivered === "steer" ? "Passed on." : "Queued for after this.");
			} catch (e) {
				earcon("failed");
				this.speak(`Something went wrong: ${e.message}`);
			}
		}

		unlockSpeech() {
			try {
				const u = new SpeechSynthesisUtterance("");
				speechSynthesis.speak(u);
			} catch {}
		}

		voice() {
			const all = speechSynthesis.getVoices();
			const lang = (navigator.language || "en-US").toLowerCase();
			const same = all.filter((v) => v.lang.toLowerCase().startsWith(lang.split("-")[0]));
			const rank = (v) => (/premium|enhanced|neural|natural/i.test(v.name) ? 0 : /siri|google|samantha|daniel|karen|moira/i.test(v.name) ? 1 : v.localService ? 2 : 3) + (v.lang.toLowerCase() === lang ? 0 : 0.5);
			return same.sort((x, y) => rank(x) - rank(y))[0] || null;
		}

		/** Stops whatever is speaking: the computer's audio or the phone's synthesis. */
		silence() {
			speechSynthesis.cancel();
			if (this.player) {
				this.player.pause();
				this.player = null;
			}
		}

		/** Speaks with the computer's voice when one is configured (voice.ttsUrl or OPENAI_API_KEY), else the phone's. */
		async speak(text) {
			const parts = V.chunks(text);
			if (!parts.length) return this.setState(this.listenState());
			this.lastSpoken = text;
			this.said(text);
			this.silence();
			const turn = (this.speakTurn = (this.speakTurn || 0) + 1);
			if (this.serverTts !== false) {
				try {
					const r = await app().call("speak", { text }, this.agent);
					if (turn !== this.speakTurn || this.closed) return;
					const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.audio), (c) => c.charCodeAt(0))], { type: r.mime }));
					const player = new Audio(url);
					this.player = player;
					this.setState("speaking");
					player.onended = player.onerror = () => {
						URL.revokeObjectURL(url);
						if (this.player === player) this.player = null;
						if (this.state === "speaking") this.setState(app().S.prompts.get(this.agent)?.size ? "asking" : this.listenState());
					};
					await player.play();
					return;
				} catch (e) {
					if (turn !== this.speakTurn) return;
					// Not configured: stop asking. Other failures: this time only.
					if (/tts unavailable/.test(e.message)) this.serverTts = false;
				}
			}
			this.speakLocal(parts);
		}

		speakLocal(parts) {
			const voice = this.voice();
			this.setState("speaking");
			parts.forEach((p, i) => {
				const u = new SpeechSynthesisUtterance(p);
				if (voice) u.voice = voice;
				u.rate = this.attention === "eyes-busy" ? 1.05 : 1.0;
				if (i === parts.length - 1)
					u.onend = u.onerror = () => {
						if (this.state === "speaking") this.setState(app().S.prompts.get(this.agent)?.size ? "asking" : this.listenState());
					};
				speechSynthesis.speak(u);
			});
		}
	}

	// ── wiring ───────────────────────────────────────────────────────────────────────────────────────
	let mode = null;

	function startVoiceMode() {
		if (!app()?.S.device) return;
		if (app().S.device.role !== "control") return app().toast("Voice mode needs a full-control device.", "warning");
		if (!app().S.current) return app().toast("No session to talk to yet.", "warning");
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return secureSheet();
		mode = new VoiceMode();
		mode.open();
	}

	/** The microphone needs HTTPS: say exactly how to get there instead of failing. */
	function secureSheet() {
		const port = location.port || "7878";
		app().openSheet((body) => {
			const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
			body.append(
				el("h3", "", "Voice needs a secure address"),
				el("p", "note", "Browsers only let HTTPS pages use the microphone. One-time setup on your computer, if you use Tailscale:"),
				el("pre", "out", `tailscale serve --bg ${port}`),
				el("p", "note", "Then in pi: /remote settings → HTTPS address, and open pi mobile from that address (it also turns on lock-screen notifications). On the computer itself, http://127.0.0.1 works as is."),
			);
			if (navigator.clipboard) {
				const copy = el("button", "row", "Copy the command");
				copy.onclick = () => navigator.clipboard.writeText(`tailscale serve --bg ${port}`).then(() => app().toast("Copied"));
				body.appendChild(copy);
			}
		});
	}

	function wire() {
		wireMic();
		wireLearning();
		$("voiceBtn").onclick = startVoiceMode;
		$("vEnd").onclick = () => {
			mode?.close();
			mode = null;
		};
		$("vOrb").onclick = () => mode?.tap();
		$("vMute").onclick = () => mode?.setMuted(!mode.muted);
		$("vEyesFree").onclick = () => mode?.setAttention("eyes-busy");
		$("vGlance").onclick = () => mode?.setAttention("glance");
		$("vOpen").onclick = () => mode?.setTurns("open");
		$("vTap").onclick = () => mode?.setTurns("tap");
		$("vSession").onclick = () => app().sessionsSheet();
		// Escape ends voice mode on a keyboard (the circle is a button, so Enter/Space tap it).
		document.addEventListener("keydown", (e) => {
			if (!mode || mode.closed || $("voice").hidden || !$("sheet").hidden) return;
			if (e.key === "Escape") $("vEnd").click();
		});
	}

	window.PiVoice = {
		/** Tests only (set window.PiVoiceDebug = [] first): show a state with sample captions. */
		preview(state, { heard = "", said = "", note = "" } = {}) {
			if (!window.PiVoiceDebug || !mode) return;
			mode.heard(heard);
			mode.said(said);
			mode.note(note);
			mode.setState(state);
		},
		// After the app has applied the event (prompts, statuses), so voice reads the updated state.
		onEvent(ev) {
			if (mode && !mode.closed) setTimeout(() => mode && !mode.closed && mode.onEvent(ev), 0);
		},
		get active() {
			return !!mode && !mode.closed;
		},
	};

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
	else wire();
})();
