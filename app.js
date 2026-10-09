import { createVoice, toWav, PRESETS, DEFAULTS } from "yomiage";
import { PATHS } from "./src/paths.js";
import { reduceBreathiness } from "./src/voicefx.js?v=34";
import { shiftVoicePsola, VOICE_SHIFT } from "./src/psola.js?v=34";
import { createAnalyzer } from "wakachi";
import { furigana, groupBunsetsu, posLabel, splitSentences as wakachiSentences } from "wakachi/text";

const $ = (id) => document.getElementById(id);

/** Sentences for study mode and speaking: wakachi's split, without pieces that have no letters or digits. */
const HAS_WORD = /[\p{L}\p{N}]/u;
const studySentences = (text) => wakachiSentences(text).map((s) => s.text).filter((t) => HAS_WORD.test(t));

// ------------------------------------------------------------ sentence split
// Split on sentence enders / newlines; break overlong sentences at 、 so each
// synthesis call stays small (keeps latency to first audio low).
const MAX_CHARS = 40;
function splitSentences(text) {
  const out = [];
  for (const s of studySentences(text)) { // sentence boundaries incl. English "." (shared with study mode)
    if (s.length <= MAX_CHARS) { out.push(s); continue; }
    let buf = "";
    for (const part of s.match(/[^、，,]+[、，,]?/g) ?? [s]) {
      if (buf && (buf + part).length > MAX_CHARS) { out.push(buf); buf = ""; }
      buf += part;
    }
    if (buf) out.push(buf);
  }
  return out;
}

// --------------------------------------------------------------- audio queue
let ctx = null;
let playing = new Set();
let generation = 0; // bumped by Stop to cancel in-flight speak() loops

/** Schedules chunks back-to-back so playback starts with the first one. */
class Playback {
  constructor() { this.next = 0; this.last = null; this.gen = generation; }
  async add(samples, sampleRate) {
    ctx ??= new AudioContext();
    await ctx.resume();
    const buf = ctx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.next = Math.max(this.next, ctx.currentTime + 0.05);
    src.start(this.next);
    this.next += buf.duration;
    playing.add(src);
    this.last = new Promise((resolve) => { src.onended = () => { playing.delete(src); resolve(); }; });
  }
  finished() { return this.last ?? Promise.resolve(); }
}

// ---------------------------------------------------------- language routing
// A sentence with letters but no kana/kanji (e.g. "Going to the gym!") is read by the browser's own voice by
// default: the Japanese voice models pronounce English with Japanese phonetics, which sounds very odd.
const JA_CHARS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;
const isForeign = (s) => !JA_CHARS.test(s) && /\p{L}/u.test(s);

function speakBrowser(text, { rate = 1, pitchSt = 0 } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = Math.min(2, Math.max(0.5, rate));
    u.pitch = Math.min(2, Math.max(0.1, 2 ** (pitchSt / 12)));
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

/**
 * iOS Safari only lets a page start audio from inside a user gesture. Speak handlers call this synchronously at
 * the top of the click (before any await/synthesis) so the AudioContext is created + resumed while the tap is
 * still "live"; a 1-sample silent buffer completes the unlock on older iOS versions.
 */
function unlockAudio(text = "") {
  // speechSynthesis has the same "must start inside a tap" rule on iOS: prime it when English text is coming
  if (text && /[A-Za-z]/.test(text) && "speechSynthesis" in window) {
    try { const u = new SpeechSynthesisUtterance(""); u.volume = 0; speechSynthesis.speak(u); } catch {}
  }
  ctx ??= new AudioContext();
  if (ctx.state !== "running") ctx.resume();
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {}
}

function stopAudio() {
  generation++;
  voice.stop();
  try { window.speechSynthesis?.cancel(); } catch {}
  for (const s of playing) { try { s.stop(); } catch {} }
  playing.clear();
}
$("stop").addEventListener("click", stopAudio);

function encodeWav(chunks, sampleRate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, "data"); view.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) {
    view.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

// ------------------------------------------------------------------- card UI
/** A panel's log, sliders (with their value labels) and Reset button, shared by both panels. */
function cardControls(id) {
  const root = $(id);
  const q = (sel) => root.querySelector(sel);
  const logEl = q(".log");
  const log = (m) => { logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; console.log(`[${id}] ${m}`); };
  const inputs = Object.fromEntries([...root.querySelectorAll("[data-p]")].map((el) => [el.dataset.p, el]));
  const defaults = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  const refresh = () => root.querySelectorAll("output[data-for]").forEach((o) => {
    const v = Number(inputs[o.dataset.for].value);
    o.textContent = o.dataset.for === "speed" ? `${v.toFixed(2)}×`
      : o.dataset.for === "pitch" || o.dataset.for === "formant" ? `${v > 0 ? "+" : ""}${v.toFixed(1)} st`
      : v.toFixed(2);
  });
  Object.values(inputs).forEach((el) => el.addEventListener("input", refresh));
  q(".reset").addEventListener("click", () => { for (const k in inputs) inputs[k].value = defaults[k]; refresh(); });
  refresh();
  const params = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)]));
  return { q, log, params };
}

