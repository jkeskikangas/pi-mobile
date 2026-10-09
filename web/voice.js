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
	// Tap the mic, talk, tap again: the computer recognises the speech and distils it into the message
	// you meant, which lands in the composer for review. "raw" shows what was heard, "undo" restores.
	const dict = { rec: null, stream: null, chunks: [], started: 0, timer: null, last: null, busy: false, analyser: null };

	async function toggleDictation() {
		if (dict.busy) return;
		if (dict.rec) return finishDictation(true);
		try {
			dict.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
		} catch (e) {
			return app().toast(micError(e), "error");
		}
		const mime = recorderMime();
		dict.rec = new MediaRecorder(dict.stream, mime ? { mimeType: mime } : undefined);
		dict.chunks = [];
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
		$("micBtn").setAttribute("aria-label", "Finish dictation");
		dict.timer = setInterval(renderDictBar, 120);
		renderDictBar();
		navigator.vibrate?.(30);
	}

	function stopStream() {
		clearInterval(dict.timer);
		dict.stream?.getTracks().forEach((t) => t.stop());
		dict.stream = null;
		dict.analyser = null;
		$("micBtn").classList.remove("rec");
		$("micBtn").setAttribute("aria-label", "Dictate");
	}

	async function finishDictation(keep) {
		const rec = dict.rec;
		dict.rec = null;
		if (!rec) return;
		const stopped = new Promise((r) => (rec.onstop = r));
		rec.stop();
		await stopped;
		stopStream();
		if (!keep) return setDictBar(null);
		const blob = new Blob(dict.chunks, { type: rec.mimeType || "audio/webm" });
		if (Date.now() - dict.started < 600 || blob.size < 1500) return setDictBar("Too short. Tap the mic and talk, then tap again.");
		const input = app().input();
		const before = input.value;
		dict.busy = true;
		setDictBar("Understanding what you meant…");
		try {
			const r = await app().call("transcribe", { audio: await blobToBase64(blob), mime: blob.type, draft: before });
			if (!r.raw?.trim()) return setDictBar("Didn't catch anything. Try again a little closer to the mic.");
			input.value = r.editor || r.text;
			app().autosize();
			dict.last = { raw: r.raw, text: input.value, before };
			const bar = setDictBar(r.by === "model" ? "Distilled from your speech." : "Cleaned up locally (model unavailable).");
			const chip = (label, fn) => {
				const b = document.createElement("button");
				b.className = "chip";
				b.textContent = label;
				b.onclick = () => fn(b);
				bar.appendChild(b);
			};
			const label = bar.querySelector(".grow");
			const distilledLabel = label.textContent;
			chip("raw", (b) => {
				const showRaw = input.value !== dict.last.raw;
				input.value = showRaw ? dict.last.raw : dict.last.text;
				b.textContent = showRaw ? "distilled" : "raw";
				label.textContent = showRaw ? "What you said, word for word." : distilledLabel;
				app().autosize();
			});
			chip("undo", () => {
				input.value = dict.last.before;
				app().autosize();
				setDictBar(null);
			});
			setTimeout(() => bar.isConnected && setDictBar(null), 15000);
		} catch (e) {
			setDictBar(`Voice input failed: ${e.message}`);
		} finally {
			dict.busy = false;
		}
	}

	function setDictBar(text) {
		const bar = $("dictBar");
		bar.replaceChildren();
		bar.hidden = !text;
		if (text) bar.appendChild(Object.assign(document.createElement("span"), { className: "grow", textContent: text }));
		return bar;
	}

	function renderDictBar() {
		const secs = Math.floor((Date.now() - dict.started) / 1000);
		let lvl = 0;
		if (dict.analyser) {
			const a = new Float32Array(dict.analyser.fftSize);
			dict.analyser.getFloatTimeDomainData(a);
			lvl = Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
		}
		const bar = setDictBar(`Listening ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} — tap the mic when done`);
		const meter = document.createElement("span");
		meter.className = "meter";
		meter.style.setProperty("--lvl", String(Math.min(1, lvl * 8)));
		bar.prepend(meter);
		const x = document.createElement("button");
		x.className = "chip";
		x.textContent = "cancel";
		x.onclick = () => finishDictation(false);
		bar.appendChild(x);
		if (secs >= 300) finishDictation(true);
	}

	// ── voice mode ─────────────────────────────────────────────────────────────────────────────────
	const LABEL = {
		connecting: "Connecting…",
		listening: "Listening",
		hearing: "Hearing you",
		thinking: "One moment",
		working: "pi is working",
		speaking: "Speaking — talk to interrupt",
		asking: "pi needs you",
		paused: "Mic off — tap to talk",
		offline: "Reconnecting…",
	};

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
		}

		// ── lifecycle ──
		async open() {
			$("voice").hidden = false;
			document.body.classList.add("voice-on");
			this.render();
			audioCtx();
			this.unlockSpeech();
			try {
				this.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
			} catch (e) {
				this.note(micError(e));
				return this.setState("paused");
			}
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
		}

		async restart() {
			for (const t of this.timers) clearInterval(t);
			this.timers = [];
			this.stream?.getTracks().forEach((t) => t.stop());
			this.note("");
			this.setState("connecting");
			await this.open();
		}

		close() {
			if (this.closed) return;
			this.closed = true;
			earcon("off");
			this.heartbeat(false);
			for (const t of this.timers) clearInterval(t);
			this.stopRealtime();
			this.stopCascade();
			this.silence();
			this.stream?.getTracks().forEach((t) => t.stop());
			this.wake?.release?.().catch(() => {});
			this.keep?.pause();
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

		/** Headset / lock-screen play-pause toggles the mic; needs an audio element as the active media session. */
		mediaSession() {
			if (!navigator.mediaSession) return;
			try {
				this.keep = new Audio(URL.createObjectURL(wav(new Float32Array(16000), 16000)));
				this.keep.loop = true;
				this.keep.volume = 0.01;
				this.keep.play().catch(() => {});
				navigator.mediaSession.metadata = new MediaMetadata({ title: "pi voice", artist: app().agentName(this.agent) });
				const toggle = () => this.tap();
				for (const a of ["play", "pause", "togglemicrophone"]) {
					try {
						navigator.mediaSession.setActionHandler(a, toggle);
					} catch {}
				}
			} catch {}
		}

		// ── UI ──
		setState(s) {
			this.state = s;
			this.render();
		}

		render() {
			const orb = $("vOrb");
			orb.className = `v-orb ${this.state}`;
			$("vState").textContent = LABEL[this.state] || this.state;
			$("vSession").textContent = app().agentName(this.agent);
			$("vAttention").textContent = this.attention === "glance" ? "Can glance" : "Eyes-free";
			$("vTurns").textContent = this.turns === "tap" ? "Tap to talk" : "Open mic";
			$("vEngine").textContent = this.engine === "realtime" ? "realtime" : this.engine === "cascade" ? "basic" : "";
		}

		note(text) {
			$("vNote").textContent = text || "";
		}

		heard(text) {
			$("vHeard").textContent = text ? `“${text}”` : "";
		}

		said(text) {
			$("vSaid").textContent = text || "";
		}

		/** The circle: interrupt pi speaking, or talk (tap mode), or unmute. */
		tap() {
			navigator.vibrate?.(20);
			// No engine yet (the microphone was refused or failed): try again.
			if (!this.engine) {
				if (this.state !== "connecting") this.restart();
				return;
			}
			if (this.state === "speaking") return this.interrupt();
			if (this.engine === "realtime") {
				const t = this.stream?.getAudioTracks()[0];
				if (!t) return;
				if (this.turns === "tap") {
					t.enabled = !t.enabled;
					if (!t.enabled) this.rt({ type: "input_audio_buffer.commit" });
					earcon(t.enabled ? "listen" : "heard");
					return this.setState(t.enabled ? "listening" : "paused");
				}
				t.enabled = !t.enabled;
				earcon(t.enabled ? "listen" : "off");
				return this.setState(t.enabled ? "listening" : "paused");
			}
			if (this.turns === "tap" || this.state === "paused") return this.manualTurn();
		}

		toggleAttention() {
			this.attention = this.attention === "glance" ? "eyes-busy" : "glance";
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

		toggleTurns() {
			this.turns = this.turns === "tap" ? "open" : "tap";
			localStorage.setItem(TURN_KEY, this.turns);
			const t = this.stream?.getAudioTracks()[0];
			if (this.engine === "realtime" && t) {
				t.enabled = this.turns === "open";
				this.setState(t.enabled ? "listening" : "paused");
			} else if (this.engine === "cascade") this.setState(this.turns === "open" ? "listening" : "paused");
			this.render();
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
			if (ev.type === "prompt_end" && ev.agent === this.agent && ev.by === "terminal") {
				if (this.pendingConfirm?.prompt.id === ev.id) this.pendingConfirm = null;
				if (this.engine === "realtime") this.inject("[PI] That question was answered in the terminal.", false);
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
			const info = app().S.agents.get(this.agent);
			if (info?.status !== "working") {
				if (this.state === "working") this.setState(this.listenState());
				return;
			}
			if (this.state === "listening" || this.state === "paused") this.setState("working");
			if (this.state === "working" && Date.now() - this.lastTick > 6000) {
				this.lastTick = Date.now();
				earcon("working");
			}
		}

		listenState() {
			if (this.engine === "realtime") return this.stream?.getAudioTracks()[0]?.enabled === false ? "paused" : "listening";
			return this.turns === "tap" ? "paused" : "listening";
		}

		async settled() {
			let b;
			try {
				b = await app().call("brief", { mode: this.attention }, this.agent);
			} catch (e) {
				return this.tell("pi finished, but I couldn't get the summary.", `[PI] pi finished but the summary failed: ${e.message}`);
			}
			const failed = /COMMAND FAILED|ERROR:/.test(b.report || "");
			earcon(failed ? "failed" : "done");
			this.more = b.more || [];
			const offer = this.more.length && this.engine === "cascade" ? ` Want ${this.more[0]}?` : "";
			this.tell(
				b.speech + offer,
				`[PI] pi finished.\nSPOKEN BRIEF: ${b.speech}\n${this.more.length ? `MORE AVAILABLE: ${this.more.join("; ")} (offer at most one, briefly)\n` : ""}REPORT (for follow-up questions, do not read out):\n${b.report}`,
			);
		}

		ask(prompt) {
			this.optionPage = 0;
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
					const r = V.answerFor(p, String(args.answer ?? ""));
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
			};
			const track = this.stream.getAudioTracks()[0];
			track.enabled = this.turns === "open";
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
			try {
				this.dc?.close();
				this.pc?.close();
			} catch {}
			this.dc = this.pc = null;
			if (this.engine === "realtime") this.engine = null;
		}

		rt(ev) {
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

		onRealtime(ev) {
			window.PiVoiceDebug?.push(ev); // set to [] in the console (or a test) to watch the realtime events
			switch (ev.type) {
				case "input_audio_buffer.speech_started":
					this.userSpeaking = true;
					this.setState("hearing");
					break;
				case "input_audio_buffer.speech_stopped":
					this.userSpeaking = false;
					earcon("heard");
					this.setState("thinking");
					if (this.wantResponse && !this.active) this.respond();
					break;
				case "conversation.item.input_audio_transcription.completed": {
					const text = String(ev.transcript || "").trim();
					this.heard(text);
					// Instant local stop, before the model has even answered; its own stop_pi is then a no-op.
					if (V.parseCommand(text)?.kind === "stop" && app().S.agents.get(this.agent)?.status === "working") app().call("abort", {}, this.agent).catch(() => {});
					if (V.parseCommand(text)?.kind === "end") setTimeout(() => this.close(), 1200);
					break;
				}
				case "response.created":
					this.active = true;
					break;
				case "output_audio_buffer.started":
					this.setState("speaking");
					break;
				case "output_audio_buffer.stopped":
				case "output_audio_buffer.cleared":
					if (this.state === "speaking") this.setState(app().S.prompts.get(this.agent)?.size ? "asking" : this.listenState());
					break;
				case "response.output_audio_transcript.done":
					this.lastSpoken = String(ev.transcript || "");
					this.said(this.lastSpoken);
					break;
				case "response.function_call_arguments.done":
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
			if (ev === "start") {
				if (this.state === "speaking") this.silence();
				clearTimeout(this.continueTimer);
				if (!this.capture) this.capture = [...this.pre];
				this.setState("hearing");
			} else if (ev === "end" && this.capture) this.endTurn();
		}

		manualTurn() {
			if (!this.manual) {
				this.silence();
				this.manual = true;
				this.capture = [...this.pre];
				earcon("listen");
				return this.setState("hearing");
			}
			this.manual = false;
			this.endTurn();
		}

		async endTurn() {
			const frames = this.capture || [];
			this.capture = null;
			const n = frames.reduce((s, f) => s + f.length, 0);
			if (n < this.rate * 0.35) return this.setState(this.listenState());
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
			try {
				const cmd = V.parseCommand(text);
				const prompts = [...(a.S.prompts.get(this.agent)?.values() || [])];
				if (cmd?.kind === "end") return this.close();
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
		if (!navigator.mediaDevices?.getUserMedia) return app().toast(micError(new Error("unavailable")), "error");
		mode = new VoiceMode();
		mode.open();
	}

	function wire() {
		$("micBtn").onclick = toggleDictation;
		$("voiceBtn").onclick = startVoiceMode;
		$("vEnd").onclick = () => {
			mode?.close();
			mode = null;
		};
		$("vOrb").onclick = () => mode?.tap();
		$("vAttention").onclick = () => mode?.toggleAttention();
		$("vTurns").onclick = () => mode?.toggleTurns();
	}

	window.PiVoice = {
		onEvent(ev) {
			if (mode && !mode.closed) mode.onEvent(ev);
		},
		get active() {
			return !!mode && !mode.closed;
		},
	};

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
	else wire();
})();
