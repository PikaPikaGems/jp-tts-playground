// Voice lab (voice-lab.html): tsukuyomi-chan through each of the playground's voice presets, plus a Custom voice
// (sliders) for trying new settings, with a cleanliness score for each. Local development only (uses the un-split
// model in models/). The voice change itself is exactly what the playground does (app.js).
import { PiperPlus } from "piper-plus";
import * as ort from "onnxruntime-web";
import { PATHS } from "./paths.js";
import { patchSpeakerEmbeddingDim } from "./piper-patch.js";
import { harmonicsToNoise, shiftVoicePsola, VOICE_SHIFT } from "./psola.js";
import { reduceBreathiness } from "./voicefx.js";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL(PATHS.ortDist, location.href).href;

const MODEL = "models/tsukuyomi/model.onnx";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += msg + "\n"; el.scrollTop = el.scrollHeight; };
const status = (msg) => { $("status").textContent = msg; };
// The heavy steps run on the main thread; give the browser a moment to repaint between them.
const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
addEventListener("error", (e) => status(`Error: ${e.message}`));
addEventListener("unhandledrejection", (e) => status(`Error: ${e.reason?.message ?? e.reason}`));

// [pitch st, formant st, de-hiss 0..1]; keep in sync with the preset menu in index.html.
const VOICES = [
  { id: "original", name: "Original", values: [0, 0, 0] },
  { id: "soft", name: "Soft", values: [-2, -0.5, 0.6] },
  { id: "low", name: "Low", values: [-6, -1.5, 0.6] },
  { id: "deep", name: "Deep", values: [-9, -4, 0.6] },
  { id: "deeper", name: "Deeper", values: [-11, -5.5, 0.6] },
  { id: "custom", name: "Custom (sliders)" },
];
const valuesOf = (v) => v.values ?? [Number($("pitch").value), Number($("formant").value), Number($("breath").value)];

let piper = null;
async function loadPiper() {
  if (piper) return piper;
  status("Loading the voice (first time: a few seconds, the page may pause)...");
  await breathe();
  const t0 = performance.now();
  piper = await PiperPlus.initialize({
    model: new URL(MODEL, location.href).href,
    ort,
    wasmG2pUrl: new URL(PATHS.piperRustWasm, location.href).href,
    onProgress: ({ message }) => log(message),
  });
  patchSpeakerEmbeddingDim(piper, ort, log);
  log(`Voice ready after ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  return piper;
}

/** Same steps as the playground: speak faster by the formant ratio, then PSOLA, then de-hiss. */
async function render(voice) {
  const [pitch, formant, dehiss] = valuesOf(voice);
  const ratio = 2 ** (formant / 12);
  const p = await loadPiper();
  const speed = Number($("speed").value) / ratio;
  const audio = await p.synthesize($("text").value.trim(), { language: "ja", lengthScale: 1 / speed });
  const sr = audio.sampleRate;
  const shifted = shiftVoicePsola(audio.samples, sr, pitch, formant, VOICE_SHIFT);
  const samples = await reduceBreathiness(shifted, sr, dehiss);
  return { samples, sampleRate: sr, hnr: harmonicsToNoise(samples, sr) };
}

const results = new Map(); // voice id -> { samples, sampleRate, hnr } | { error }

function draw() {
  const list = $("voices");
  list.replaceChildren();
  for (const v of VOICES) {
    const r = results.get(v.id);
    const li = document.createElement("li");
    if (current?.key === v.id) li.className = "playing";
    const btn = document.createElement("button");
    btn.className = "play";
    btn.textContent = current?.key === v.id ? "■" : "▶";
    btn.disabled = !r || !!r.error;
    btn.setAttribute("aria-label", `Play ${v.name}`);
    btn.onclick = () => toggle(v.id, r);
    const [pitch, formant, dehiss] = valuesOf(v);
    const label = document.createElement("div");
    label.innerHTML = `<div class="name">${v.name}</div><div class="meta">pitch ${pitch}, formants ${formant}, de-hiss ${dehiss}</div>`;
    const side = document.createElement("div");
    side.className = "side";
    if (r?.error) side.innerHTML = `<span class="err" title="${r.error.replace(/"/g, "&quot;")}">failed</span>`;
    else if (r) {
      side.textContent = `${r.hnr.toFixed(1)} dB`;
      const dl = document.createElement("a");
      dl.href = "#";
      dl.textContent = "WAV";
      dl.onclick = (e) => { e.preventDefault(); downloadWav(r, `${v.id}.wav`); };
      side.append(dl);
    } else side.textContent = "…";
    li.append(btn, label, side);
    list.append(li);
  }
}

let busy = false;
async function generate(voices) {
  if (busy) return;
  busy = true;
  $("generate").disabled = true;
  stop();
  const t0 = performance.now();
  try {
    for (const v of voices) results.delete(v.id);
    draw();
    for (const [i, v] of voices.entries()) {
      status(`Speaking ${i + 1} of ${voices.length}: ${v.name}...`);
      await breathe();
      try { results.set(v.id, await render(v)); }
      catch (e) { results.set(v.id, { error: e?.message ?? String(e) }); log(`${v.name}: ${e?.stack ?? e}`); }
      draw();
    }
    status(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s. Press ▶ to listen.`);
  } finally {
    busy = false;
    $("generate").disabled = false;
  }
}

// ---- playback: one at a time
let ctx = null, current = null;
function toggle(key, r) {
  if (current?.key === key) { stop(); draw(); return; }
  ctx ??= new AudioContext();
  ctx.resume();
  stop();
  const buf = ctx.createBuffer(1, r.samples.length, r.sampleRate);
  buf.copyToChannel(r.samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => { if (current?.src === src) { current = null; draw(); } };
  src.start();
  current = { key, src };
  draw();
}
function stop() {
  if (!current) return;
  const { src } = current;
  current = null;
  try { src.stop(); } catch { /* already ended */ }
}

function downloadWav({ samples, sampleRate: sr }, name) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---- controls
for (const [id, unit] of [["pitch", " st"], ["formant", " st"], ["breath", ""], ["speed", "×"]]) {
  const input = $(id), out = $(`${id}-out`);
  const show = () => { out.textContent = `${Number(input.value) > 0 && unit === " st" ? "+" : ""}${input.value}${unit}`; };
  input.addEventListener("input", () => { show(); draw(); });
  input.addEventListener("change", () => { if (results.size) generate(id === "speed" ? VOICES : [VOICES.at(-1)]); });
  show();
}
$("generate").addEventListener("click", () => generate(VOICES));
draw();

window.__lab = { results: () => [...results].map(([k, r]) => `${k}: ${r.error ?? `${r.samples.length} samples, HNR ${r.hnr.toFixed(1)} dB`}`) };
