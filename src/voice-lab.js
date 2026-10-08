// Voice lab (voice-lab.html): tsukuyomi-chan through each of yomiage's voice presets, plus a Custom voice (sliders)
// for trying new settings, with a cleanliness score for each. Uses yomiage's synthesize(), so what you hear here is
// exactly what apps get. The voice files come from ./yomiage/ (`npm run yomiage:files`).
import { createVoice, toWav, PRESETS } from "yomiage";
import { harmonicsToNoise } from "./psola.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += msg + "\n"; el.scrollTop = el.scrollHeight; };
const status = (msg) => { $("status").textContent = msg; };
addEventListener("error", (e) => status(`Error: ${e.message}`));
addEventListener("unhandledrejection", (e) => status(`Error: ${e.reason?.message ?? e.reason}`));

const capital = (w) => w[0].toUpperCase() + w.slice(1);
const VOICES = [
  ...Object.entries(PRESETS).map(([id, p]) => ({ id, name: capital(id), values: [p.pitch, p.formant, p.breathReduction] })),
  { id: "custom", name: "Custom (sliders)" },
];
const valuesOf = (v) => v.values ?? [Number($("pitch").value), Number($("formant").value), Number($("breath").value)];

const voice = createVoice({ filesUrl: "./yomiage/" });
voice.on("log", log);
voice.on("progress", (p) => { if (p.stage !== "ready") status(`Loading the voice: ${p.stage} ${Math.round(p.fraction * 100)}%`); });

async function render(v) {
  const [pitch, formant, breathReduction] = valuesOf(v);
  if (voice.status === "not-loaded") await voice.load();
  const audio = await voice.synthesize($("text").value.trim(), { pitch, formant, breathReduction, speed: Number($("speed").value) });
  return { ...audio, hnr: harmonicsToNoise(audio.samples, audio.sampleRate) };
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

function downloadWav(audio, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(toWav(audio));
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
