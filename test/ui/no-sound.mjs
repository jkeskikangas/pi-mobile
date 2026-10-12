// No sound from any browser harness (test/ui/shots.mjs, test/e2e/*.mjs), ever: whoever runs them may be
// in a call on headphones. Chrome's --mute-audio does not cover speechSynthesis on macOS (the OS speech
// service renders it outside Chrome's audio pipeline), so every page gets this before its own scripts:
//
// - speechSynthesis and SpeechSynthesisUtterance are replaced: nothing is spoken; each utterance still
//   fires start then end (error "canceled" when cancelled), in order, so the flows advance; getVoices()
//   is a fixed list.
// - <audio>/<video> are always muted underneath (play(), src, srcObject, new Audio(), autoplay), while
//   `muted` reads back what the page set.
// - Web Audio reaches the speakers only through a gain of 0.
//
// Puppeteer: `await page.evaluateOnNewDocument(NO_SOUND)`; Playwright: `await context.addInitScript({ content: NO_SOUND })`.
// After every navigation: `await assertNoSound(page)` (throws when the stub is missing).

function noSound() {
	if (window.__piNoSound) return;
	const mark = (f) => Object.defineProperty(f, "__piStub", { value: true });

	// ── speech ──
	const VOICES = [
		{ name: "Samantha", lang: "en-US", default: true, localService: true, voiceURI: "stub-samantha" },
		{ name: "Daniel", lang: "en-GB", default: false, localService: true, voiceURI: "stub-daniel" },
	];
	class Utterance extends EventTarget {
		constructor(text = "") {
			super();
			Object.assign(this, { text: String(text), lang: "", voice: null, pitch: 1, rate: 1, volume: 1 });
			for (const t of ["start", "end", "error", "pause", "resume", "boundary", "mark"]) this[`on${t}`] = null;
		}
	}
	mark(Utterance);
	const fire = (u, type, extra = {}) => {
		const ev = Object.assign(new Event(type), { utterance: u, charIndex: 0, elapsedTime: 0, name: "" }, extra);
		try {
			u[`on${type}`]?.call(u, ev);
		} catch (e) {
			setTimeout(() => {
				throw e;
			});
		}
		u.dispatchEvent(ev);
	};
	const queue = [];
	let current = null;
	let timer = 0;
	const synth = new EventTarget();
	const next = () => {
		if (current || synth.paused || !queue.length) return;
		current = queue.shift();
		const u = current;
		timer = setTimeout(() => {
			fire(u, "start");
			const words = String(u.text).split(/\s+/).filter(Boolean).length;
			timer = setTimeout(() => {
				if (current !== u) return;
				current = null;
				fire(u, "end", { elapsedTime: words * 60 });
				next();
			}, Math.max(120, words * 60));
		});
	};
	Object.defineProperties(synth, {
		speaking: { get: () => !!current },
		pending: { get: () => queue.length > 0 },
	});
	Object.assign(synth, {
		paused: false,
		onvoiceschanged: null,
		speak: mark((u) => {
			queue.push(u);
			next();
		}),
		cancel: mark(() => {
			clearTimeout(timer);
			const gone = [current, ...queue].filter(Boolean);
			current = null;
			queue.length = 0;
			for (const u of gone) setTimeout(() => fire(u, "error", { error: "canceled" }));
		}),
		pause: mark(() => {
			synth.paused = true;
		}),
		resume: mark(() => {
			synth.paused = false;
			next();
		}),
		getVoices: mark(() => VOICES.map((v) => ({ ...v }))),
	});
	mark(synth);
	Object.defineProperty(window, "speechSynthesis", { configurable: true, get: () => synth });
	Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: Utterance });

	// ── media elements ──
	const M = HTMLMediaElement.prototype;
	const muted = Object.getOwnPropertyDescriptor(M, "muted");
	const hush = (el) => {
		muted.set.call(el, true);
		return el;
	};
	Object.defineProperty(M, "muted", {
		configurable: true,
		get() {
			return this.__wantMuted ?? false;
		},
		set(v) {
			this.__wantMuted = !!v;
			hush(this);
		},
	});
	for (const prop of ["src", "srcObject"]) {
		const d = Object.getOwnPropertyDescriptor(M, prop);
		Object.defineProperty(M, prop, {
			configurable: true,
			get() {
				return d.get.call(this);
			},
			set(v) {
				hush(this);
				d.set.call(this, v);
			},
		});
	}
	const play = M.play;
	M.play = mark(function () {
		hush(this);
		return play.call(this);
	});
	const RealAudio = window.Audio;
	window.Audio = mark(
		new Proxy(RealAudio, {
			construct: (T, args) => hush(Reflect.construct(T, args)),
		}),
	);
	// Autoplay and anything else in the document (also elements from the HTML parser).
	new MutationObserver((records) => {
		for (const r of records)
			for (const n of r.addedNodes) {
				if (n instanceof HTMLMediaElement) hush(n);
				if (n.querySelectorAll) for (const m of n.querySelectorAll("audio, video")) hush(m);
			}
	}).observe(document, { childList: true, subtree: true });
	document.addEventListener("play", (e) => e.target instanceof HTMLMediaElement && hush(e.target), true);
	document.addEventListener("loadstart", (e) => e.target instanceof HTMLMediaElement && hush(e.target), true);

	// ── Web Audio ──
	const connect = AudioNode.prototype.connect;
	const sinks = new WeakMap();
	AudioNode.prototype.connect = mark(function (target, ...rest) {
		if (typeof AudioDestinationNode !== "undefined" && target instanceof AudioDestinationNode) {
			let zero = sinks.get(target);
			if (!zero) {
				zero = target.context.createGain();
				zero.gain.value = 0;
				connect.call(zero, target);
				sinks.set(target, zero);
			}
			connect.call(this, zero, ...rest);
			return target;
		}
		return connect.call(this, target, ...rest);
	});

	/** For the harness's check: what the element really does underneath. */
	window.__piReallyMuted = (el) => muted.get.call(el);
	window.__piNoSound = true;
}

export const NO_SOUND = `(${noSound})();`;

/** Throws unless the page runs with the stub (call after every navigation). */
export async function assertNoSound(page) {
	const ok = await page.evaluate(
		() =>
			window.__piNoSound === true &&
			window.speechSynthesis?.__piStub === true &&
			window.speechSynthesis.speak.__piStub === true &&
			window.SpeechSynthesisUtterance.__piStub === true &&
			HTMLMediaElement.prototype.play.__piStub === true &&
			window.Audio.__piStub === true &&
			AudioNode.prototype.connect.__piStub === true &&
			(() => {
				const a = new Audio();
				a.muted = false;
				const v = document.createElement("video");
				v.muted = false;
				return a.muted === false && window.__piReallyMuted(a) === true && window.__piReallyMuted(v) === true;
			})(),
	);
	if (!ok) throw new Error("no-sound stub missing from the page: refusing to go on (speech or audio could reach the speakers)");
}