/** The Style-BERT-VITS2 panel: synthesizes sentence by sentence in its worker and plays them back to back. */
function setupCard(id, engine) {
  const { q, log, params } = cardControls(id);
  const state = { ready: false, busy: false };
  const card = { state, onReady: null };

  q(".load").addEventListener("click", async () => {
    q(".load").disabled = true;
    q(".speak").disabled = true;
    state.ready = false;
    try {
      const t0 = performance.now();
      await engine.load(q(".model").value, log);
      state.ready = true;
      q(".speak").disabled = false;
      log(`Ready (loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s).`);
    } catch (err) {
      log(`ERROR loading: ${err.message}`);
      console.error(err);
    } finally {
      q(".load").disabled = false;
      card.onReady?.();
    }
  });

  // Synthesize sentence by sentence, playing as soon as the first is ready.
  // Resolves when playback ends (or Stop is pressed).
  card.speak = async (text, { interrupt = false, speedFactor = 1 } = {}) => {
    if (!state.ready) return;
    if (state.busy) {
      if (!interrupt) return;
      stopAudio(); // cancel the running loop, wait for it to wind down, then start the new text
      await state.busyDone;
    }
    state.busy = true;
    state.busyDone = new Promise((resolve) => { state.release = resolve; });
    q(".speak").disabled = true;
    const playback = new Playback();
    const sentences = splitSentences(text);
    const chunks = [];
    let rate = 0;
    try {
      log(`${sentences.length} sentence(s)`);
      const t0 = performance.now();
      const base = params();
      base.speed *= speedFactor; // study mode's 🐢 button passes 0.75
      if (base.pitch || base.formant) log(`Voice: pitch ${base.pitch} st, formants ${base.formant} st (PSOLA)`);
      for (const [i, sentence] of sentences.entries()) {
        if (playback.gen !== generation) { log("Stopped."); break; }
        const t1 = performance.now();
        const foreign = isForeign(sentence);
        if (foreign) {
          // Style-BERT-VITS2 only speaks Japanese: such a sentence is skipped, or read by the browser's own voice after
          // the queued audio (not part of the downloadable WAV)
          if ($("foreign-voice").value === "skip") { log(`#${i + 1} "${sentence.slice(0, 14)}${sentence.length > 14 ? "…" : ""}" is not Japanese -> skipped`); continue; }
          await playback.finished();
          if (playback.gen !== generation) { log("Stopped."); break; }
          log(`#${i + 1} "${sentence.slice(0, 14)}${sentence.length > 14 ? "…" : ""}" is not Japanese -> browser voice`);
          await speakBrowser(sentence, { rate: base.speed, pitchSt: base.pitch });
          continue;
        }
        // Voice shifting (src/psola.js): the formants are moved by resampling, which also slows the speech down by
        // `ratio`, so the model is asked to talk faster by the same factor first; PSOLA then sets the final pitch.
        const ratio = 2 ** (base.formant / 12);
        const synth = await engine.synth(sentence, { ...base, speed: base.speed / ratio });
        const sampleRate = synth.sampleRate;
        const shifted = shiftVoicePsola(synth.samples, sampleRate, base.pitch, base.formant, VOICE_SHIFT);
        const samples = await reduceBreathiness(shifted, sampleRate, base.breath);
        if (playback.gen !== generation) { log("Stopped."); break; }
        const ms = performance.now() - t1;
        const dur = samples.length / sampleRate;
        log(`#${i + 1} "${sentence.slice(0, 14)}${sentence.length > 14 ? "…" : ""}" ${(ms / 1000).toFixed(2)}s -> ${dur.toFixed(2)}s audio (RTF ${(ms / 1000 / dur).toFixed(2)})` +
            (i === 0 ? ` | first audio after ${((performance.now() - t0) / 1000).toFixed(2)}s` : ""));
        chunks.push(samples); rate = sampleRate;
        await playback.add(samples, sampleRate);
      }
      if (chunks.length) {
        log(`All synthesized in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
        const a = q(".download");
        if (a.href) URL.revokeObjectURL(a.href);
        a.href = URL.createObjectURL(encodeWav(chunks, rate));
        a.download = `${id}.wav`;
        a.hidden = false;
      }
      await playback.finished();
    } catch (err) {
      log(`ERROR synthesizing: ${err.message}`);
      console.error(err);
    } finally {
      state.busy = false;
      state.release?.();
      q(".speak").disabled = false;
    }
  };
  q(".speak").addEventListener("click", () => { unlockAudio($("text").value); card.speak($("text").value.trim()); });
  return card;
}

// --------------------------------------------------------------- piper-plus panel (yomiage)
// yomiage (github.com/PikaPikaGems/yomiage) runs piper-plus with the tsukuyomi-chan voice in a worker, applies the
// voice presets, splits the text into sentences and plays them. Its files are in ./yomiage/ (`npm run yomiage:files`).
const voice = createVoice({ filesUrl: "./yomiage/" });
const mb = (n) => (n / 1e6).toFixed(1);

function setupPiperCard() {
  const { q, log, params } = cardControls("piper");
  const state = { ready: false, busy: false };
  const card = { state, onReady: null };
  // the panel's sliders, as yomiage settings
  const settings = (speedFactor = 1) => {
    const p = params();
    return {
      speed: p.speed * speedFactor, pitch: p.pitch, formant: p.formant, breathReduction: p.breath,
      expressiveness: p.noise, rhythmVariation: p.noiseW, otherLanguages: $("foreign-voice").value,
    };
  };

  voice.on("log", (m) => log(m));
  voice.on("status", (s) => log(`status: ${s}`));
  voice.info().then(({ cached, downloadMB }) => log(cached ? "The voice files are on this device." : `Loading downloads ${downloadMB} MB once.`)).catch(() => {});

  const box = q(".loading");
  voice.on("progress", (p) => {
    box.hidden = false;
    box.querySelector("progress").value = p.fraction;
    box.querySelector(".stage").textContent = p.stage === "downloading" ? `Downloading voice… ${mb(p.loaded)} / ${mb(p.total)} MB`
      : p.stage === "preparing" ? `Preparing voice… ${Math.round(p.fraction * 100)}%` : "Ready";
    box.querySelector(".step").textContent = p.step === "ready" ? "" : `${p.step}${p.file ? ` · ${p.file}` : ""}${p.parts > 1 ? ` part ${p.part}/${p.parts}` : ""}`;
  });

  q(".load").addEventListener("click", async () => {
    q(".load").disabled = true;
    try {
      const { fromCache, ms, timings } = await voice.load();
      state.ready = true;
      q(".speak").disabled = false;
      if (ms !== undefined) {
        log(`Ready: ${fromCache ? "from this device" : "downloaded"} in ${(ms / 1000).toFixed(1)} s. Slowest steps:`);
        for (const t of [...timings].sort((x, y) => y.ms - x.ms).slice(0, 4)) log(`  ${String(t.ms).padStart(6)} ms  ${t.step}${t.file ? ` ${t.file}` : ""}`);
      } else log("Ready.");
    } catch (err) {
      log(`ERROR loading: ${err.code ?? err.name}: ${err.message}`);
      console.error(err);
    } finally {
      q(".load").disabled = false;
      setTimeout(() => { box.hidden = true; }, 1500);
      card.onReady?.();
    }
  });

  // Resolves when playback ends (or is stopped). A new speak() stops the current one when `interrupt` is set
  // (study mode); otherwise it is ignored while speaking, like the other panel.
  let seq = 0, last = null;
  card.speak = async (text, { interrupt = false, speedFactor = 1 } = {}) => {
    if (!state.ready || !text || (state.busy && !interrupt)) return;
    const mine = ++seq;
    const s = settings(speedFactor);
    state.busy = true;
    q(".speak").disabled = true;
    const t0 = performance.now();
    let first = true;
    try {
      const result = await voice.speak(text, {
        ...s,
        onSentence: (sentence) => {
          if (first) { first = false; log(`first sound after ${((performance.now() - t0) / 1000).toFixed(2)} s`); }
          log(`▶ ${sentence.text}`);
        },
      });
      log(result === "done" ? `Done (${((performance.now() - t0) / 1000).toFixed(1)} s).` : "Stopped.");
      last = { text, settings: s };
      q(".download").hidden = false;
    } catch (err) {
      log(`ERROR speaking: ${err.code ?? err.name}: ${err.message}`);
      console.error(err);
    } finally {
      if (mine === seq) { state.busy = false; q(".speak").disabled = false; }
    }
  };
  q(".speak").addEventListener("click", () => card.speak($("text").value.trim()));

  // the WAV of the last text spoken, made on demand (yomiage plays without keeping the audio)
  q(".download").addEventListener("click", async (e) => {
    e.preventDefault();
    if (!last) return;
    const a = q(".download");
    a.textContent = "WAV…";
    try {
      const url = URL.createObjectURL(toWav(await voice.synthesize(last.text, last.settings)));
      Object.assign(document.createElement("a"), { href: url, download: "piper.wav" }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { log(`ERROR making the WAV: ${err.message}`); }
    finally { a.textContent = "WAV"; }
  });
  return card;
}

// -------------------------------------------------- sbv2 engine (Web Worker)
// All heavy work (2 ONNX sessions, ~500MB) lives in a worker so the page never freezes.
let worker = null;
let nextId = 1;
const pending = new Map();
function callWorker(msg, onLog) {
  worker ??= (() => {
    const w = new Worker("./dist/sbv2-worker.js", { type: "module" });
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === "log") p.onLog?.(data.msg);
      else { pending.delete(data.id); data.type === "error" ? p.reject(new Error(data.message)) : p.resolve(data); }
    };
    w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || "worker crashed")); pending.clear(); };
    return w;
  })();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onLog });
    worker.postMessage({ id, ...msg });
  });
}
const sbv2Engine = {
  async load(acousticFile, log) {
    await callWorker({
      type: "load",
      acousticFile,
      baseUrl: location.href,
      acousticDir: "models/sbv2-tsukuyomi",
      sharedDir: "models/sbv2-shared",
    }, log);
  },
  async synth(text, p) {
    const r = await callWorker({
      type: "synth",
      text,
      scalars: { lengthScale: 1 / p.speed, noiseScale: p.noise, noiseScaleW: p.noiseW, sdpRatio: p.sdp },
    });
    return { samples: r.samples, sampleRate: r.sampleRate };
  },
};

// Voice presets come from yomiage; the menu sets Pitch, Voice size and Breathiness reduction on both panels.
const capital = (w) => w[0].toUpperCase() + w.slice(1);
for (const name of Object.keys(PRESETS)) $("preset").append(new Option(capital(name), name));
function applyPreset(name) {
  const p = PRESETS[name];
  for (const id of ["piper", "sbv2"]) {
    for (const [k, v] of [["pitch", p.pitch], ["formant", p.formant], ["breath", p.breathReduction]]) {
      const el = document.querySelector(`#${id} [data-p=${k}]`);
      el.value = v;
      el.dispatchEvent(new Event("input"));
    }
  }
}
$("preset").value = DEFAULTS.preset;
applyPreset(DEFAULTS.preset); // before the panels read their Reset values
document.querySelector("#piper [data-p=speed]").value = DEFAULTS.speed;
$("preset").addEventListener("change", (e) => applyPreset(e.target.value));

// The Style-BERT-VITS2 panel needs ~500 MB of local model files, so the hosted build leaves it out (see README).
const cards = [setupPiperCard()];
if (PATHS.sbv2) cards.push(setupCard("sbv2", sbv2Engine));
else {
  $("sbv2").hidden = true;
  $("speak-both").hidden = true;
  $("title-engines").textContent = "piper-plus";
}

// "Speak both" runs the engines sequentially (they'd fight over CPU otherwise).
const both = $("speak-both");
const refreshBoth = () => { both.disabled = !cards.every((c) => c.state.ready); };
cards.forEach((c) => { c.onReady = refreshBoth; });
both.addEventListener("click", async () => {
  unlockAudio($("text").value); // must run synchronously inside the tap (iOS)
  const text = $("text").value.trim();
  if (!text) return;
  both.disabled = true;
  const gen = generation;
  for (const c of cards) { if (gen !== generation) break; await c.speak(text); }
  refreshBoth();
});

// ---------------------------------------------------- reading view (wakachi)
// Furigana + bunsetsu spacing + dictionary-form popover for whatever is in the shared textarea. wakachi runs Sudachi
// in a worker, frees its memory after idleTimeout without use and reloads it from the device on the next edit by
// itself. `?idle=5` in the URL shortens the delay for testing.
const IDLE_MS = Number(new URLSearchParams(location.search).get("idle") ?? 60) * 1000;
const analyzer = createAnalyzer({ filesUrl: "./wakachi/", idleTimeout: IDLE_MS });
const reader = { wanted: false, seq: 0, timer: null, ctrl: null };
const readerStatus = (m) => { $("reader-status").textContent = m; };
const readerLog = (m) => { const el = $("reader-log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };
const READY_HINT = "Analyzer ready. Hover or click a bunsetsu for its dictionary form.";
analyzer.on("status", (s) => {
  if (s === "stopped" && reader.wanted) {
    readerLog(`Analyzer stopped after ${IDLE_MS / 1000}s idle to free memory. It reloads from the device on your next edit.`);
    readerStatus("Analyzer stopped (idle) - edit the text to wake it. Hover or click a bunsetsu for its dictionary form.");
  }
  if (s === "ready" && reader.wanted) readerStatus(READY_HINT);
});
analyzer.on("progress", (p) => {
  $("reader-progress").hidden = p.stage === "ready";
  $("reader-progress").value = p.fraction;
  if (p.stage === "downloading") readerStatus(`Downloading the dictionary… ${(p.loaded / 1e6).toFixed(0)} / ${(p.total / 1e6).toFixed(0)} MB`);
  else if (p.stage === "preparing") readerStatus(`Preparing the dictionary… ${Math.round(p.fraction * 100)}%`);
});

// colour key for a head word, by wakachi's part of speech (null = no colour)
const POS_COLOR = { "名詞": "noun", "代名詞": "pronoun", "動詞": "verb", "形容詞": "adj", "形状詞": "adjnoun",
  "副詞": "adverb", "連体詞": "adnominal", "接続詞": "conj", "感動詞": "interj" };

function renderReader(lines, sentences = null) {
  const out = $("reader-out");
  out.replaceChildren();
  for (const [idx, words] of lines.entries()) {
    const line = document.createElement("div");
    line.className = sentences ? "line study" : "line";
    if (sentences?.[idx]) {
      // two buttons per sentence: 🔊 at the selected speed, 🐢 at 0.75x of it
      for (const [icon, factor, title] of [
        ["🔊", 1, "Read this sentence aloud at the selected speed (click again to stop)"],
        ["🐢", 0.75, "Read it slowly: 0.75× the selected speed (click again to stop)"],
      ]) {
        const say = document.createElement("button");
        say.type = "button";
        say.className = "say";
        say.textContent = icon;
        say.title = title;
        say.setAttribute("aria-label", `${factor === 1 ? "Read aloud" : "Read slowly"}: ${sentences[idx]}`);
        say._text = sentences[idx];
        say._factor = factor;
        line.append(say);
      }
    }
    for (const group of groupBunsetsu(words)) {
      const span = document.createElement("span");
      span.className = "bun";
      span.tabIndex = 0;
      for (const w of group.morphemes) {
        const part = document.createElement("span"); // main word(s) of the bunsetsu get their own colour
        if (group.head.includes(w)) {
          // colour by the part of speech of the main word (a leading prefix shares its word's colour)
          const key = POS_COLOR[group.head.at(-1).pos];
          part.className = "head";
          if (key) part.dataset.pos = key;
        }
        for (const seg of furigana(w)) {
          if (seg.reading) {
            const ruby = document.createElement("ruby");
            ruby.append(seg.text);
            const rt = document.createElement("rt");
            rt.textContent = seg.reading;
            ruby.append(rt);
            part.append(ruby);
          } else part.append(seg.text);
        }
        span.append(part);
      }
      span._group = group;
      line.append(span);
    }
    out.append(line);
  }
}

// ---- popover (built with DOM APIs / textContent only: the text is user-supplied)
const pop = $("pop");
let pinned = null;
// The popover stays open briefly after the pointer leaves a phrase so the mouse can travel onto its buttons.
let hideTimer = null;
const cancelHide = () => { clearTimeout(hideTimer); hideTimer = null; };
const scheduleHide = () => { if (pinned) return; cancelHide(); hideTimer = setTimeout(() => { if (!pinned) { pop.hidden = true; markShown(null); } }, 250); };
const HAS_TEXT = /[\p{L}\p{N}]/u;
/** The phrase as written, without trailing punctuation (so the voice doesn't pause on a trailing 、). */
function phraseText(g) {
  const ws = [...g.morphemes];
  while (ws.length > 1 && ["補助記号", "記号"].includes(ws.at(-1).pos)) ws.pop();
  return ws.map((w) => w.surface).join("");
}

let shownSpan = null; // phrase whose popover is open: keep its furigana visible even in hover-only mode
function markShown(span) { shownSpan?.classList.remove("showing"); shownSpan = span; span?.classList.add("showing"); }

function showPop(span) {
  cancelHide();
  markShown(span);
  const g = span._group;
  pop.replaceChildren();
  const lbl = (t) => { const d = document.createElement("div"); d.className = "lbl"; d.textContent = t; return d; };
  const dict = document.createElement("div");
  dict.className = "dict";
  dict.textContent = g.headDictionaryForm;
  pop.append(lbl("Dictionary form"), dict);
  // 🔊 buttons: the main word (spoken in dictionary form, e.g. 歩い → 歩く) and the whole phrase as written
  const actions = document.createElement("div");
  actions.className = "pop-actions";
  for (const [label, text] of [["Word", g.headDictionaryForm], ["Phrase", phraseText(g)]]) {
    if (!HAS_TEXT.test(text)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "say";
    b._text = text;
    b.textContent = `🔊 ${label}: ${text}`;
    b.title = `Speak "${text}"`;
    actions.append(b);
  }
  const msg = document.createElement("div");
  msg.className = "pop-msg";
  pop.append(actions, msg);
  const normHead = g.head.map((w) => w.normalizedForm || w.surface).join("");
  if (normHead !== g.headDictionaryForm) pop.append(lbl(`Normalized: ${normHead}`));
  const ul = document.createElement("ul");
  for (const w of g.morphemes) {
    const li = document.createElement("li");
    li.append(`${w.surface} → ${w.dictionaryForm || w.surface} `);
    const pos = document.createElement("div");
    pos.className = "pos";
    pos.textContent = `${posLabel(w)} — ${posLabel(w, "en")}`;
    li.append(pos);
    ul.append(li);
  }
  pop.append(lbl("Parts"), ul);
  pop.hidden = false;
  const r = span.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${window.scrollY + r.bottom + 6}px`;
}
function hidePop() { cancelHide(); pop.hidden = true; markShown(null); pinned?.classList.remove("pinned"); pinned = null; }
pop.addEventListener("mouseenter", cancelHide);
pop.addEventListener("mouseleave", scheduleHide);
pop.addEventListener("click", (e) => { const b = e.target.closest(".say"); if (b) speakStudy(b); });
const readerOut = $("reader-out");
readerOut.addEventListener("mouseover", (e) => { const s = e.target.closest(".bun"); if (s && !pinned) showPop(s); });
readerOut.addEventListener("mouseout", (e) => { if (e.target.closest(".bun")) scheduleHide(); });
readerOut.addEventListener("focusin", (e) => { const s = e.target.closest(".bun"); if (s && !pinned) showPop(s); });
readerOut.addEventListener("click", (e) => {
  const say = e.target.closest(".say");
  if (say) { speakStudy(say); return; }
  const s = e.target.closest(".bun");
  if (!s) return hidePop();
  if (pinned === s) return hidePop();
  pinned?.classList.remove("pinned");
  pinned = s;
  s.classList.add("pinned");
  showPop(s);
  e.stopPropagation();
});
document.addEventListener("click", (e) => { if (pinned && !e.target.closest("#pop")) hidePop(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hidePop(); });

async function refreshReader() {
  if (!reader.wanted) return; // user hasn't clicked "Load analyzer" yet
  const mySeq = ++reader.seq;
  reader.ctrl?.abort(); // a newer edit replaces the previous analysis
  const ctrl = (reader.ctrl = new AbortController());
  try {
    // Study mode analyzes one sentence per line so every line gets its own 🔊 button.
    const sentences = $("study-mode").checked ? studySentences($("text").value) : null;
    const lines = sentences ?? $("text").value.split("\n");
    const results = await analyzer.analyzeMany(lines, { signal: ctrl.signal });
    if (mySeq !== reader.seq) return;
    hidePop();
    renderReader(results, sentences);
  } catch (err) {
    if (err.name !== "AbortError" && mySeq === reader.seq) { readerLog(`ERROR analyzing: ${err.code ?? err.name}: ${err.message}`); console.error(err); }
  }
}
$("text").addEventListener("input", () => { clearTimeout(reader.timer); reader.timer = setTimeout(refreshReader, 300); });

$("reader-load").addEventListener("click", async () => {
  const btn = $("reader-load");
  btn.disabled = true;
  try {
    readerStatus("Loading analyzer...");
    const { fromCache, ms } = await analyzer.load();
    reader.wanted = true;
    readerLog(`Ready (${((ms ?? 0) / 1000).toFixed(1)}s, ${fromCache ? "from this device" : "downloaded"}).`);
    readerStatus(READY_HINT);
    await refreshReader();
  } catch (err) {
    readerLog(`ERROR loading: ${err.code ?? err.name}: ${err.message}`);
    readerStatus(err.code === "unavailable" ? "The analyzer crashed this tab before, so it isn't loaded again for a few days." : "Could not load the analyzer (see the log).");
    console.error(err);
  } finally { btn.disabled = false; }
});
analyzer.on("log", (m) => readerLog(m));


// ---- study mode: 🔊 per sentence (uses piper if loaded, else Style-Bert-VITS2, with that panel's voice settings)
let studyCurrent = null;
async function speakStudy(btn) {
  unlockAudio(btn._text); // synchronously inside the tap (iOS)
  const card = cards.find((c) => c.state.ready); // cards = [piper, sbv2]
  if (!card) {
    const m = "Load a voice model first (Load model in the piper-plus panel), then press 🔊.";
    readerStatus(m);
    const box = btn.closest("#pop")?.querySelector(".pop-msg");
    if (box) box.textContent = m;
    return;
  }
  if (studyCurrent === btn && card.state.busy) { stopAudio(); return; } // second click = stop
  studyCurrent?.classList.remove("speaking");
  studyCurrent = btn;
  btn.classList.add("speaking");
  try { await card.speak(btn._text, { interrupt: true, speedFactor: btn._factor ?? 1 }); }
  finally { if (studyCurrent === btn) { btn.classList.remove("speaking"); studyCurrent = null; } }
}

// ---- preferences (remembered per browser; storage may be unavailable, e.g. private mode)
const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
$("study-mode").checked = pref.get("studyMode", "0") === "1";
$("study-mode").addEventListener("change", () => { pref.set("studyMode", $("study-mode").checked ? "1" : "0"); refreshReader(); });
$("color-mode").value = pref.get("colorMode", "pos");
const applyColorMode = () => { $("reader").dataset.color = $("color-mode").value; pref.set("colorMode", $("color-mode").value); };
$("color-mode").addEventListener("change", applyColorMode);
applyColorMode();

$("furi-always").checked = pref.get("furiAlways", "1") === "1";
const applyFuri = () => { $("reader").dataset.furi = $("furi-always").checked ? "always" : "hover"; pref.set("furiAlways", $("furi-always").checked ? "1" : "0"); };
$("furi-always").addEventListener("change", applyFuri);
applyFuri();

$("foreign-voice").value = pref.get("foreignVoice", "read") === "skip" ? "skip" : "read"; // older values: "browser", "model"
$("foreign-voice").addEventListener("change", () => pref.set("foreignVoice", $("foreign-voice").value));