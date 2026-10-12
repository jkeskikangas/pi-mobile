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

	const COMMANDS = [
		["stop", /^(?:stop|stop it|stop that|stop pi|cancel|cancel it|abort|halt|stop working|stop everything)$/],
		["repeat", /^(?:repeat|repeat that|say (?:that|it) again|again|what|sorry what|come again|pardon)$/],
		["status", /^(?:status|what's (?:it|pi|he) doing|what are you doing|what is it doing|how's it going|progress|where are we|are you done|is it done)$/],
		["shorter", /^(?:shorter|be (?:brief|briefer|terse|shorter)|too long|less detail)$/],
		["more", /^(?:more|tell me more|go on|details|more details|what else|continue|and)$/],
		["quiet", /^(?:quiet|be quiet|shush|shut up|silence|stop talking|enough)$/],
		["end", /^(?:end voice(?: mode)?|exit voice(?: mode)?|goodbye|bye|that's all|we're done|end call|hang up)$/],
		["help", /^(?:help|what can i say|what can you do|how does this work|commands)$/],
		["pushToTalk", /^(?:push to talk|hold to talk|tap to talk|walkie talkie)$/],
		["openMic", /^(?:open mic|open microphone|hands free|hands-free)$/],
		["eyesFree", /^(?:eyes free|eyes-free|i can't look|i cannot look|i'm driving)$/],
		["glance", /^(?:i can (?:look|glance|see the screen)|can glance|i'm at (?:a|the|my) screen)$/],
	];

	/** What "what can I say?" answers: a few things, spoken, not a manual. */
	const HELP =
		"Just talk to pi like a colleague. You can say: what's it doing; stop; tell me more; say that again; switch to another session. When pi asks something, answer out loud, or tap the card.";

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

	/** Commands that change voice settings, handled on the phone. */
	const SETTINGS = ["pushToTalk", "openMic", "eyesFree", "glance"];

	/**
	 * The likely next message worth offering out loud ("Next: …?"): the top candidate of a `suggestion`
	 * when its calibrated p is at least 0.7 (P_READ in src/suggest.ts), else null.
	 */
	function nextOffer(s) {
		const top = s?.candidates?.[0];
		return top && typeof top.text === "string" && top.text.trim() && top.p >= 0.7 ? top.text.trim() : null;
	}

	/** "3 files, tests pass": a prepared draft, said before you accept it. */
	function speakDraft(d) {
		if (!d) return "";
		const files = d.files === 1 ? "one file" : `${d.files} files`;
		return `There's a draft: ${files}${d.checks === "pass" ? ", tests pass" : d.checks === "fail" ? ", tests fail" : ""}.`;
	}

	/** "yes", "do that", "send it": the whole reply accepts the "Next: …?" just offered ("yes, but first …" doesn't). */
	const ACCEPT_NEXT = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay)\b ?)?(?:please ?)?(?:(?:do that|do it|send it|send that|go ahead|go for it|sounds good)\b ?)?(?:please)?$/;
	function acceptsNext(text) {
		const t = stripLead(norm(text));
		return !!t && ACCEPT_NEXT.test(t);
	}

	const api = { HELP, SETTINGS, nextOffer, speakDraft, acceptsNext, matchSession, isBackchannel, isEcho, parseCommand, answerFor, speakPrompt, isDestructive, requestNames, isSignificant, incomplete, Vad, chunks, EARCONS, norm };
	globalThis.PiVoiceCore = api;
})();
