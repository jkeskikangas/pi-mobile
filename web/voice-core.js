// pi mobile voice — pure logic shared by the browser (window.PiVoiceCore) and the tests:
// local voice commands, spoken answers to pi's dialogs, end-of-thought detection, an adaptive
// energy VAD, and sentence chunking for speech synthesis. No DOM, no audio APIs.
"use strict";

(() => {
	const norm = (s) =>
		String(s || "")
			.toLowerCase()
			.replace(/[’']/g, "'")
			.replace(/[^\p{L}\p{N}' ]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();

	/** Drops a leading wake phrase: "pi, stop" / "hey pi stop" / "ok so stop". */
	const stripLead = (s) => s.replace(/^(?:(?:hey|ok|okay|so|um|uh|and|alright)\s+)*(?:pi\s+)?/, "").trim();

	// Interrupting the voice never stops pi: "stop" is about the voice (quiet); stopping pi's work needs it said
	// ("stop pi", "cancel that"), as in the terminal (packages/pi-speech/src/voice-session.ts).
	const COMMANDS = [
		["stopPi", /^(?:stop pi|stop the work|stop working|stop everything|cancel that|cancel it|cancel the request|abort|abort that|abort it)$/],
		["repeat", /^(?:repeat|repeat that|say (?:that|it) again|again|what|sorry what|come again|pardon)$/],
		["status", /^(?:status|what's (?:it|pi|he) doing|what are you doing|what is it doing|how's it going|progress|where are we|are you done|is it done)$/],
		["shorter", /^(?:shorter|be (?:brief|briefer|terse|shorter)|too long|less detail)$/],
		["more", /^(?:more|tell me more|go on|details|more details|what else|continue|and)$/],
		["quiet", /^(?:stop|stop it|stop that|okay stop|ok stop|cancel|halt|quiet|be quiet|shush|hush|shut up|silence|stop talking|enough)$/],
		["end", /^(?:end voice(?: mode)?|exit voice(?: mode)?|goodbye|bye|that's all|we're done|end call|hang up)$/],
		["help", /^(?:help|what can i say|what can you do|how does this work|commands)$/],
		["pushToTalk", /^(?:push to talk|hold to talk|tap to talk|walkie talkie)$/],
		["openMic", /^(?:open mic|open microphone|hands free|hands-free)$/],
		["eyesFree", /^(?:eyes free|eyes-free|i can't look|i cannot look|i'm driving)$/],
		["glance", /^(?:i can (?:look|glance|see the screen)|can glance|i'm at (?:a|the|my) screen)$/],
	];

	/** What "what can I say?" answers: a few things, spoken, not a manual. */
	const HELP =
		"Just talk to pi like a colleague. You can say: what's it doing; tell me more; say that again; switch to another session; stop, to stop me talking; and stop pi, to stop its work. When pi asks something, answer out loud, or tap the card.";

	/**
	 * A listener's backchannel or a stray sound, not a turn: "mm-hmm", "right", a cough. While pi
	 * speaks these should not interrupt it. Never true when pi is waiting on an answer, where "yeah"
	 * and "ok" are answers.
	 */
	function isBackchannel(text, answering = false) {
		const t = norm(text);
		if (!t) return true;
		if (answering) return false;
		return /^(?:m+h?m+|mm+ ?hmm+|uh ?huh|uh+|um+|hmm+|ah+|oh+|yeah|yep|yup|ok|okay|right|sure|cool|nice|great|got it|i see|alright|true|exactly)$/.test(t);
	}

	/**
	 * Did the microphone just pick up pi's own voice? A transcript that is a piece of what pi was
	 * saying ("say yes, deploy to confirm") must never count as the developer's consent.
	 */
	function isEcho(heard, spoken) {
		const h = norm(heard);
		const s = norm(spoken);
		return h.split(" ").length >= 2 && s.includes(h);
	}

	/** A local command if the whole utterance is one, else null. Instant: no model round trip. */
	function parseCommand(text) {
		const t = stripLead(norm(text));
		if (!t || t.split(" ").length > 6) return null;
		for (const [kind, re] of COMMANDS) if (re.test(t)) return { kind };
		return null;
	}

	const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go for it|please do|correct|right|affirmative|confirm(?:ed)?|of course|sounds good)\b/;
	const NO = /^(?:no|nope|nah|don't|do not|negative|cancel|stop|never ?mind|not now|skip)\b/;
	const ORDINALS = { one: 1, first: 1, "1": 1, two: 2, second: 2, "2": 2, three: 3, third: 3, "3": 3, four: 4, fourth: 4, "4": 4, five: 5, fifth: 5, "5": 5, last: -1 };

	/** Irreversible or outward-facing: answering yes needs the action named, not a bare "yeah". */
	const DESTRUCTIVE = /\b(push|force|deploy|publish|release|delete|remove|rm|drop|truncate|wipe|reset|overwrite|destroy|send|email|post|pay|purchase|merge|rebase|migrate|production|prod)\b/i;
	const isDestructive = (prompt) => DESTRUCTIVE.test(`${prompt.title || ""} ${prompt.message || ""}`);

	/** The action word a confirmation must name, e.g. "push" in "Push 3 commits to main?" */
	function actionWord(prompt) {
		const m = DESTRUCTIVE.exec(`${prompt.title || ""} ${prompt.message || ""}`);
		return m ? m[1].toLowerCase() : null;
	}

	/**
	 * Maps a spoken reply to a dialog answer.
	 * → { value } to answer, { needConfirm: word } when a destructive yes did not name the action,
	 *   { unclear: true } when the reply did not answer the question.
	 */
	function answerFor(prompt, text) {
		const t = stripLead(norm(text));
		if (prompt.kind === "confirm") {
			if (NO.test(t)) return { value: false };
			if (YES.test(t) || /\bconfirm\b/.test(t)) {
				const word = isDestructive(prompt) ? actionWord(prompt) : null;
				if (word && !new RegExp(`\\b(${word}|confirm)`).test(t)) return { needConfirm: word };
				return { value: true };
			}
			return { unclear: true };
		}
		if (prompt.kind === "select") {
			const options = prompt.options || [];
			if (/^(?:cancel|none|neither|never ?mind|skip)\b/.test(t)) return { value: undefined };
			const ord = /(?:option|number|the)?\s*\b(one|two|three|four|five|first|second|third|fourth|fifth|last|[1-5])\b(?:\s+(?:one|option))?$/.exec(t);
			if (ord && t.split(" ").length <= 4) {
				const n = ORDINALS[ord[1]];
				const i = n === -1 ? options.length - 1 : n - 1;
				if (options[i] !== undefined) return confirmSelect(prompt, options[i], t);
			}
			let best = null;
			for (const o of options) {
				const words = norm(o).split(" ").filter((w) => w.length > 2);
				const hit = words.filter((w) => t.includes(w)).length;
				const score = words.length ? hit / words.length : 0;
				if (score > 0.5 && (!best || score > best.score)) best = { o, score };
			}
			if (best) return confirmSelect(prompt, best.o, t);
			if (options.length === 2 && YES.test(t)) return confirmSelect(prompt, options[0], t);
			return { unclear: true };
		}
		if (/^(?:cancel|never ?mind|skip)$/.test(t)) return { value: undefined };
		return { value: String(text || "").trim() };
	}

	function confirmSelect(prompt, option, t) {
		const word = DESTRUCTIVE.exec(option);
		if (word && !new RegExp(`\\b(${word[1].toLowerCase()}|confirm)`).test(t)) return { needConfirm: word[1].toLowerCase(), option };
		return { value: option };
	}

	/**
	 * Did something the developer actually said name this destructive action? ("deploy the app to
	 * production" names "Deploy to production?"). Used to confirm with an undo window instead of
	 * asking a third time. Requires the action word and, when the question names a target such as
	 * production or main, that target too.
	 */
	function requestNames(prompt, said) {
		const word = actionWord(prompt);
		if (!word) return false;
		const s = norm(said);
		if (!new RegExp(`\\b${word}`).test(s)) return false;
		// Targets from the question itself; the dialog's body is elaboration ("this ships main").
		const q = norm(prompt.title || "");
		const targets = ["production", "prod", "main", "master", "staging", "origin", "live"].filter((t) => new RegExp(`\\b${t}\\b`).test(q));
		return targets.every((t) => new RegExp(`\\b${t === "prod" ? "prod(?:uction)?" : t}\\b`).test(s));
	}

	/** How a dialog is asked aloud: the question, then at most two options at a time. */
	function speakPrompt(prompt, page = 0) {
		const q = `${prompt.title || ""}${prompt.message ? `. ${prompt.message}` : ""}`.replace(/\s+/g, " ").trim();
		if (prompt.kind === "confirm") {
			const word = isDestructive(prompt) ? actionWord(prompt) : null;
			return `${q} ${word ? `Say "yes, ${word}" to confirm, or no.` : "Yes or no?"}`;
		}
		if (prompt.kind === "select") {
			const o = prompt.options || [];
			const slice = o.slice(page * 2, page * 2 + 2);
			const named = slice.map((x, i) => `${["one", "two", "three", "four", "five", "six", "seven", "eight"][page * 2 + i] || page * 2 + i + 1}: ${x}`);
			const rest = o.length > page * 2 + 2 ? ` Or say "more options". There are ${o.length}.` : "";
			return `${page ? "" : `${q} `}${named.join(". ")}.${rest}`;
		}
		return `${q} What should I answer?`;
	}

	/** True when an utterance trails off mid-thought, so the listener should keep the floor open. */
	function incomplete(text) {
		const t = norm(text);
		if (!t) return true;
		return /\b(?:and|but|or|so|because|then|also|the|a|an|to|of|in|with|for|um|uh|er|like|wait|hold on|let me think|which|that|if|when)$/.test(t);
	}

	/**
	 * Energy VAD with an adaptive noise floor and hangover. Feed frame RMS values (0..1) with
	 * timestamps; it reports "start" after `minSpeechMs` above threshold and "end" after `hangMs`
	 * below. `extend(ms)` lengthens the current hangover (used when the words so far trail off).
	 */
	class Vad {
		constructor(o = {}) {
			this.hangMs = o.hangMs ?? 900;
			this.minSpeechMs = o.minSpeechMs ?? 180;
			this.ratio = o.ratio ?? 3;
			this.minLevel = o.minLevel ?? 0.012;
			this.floor = o.floor ?? 0.004;
			this.speaking = false;
			this.aboveSince = 0;
			this.belowSince = 0;
			this.extra = 0;
			this.gain = 1;
		}
		threshold() {
			return Math.max(this.minLevel, this.floor * this.ratio) * this.gain;
		}
		/** Raise the bar while our own voice plays (echo), back to 1 after. */
		setGain(g) {
			this.gain = g;
		}
		extend(ms) {
			this.extra = ms;
		}
		feed(rms, now) {
			const above = rms > this.threshold();
			if (!above && !this.speaking) this.floor = this.floor * 0.95 + rms * 0.05;
			if (above) {
				this.belowSince = 0;
				if (!this.aboveSince) this.aboveSince = now;
				if (!this.speaking && now - this.aboveSince >= this.minSpeechMs) {
					this.speaking = true;
					this.extra = 0;
					return "start";
				}
			} else {
				this.aboveSince = 0;
				if (this.speaking) {
					if (!this.belowSince) this.belowSince = now;
					if (now - this.belowSince >= this.hangMs + this.extra) {
						this.speaking = false;
						this.belowSince = 0;
						return "end";
					}
				}
			}
			return null;
		}
	}

	/** Splits text into utterances short enough for speechSynthesis (long ones get cut off on iOS). */
	function chunks(text, max = 180) {
		const out = [];
		for (const s of String(text || "").match(/[^.!?;]+[.!?;]*\s*/g) || []) {
			let rest = s.trim();
			while (rest.length > max) {
				const cut = rest.lastIndexOf(",", max) > 40 ? rest.lastIndexOf(",", max) + 1 : rest.lastIndexOf(" ", max);
				out.push(rest.slice(0, cut > 0 ? cut : max).trim());
				rest = rest.slice(cut > 0 ? cut : max).trim();
			}
			if (rest) out.push(rest);
		}
		return out;
	}

	/** Earcons: short, distinct, learnable. [frequency Hz, duration ms, gain] steps. */
	const EARCONS = {
		listen: [[880, 70, 0.18]],
		heard: [[660, 60, 0.15], [990, 80, 0.15]],
		working: [[523, 45, 0.05]],
		attention: [[784, 110, 0.22], [0, 70, 0], [784, 110, 0.22]],
		done: [[523, 90, 0.16], [659, 90, 0.16], [784, 140, 0.16]],
		failed: [[440, 140, 0.18], [349, 220, 0.18]],
		off: [[660, 70, 0.14], [440, 110, 0.14]],
	};

	/**
	 * Tool activity worth a listener's attention (same rule as src/voice/speech.ts SIGNIFICANT):
	 * production, data, deployment, shared history, external services, money. Everything else
	 * pi does is its own business and is never spoken.
	 */
	const SIGNIFICANT =
		/\b(prod|production|deploy\w*|release|publish|migrat\w*|drop\s+(?:table|database|schema)|truncate|delete\s+from|update\s+\w+\s+set|rm\s+-\w*r\w*f|git\s+push|--force|reset\s+--hard|kubectl|helm|terraform\s+(?:apply|destroy)|tofu\s+(?:apply|destroy)|psql|mysql|mongosh?|redis-cli|database_url|aws\s|gcloud|az\s|ssh\s|scp\s|curl\s+-X\s*(?:POST|PUT|PATCH|DELETE)|npm\s+publish|docker\s+push|stripe|payment|send\w*\s+(?:mail|email|message))\b/i;
	const isSignificant = (text) => SIGNIFICANT.test(String(text || ""));

	/**
	 * Which session "switch to …" means. `list` items: { agent, name, cwd, task, machine }. Naming a
	 * computer ("the api session on the box") narrows to its sessions; the same best name on two
	 * computers is ambiguous, so the voice asks which one.
	 * Returns { match } | { ambiguous: [items] } | { none: true }.
	 */
	function matchSession(list, said) {
		const words = norm(said)
			.split(" ")
			.filter((w) => w.length > 1 && !["the", "on", "session", "to", "switch", "open", "go", "in", "at", "my"].includes(w));
		if (!words.length) return { none: true };
		const machineWords = (x) => norm(x.machine || "").split(" ").filter((w) => w.length > 1);
		const named = list.filter((x) => machineWords(x).some((w) => words.includes(w)));
		const pool = named.length ? named : list;
		const score = (x) => {
			const hay = norm(`${x.name} ${String(x.cwd || "").split("/").pop()} ${x.task || ""}`).split(" ");
			return words.filter((w) => hay.includes(w) || hay.some((h) => h.length > 3 && h.startsWith(w))).length;
		};
		const ranked = pool.map((x) => [x, score(x)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
		if (!ranked.length) return named.length === 1 ? { match: named[0] } : { none: true };
		const top = ranked.filter(([, s]) => s === ranked[0][1]).map(([x]) => x);
		const machines = new Set(top.map((x) => x.machine || ""));
		if (top.length > 1 && machines.size > 1) return { ambiguous: top };
		return { match: top[0] };
	}

	/**
	 * During the undo window ("Deploying to production, say stop to cancel"), what cancels the countdown: "stop"
	 * and "cancel" (about the voice elsewhere, never pi's work), "stop pi", and any no.
	 */
	function cancelsGrace(text) {
		const cmd = parseCommand(text)?.kind;
		return cmd === "stopPi" || cmd === "quiet" || /^(no|nope|cancel|wait|hold on|don't|do not|abort|stop)\b/.test(norm(text));
	}

	/** Commands that change voice settings, handled on the phone. */
	const SETTINGS = ["pushToTalk", "openMic", "eyesFree", "glance"];

	/**
	 * Where a long dictation is cut into chunks for the computer to recognise while you talk: at the
	 * first pause after `minMs` of audio, or at `maxMs` regardless, so a chunk ends between words where
	 * it can. `feed(rms, frameMs)` is true when the chunk should end after this frame.
	 */
	class Chunker {
		constructor(o = {}) {
			this.minMs = o.minMs ?? 10_000;
			this.maxMs = o.maxMs ?? 15_000;
			this.pauseMs = o.pauseMs ?? 300;
			this.vad = new Vad({ hangMs: this.pauseMs, minSpeechMs: 120 });
			this.t = 0;
			this.ms = 0;
			this.quietMs = 0;
		}
		feed(rms, frameMs) {
			this.t += frameMs;
			this.ms += frameMs;
			const quiet = rms <= this.vad.threshold();
			this.vad.feed(rms, this.t); // keeps the noise floor current
			this.quietMs = quiet ? this.quietMs + frameMs : 0;
			if (this.ms >= this.maxMs || (this.ms >= this.minMs && this.quietMs >= this.pauseMs)) {
				this.ms = 0;
				this.quietMs = 0;
				return true;
			}
			return false;
		}
	}

	const clock = (ms) => {
		const s = Math.max(0, Math.floor(ms / 1000));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	};

	/** A draft recording's time against its limit: "6:42 / 10:00", and from the warning on, how long is left. */
	function draftClock(elapsedMs, maxMs = 600_000, warnMs = 540_000) {
		const left = Math.max(0, Math.ceil((maxMs - elapsedMs) / 1000));
		return {
			time: `${clock(elapsedMs)} / ${clock(maxMs)}`,
			warn: elapsedMs >= warnMs,
			over: elapsedMs >= maxMs,
			left: elapsedMs >= warnMs ? `Stops at ${clock(maxMs)}, ${left} s left. Tap ✓ to finish.` : "",
		};
	}

	/**
	 * The phone's half of a draft's chunks (web/draft.js; the computer's half is pi-speech phone-drafts.ts).
	 * Each piece of audio gets its sequence number when it is cut and is sent on its own, in order, one at a
	 * time; a failed piece is retried by itself (never merged with newer audio), so a lost reply can't make
	 * the computer skip anything new: it hears each number once. The last piece goes with `finish` under the
	 * next unused number.
	 *
	 * The caller always keeps the whole recording; it is the fallback. `off`: no draft on this computer (an
	 * older pi-mobile, or `maxFails` failures in a row before the draft showed): the pieces are dropped and
	 * the recording is an ordinary dictation. `lost`: the computer lost a draft that is on screen (pi
	 * restarted, idle too long, too many drafts) or never took the rest of it.
	 *
	 * `call(method, params)` reaches the computer; `gone(e)` says an error means it has no such draft;
	 * `params()` adds elapsedMs/since to each chunk; `shown()` is true once the draft is on screen (its
	 * pieces are then kept through failures); `onStart(answer)`, `onView(answer)`, `onOff()` report back.
	 */
	class DraftUplink {
		constructor(o) {
			this.o = { params: () => ({}), shown: () => false, onStart() {}, onView() {}, onOff() {}, maxFails: 3, retryMs: 800, ...o };
			this.id = null;
			this.nextCut = 0;
			this.pieces = [];
			this.sending = null;
			this.fails = 0;
			this.off = false;
			this.lost = false;
			this.closed = false;
			this.finishing = false;
		}
		/** Still taking pieces. */
		get live() {
			return !this.off && !this.lost && !this.closed;
		}
		/** Something reached the computer, or is on its way. */
		get started() {
			return !!(this.id || this.sending || this.pieces.length);
		}
		/** A piece cut at a pause: numbered now, sent after the ones before it. */
		add(audio) {
			if (!this.live || this.finishing) return false;
			this.pieces.push({ seq: this.nextCut++, audio });
			void this.flush();
			return true;
		}
		/** Sends what is waiting, in order; stops at the first failure (the next piece cut retries it). */
		flush() {
			if (!this.sending)
				this.sending = (async () => {
					while (this.pieces.length && this.live && !this.finishing) if (!(await this.step())) break;
				})().finally(() => (this.sending = null));
			return this.sending;
		}
		/** The first waiting piece (opening the draft first): true once the computer has it. */
		async step() {
			const piece = this.pieces[0];
			if (!piece) return true;
			try {
				if (!this.id) {
					const s = await this.o.call("draftStart", {});
					// Closed while it opened: nobody will finish it.
					if (this.closed) {
						this.o.call("draftClose", { id: s.id, how: "discard" }).catch(() => {});
						return false;
					}
					this.id = s.id;
					this.o.onStart(s);
				}
				const r = await this.o.call("draftChunk", { id: this.id, seq: piece.seq, audio: piece.audio, mime: "audio/wav", ...this.o.params() });
				if (this.closed) return false;
				if (this.pieces[0] === piece) this.pieces.shift();
				this.fails = 0;
				this.o.onView(r);
				return true;
			} catch (e) {
				if (this.closed || !this.live) return false;
				if (this.o.gone(e)) this.giveUp(true);
				else if (++this.fails >= this.o.maxFails && !this.o.shown()) this.giveUp(false);
				return false;
			}
		}
		/** Stop sending and drop the pieces: the whole recording is the fallback. */
		giveUp(gone) {
			const shown = this.o.shown();
			if (shown) this.lost = true;
			else this.off = true;
			this.pieces = [];
			// A draft the computer still has: put away (kept on disk if it was on screen).
			if (this.id && !gone) this.o.call("draftClose", { id: this.id, how: shown ? "kept" : "discard" }).catch(() => {});
			this.o.onOff();
		}
		/**
		 * The recording ended: the waiting pieces (each retried up to `maxFails` times), then `draftFinish`
		 * with the rest under the next number. Returns { view } (its answer), { none } (no draft here: use
		 * the whole recording), { lost } (the draft on screen can't be finished: use the whole recording)
		 * or { closed } (the caller moved on).
		 */
		async finish(rest, params = {}) {
			this.finishing = true;
			await this.sending;
			const wait = () => new Promise((r) => setTimeout(r, this.o.retryMs));
			for (let tries = 0; this.pieces.length && this.live; ) {
				if (await this.step()) tries = 0;
				else if (!this.live) break;
				else if (++tries >= this.o.maxFails) this.giveUp(false);
				else await wait();
			}
			if (this.closed) return { closed: true };
			if (this.lost) return { lost: true };
			if (this.off || !this.id) return { none: true };
			const p = { id: this.id, seq: this.nextCut++, audio: rest || undefined, mime: "audio/wav", ...params };
			for (let tries = 1; ; tries++) {
				try {
					const r = await this.o.call("draftFinish", p);
					return this.closed ? { closed: true } : { view: r };
				} catch (e) {
					if (this.closed) return { closed: true };
					// Retried under the same number: if the computer heard it, it isn't heard twice.
					const gone = this.o.gone(e);
					if (gone || tries >= this.o.maxFails) {
						this.giveUp(gone);
						return this.lost ? { lost: true } : { none: true };
					}
					await wait();
				}
			}
		}
		/** The draft is closed or replaced: late answers are ignored. */
		close() {
			this.closed = true;
			this.pieces = [];
		}
	}

	/**
	 * Markdown typed by hand, as the draft's blocks, for showing it until the computer answers. The same
	 * split as pi-speech draft.ts `markdownBlocks` (the computer keeps these blocks): a heading is one
	 * block; a paragraph runs to the next blank line; a list item takes its continuation lines; a fenced
	 * code block runs to its closing fence, blank lines and all. `gap`: a blank line came before it.
	 */
	function markdownBlocks(text) {
		const kindOf = (l) => (/^#{1,6}\s/.test(l) ? "heading" : /^\s*([-*+]|\d+[.)])\s/.test(l) ? "item" : "para");
		const fenceOf = (l) => /^\s*(`{3,}|~{3,})/.exec(l)?.[1];
		const closes = (fence, l) => {
			const m = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
			return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
		};
		const out = [];
		let lines = [];
		let fence;
		let gap = false;
		let blank = false;
		const flush = () => {
			if (lines.length) out.push({ kind: kindOf(lines[0]), src: lines.join("\n"), gap });
			lines = [];
			fence = undefined;
		};
		const begin = (line) => {
			flush();
			gap = blank && out.length > 0;
			blank = false;
			lines = [line];
		};
		for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
			if (fence) {
				lines.push(line);
				if (closes(fence, line)) flush();
				continue;
			}
			if (!line.trim()) {
				flush();
				blank = true;
				continue;
			}
			const f = fenceOf(line);
			if (f) {
				begin(line);
				fence = f;
			} else if (kindOf(line) === "heading") {
				begin(line);
				flush();
			} else if (kindOf(line) === "item" || !lines.length) begin(line);
			else lines.push(line);
		}
		flush();
		return out;
	}

	const api = { HELP, SETTINGS, cancelsGrace, matchSession, isBackchannel, isEcho, parseCommand, answerFor, speakPrompt, isDestructive, requestNames, isSignificant, incomplete, Vad, Chunker, DraftUplink, markdownBlocks, draftClock, chunks, EARCONS, norm };
	globalThis.PiVoiceCore = api;
})();
