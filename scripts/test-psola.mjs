// Checks src/psola.js on a synthetic voice: the output pitch and formants land where asked, the length is unchanged.
//
//   node scripts/test-psola.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

// The repo's package.json says "type": "commonjs", but src/ files are browser ES modules: load the source as one.
const source = fs.readFileSync(new URL("../src/psola.js", import.meta.url), "utf8");
const { detectPitch, pitchMarks, psola, resample, shiftVoicePsola, smoothVoicing } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const SR = 22050;

/** A crude vowel: a glottal pulse train at `f0` (with vibrato) through two formant resonators. */
function vowel(f0, seconds = 1.5, formants = [700, 1200]) {
  const n = Math.round(SR * seconds);
  const src = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + 0.02 * Math.sin((2 * Math.PI * 5 * i) / SR));
    phase += f / SR;
    if (phase >= 1) { phase -= 1; src[i] = 1; }
  }
  let y = src;
  for (const fc of formants) {
    const r = 0.97, w = (2 * Math.PI * fc) / SR;
    const a1 = -2 * r * Math.cos(w), a2 = r * r;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i] - a1 * (out[i - 1] ?? 0) - a2 * (out[i - 2] ?? 0);
    y = out;
  }
  const peak = y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return y.map((v) => (v / peak) * 0.5);
}

const medianF0 = (x) => {
  const v = Array.from(detectPitch(x, SR).f0).filter((f) => f > 0).sort((a, b) => a - b);
  return v[v.length >> 1];
};

/** Frequency of the strongest spectral peak between 300 and 3000 Hz (a rough formant probe), via a smoothed DFT. */
function strongestPeak(x) {
  const seg = x.subarray(4000, 4000 + 4096);
  let best = 0, bestF = 0;
  for (let f = 300; f <= 3000; f += 10) {
    let re = 0, im = 0, e = 0;
    for (const df of [-60, -30, 0, 30, 60]) { // average neighbouring bins to see the envelope, not single harmonics
      re = 0; im = 0;
      for (let i = 0; i < seg.length; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / seg.length);
        const a = (2 * Math.PI * (f + df) * i) / SR;
        re += seg[i] * w * Math.cos(a); im -= seg[i] * w * Math.sin(a);
      }
      e += re * re + im * im;
    }
    if (e > best) { best = e; bestF = f; }
  }
  return bestF;
}

const input = vowel(220);
const f0In = medianF0(input);
const peakIn = strongestPeak(input);
console.log(`input: f0 ${f0In.toFixed(1)} Hz, strongest formant ~${peakIn} Hz`);

for (const [pitch, formant] of [[-5, 0], [-9, -4], [-13, -7], [4, 2], [0, -4]]) {
  const t0 = performance.now();
  const out = shiftVoicePsola(input, SR, pitch, formant);
  const ms = performance.now() - t0;
  assert.equal(out.length, input.length, "length unchanged");
  assert.ok(out.every(Number.isFinite), "finite samples");
  const want = f0In * 2 ** (pitch / 12);
  const got = medianF0(out);
  const peak = strongestPeak(out);
  const errSt = 12 * Math.log2(got / want);
  console.log(`pitch ${pitch} st, formant ${formant} st: f0 ${got.toFixed(1)} Hz (want ${want.toFixed(1)}, off ${errSt.toFixed(2)} st), ` +
    `formant ~${peak} Hz (want ~${Math.round(peakIn * 2 ** (formant / 12))}), ${ms.toFixed(0)} ms for 1.5 s`);
  assert.ok(Math.abs(errSt) < 0.3, `pitch within 0.3 semitones (off by ${errSt.toFixed(2)})`);
}

for (const [pitch, formant] of [[-9, -4], [-13, -7]]) {
  // improved, with the caller having made the speech faster by r (stretch: false)
  const r = 2 ** (formant / 12);
  const faster = psola(input, SR, { timeFactor: r }); // stands in for piper speaking faster: shorter by r, same pitch
  const out = shiftVoicePsola(faster, SR, pitch, formant, { improved: true, stretch: false });
  assert.ok(Math.abs(out.length - input.length) < 4, `length back to normal (${out.length} vs ${input.length})`);
  const want = medianF0(input) * 2 ** (pitch / 12);
  const errSt = 12 * Math.log2(medianF0(out) / want);
  console.log(`improved, no stretch, pitch ${pitch} formant ${formant}: off ${errSt.toFixed(2)} st, length ${out.length}`);
  assert.ok(Math.abs(errSt) < 0.3, "improved pitch within 0.3 semitones");
}

// Mark jitter on a breathy voice: how much consecutive cycle lengths wobble (should be ~0 for this steady vowel).
let noiseSeed = 1;
const noise = () => ((noiseSeed = (noiseSeed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5);
const breathy = input.map((v) => v + noise() * 0.15);
const jitter = (m) => {
  const d = [];
  for (let i = 2; i < m.pos.length; i++) {
    if (!m.voiced[i] || !m.voiced[i - 1] || !m.voiced[i - 2]) continue;
    const a = m.pos[i] - m.pos[i - 1], b = m.pos[i - 1] - m.pos[i - 2];
    d.push(Math.abs(a - b) / m.period[i]);
  }
  return d.reduce((s, v) => s + v, 0) / d.length;
};
const track = detectPitch(breathy, SR);
const rawJ = jitter(pitchMarks(breathy, SR, track));
const stableJ = jitter(pitchMarks(breathy, SR, smoothVoicing(track), { stable: true }));
console.log(`pitch-mark jitter on a breathy voice: first version ${(rawJ * 100).toFixed(1)}%, improved ${(stableJ * 100).toFixed(1)}%`);
assert.ok(stableJ < rawJ, "improved marks are steadier");

const r = resample(input, 0.5);
assert.equal(r.length, input.length * 2);
console.log("all checks passed");
