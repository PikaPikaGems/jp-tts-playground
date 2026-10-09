// Voice pitch and formant shifting with TD-PSOLA (time-domain pitch-synchronous overlap-add). Plain JavaScript, no
// dependencies, runs on the page, in workers and in Node.
//
// PSOLA works on the voice's individual pitch cycles: it finds where each cycle starts (pitch marks), cuts out
// two-cycle slices around them and lays copies of those slices closer together (higher pitch) or further apart
// (lower pitch). Each slice keeps its own spectral shape, so formants stay put and there is no phase-vocoder
// "echo". Formants are moved separately by resampling first; PSOLA then sets the final pitch and keeps the
// original duration.
//
//   shiftVoicePsola(samples, sampleRate, pitchSt, formantSt, VOICE_SHIFT) -> Float32Array
//
// VOICE_SHIFT is what the playground uses. It was picked by ear in voice-lab.html over Rubber Band and earlier PSOLA
// versions, and tuned on the noisiest presets: aligning cycles raised the harmonics-to-noise ratio by 0.3-0.7 dB,
// widening slices when lowering did not help, and the gate takes the background in pauses from about -70 to -94 dB.
// `stretch: false` means the caller must have the voice speak faster by 2^(formantSt/12) first (see shiftVoicePsola).

export const VOICE_SHIFT = { improved: true, align: true, gate: true, stretch: false };

/**
 * Pitch track with the YIN algorithm (de Cheveigné & Kawahara, 2002).
 * @returns {{ hop: number, f0: Float32Array }}  f0 per hop in Hz, 0 = unvoiced
 */
export function detectPitch(x, sampleRate, { fmin = 70, fmax = 600, hopSec = 0.005, threshold = 0.15 } = {}) {
  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const maxLag = Math.ceil(sampleRate / fmin);
  const minLag = Math.floor(sampleRate / fmax);
  const W = maxLag; // integration window
  const frames = Math.ceil(x.length / hop);
  const f0 = new Float32Array(frames);
  const d = new Float32Array(maxLag + 1);

  // Silence gate: frames much quieter than the loudest part are unvoiced.
  let peakRms = 0;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const s = f * hop - (W >> 1);
    let e = 0;
    for (let j = 0; j < W; j++) { const v = x[s + j] ?? 0; e += v * v; }
    rms[f] = Math.sqrt(e / W);
    if (rms[f] > peakRms) peakRms = rms[f];
  }

  for (let f = 0; f < frames; f++) {
    if (rms[f] < peakRms * 0.03) continue;
    const s = f * hop - (W >> 1);
    if (s < 0 || s + W + maxLag >= x.length) continue;
    // difference function
    for (let tau = 1; tau <= maxLag; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const diff = x[s + j] - x[s + j + tau]; sum += diff * diff; }
      d[tau] = sum;
    }
    // cumulative mean normalised difference, then the first dip below the threshold
    let running = 0, best = -1;
    d[0] = 1;
    for (let tau = 1; tau <= maxLag; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) continue;
    // parabolic interpolation around the dip
    const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
    const denom = a - 2 * b + c;
    const lag = denom ? best + (0.5 * (a - c)) / denom : best;
    f0[f] = sampleRate / lag;
  }

  // 5-point median filter against octave jumps; only between voiced frames.
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!f0[f]) continue;
    const w = [];
    for (let k = -2; k <= 2; k++) if (f0[f + k]) w.push(f0[f + k]);
    w.sort((p, q) => p - q);
    out[f] = w[w.length >> 1];
  }
  return { hop, f0: out };
}

/**
 * Smooth the voiced/unvoiced decision: fill short unvoiced gaps inside voiced speech (interpolating the pitch) and
 * drop very short voiced islands. Flicker between the two modes causes clicks.
 */
export function smoothVoicing({ hop, f0 }, { maxGap = 3, minRun = 4 } = {}) {
  const out = f0.slice();
  for (let i = 0; i < out.length;) {
    if (out[i]) { i++; continue; }
    let j = i;
    while (j < out.length && !out[j]) j++;
    if (i > 0 && j < out.length && j - i <= maxGap) {
      for (let k = i; k < j; k++) out[k] = out[i - 1] + ((out[j] - out[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  for (let i = 0; i < out.length;) {
    if (!out[i]) { i++; continue; }
    let j = i;
    while (j < out.length && out[j]) j++;
    if (j - i < minRun) out.fill(0, i, j);
    i = j;
  }
  return { hop, f0: out };
}

/** Zero-phase low-pass (a 2nd-order filter run forwards and backwards), so peaks stay where they were. */
function lowpassZeroPhase(x, sampleRate, cutoff) {
  const w = (2 * Math.PI * cutoff) / sampleRate, alpha = Math.sin(w) / Math.SQRT2, cw = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  const pass = (src, reverse) => {
    const y = new Float32Array(src.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < src.length; n++) {
      const i = reverse ? src.length - 1 - n : n;
      const v = b0 * src[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = src[i]; y2 = y1; y1 = v;
      y[i] = v;
    }
    return y;
  };
  return pass(pass(x, false), true);
}

/**
 * Pitch marks: one per pitch cycle in voiced parts (on the cycle's main peak), evenly spaced in unvoiced parts.
 * `stable`: find peaks on a low-passed copy (around the fundamental), so marks don't jump between similar peaks
 * from one cycle to the next. Mark jitter is heard as roughness and noise.
 * @returns {{ pos: Int32Array, period: Float32Array, voiced: Uint8Array }}
 */
export function pitchMarks(x, sampleRate, { hop, f0 }, { stable = false, align = false } = {}) {
  const unvoicedPeriod = Math.round(sampleRate * 0.005);
  const f0At = (t) => f0[Math.min(f0.length - 1, Math.max(0, Math.round(t / hop)))];
  const ref = stable || align ? lowpassZeroPhase(x, sampleRate, 900) : x;
  const reach = stable || align ? 1 / 4 : 1 / 3; // search window around the expected position, as a fraction of a period
  const peakIn = (a, b) => {
    let best = Math.max(0, a), v = -Infinity;
    for (let i = Math.max(0, a); i < Math.min(ref.length, b); i++) if (ref[i] > v) { v = ref[i]; best = i; }
    return best;
  };
  // `align`: the position near `t` whose surrounding cycle looks most like the previous one (normalised
  // cross-correlation). Keeps consecutive slices in the same place within their cycles, so they add up cleanly.
  const alignedNear = (prev, t, P) => {
    const half = Math.round(P / 2), span = Math.round(P * reach);
    let best = Math.round(t), bestScore = -Infinity;
    for (let c = Math.round(t) - span; c <= Math.round(t) + span; c++) {
      let xy = 0, yy = 0;
      for (let j = -half; j <= half; j++) {
        const a = ref[prev + j] ?? 0, b = ref[c + j] ?? 0;
        xy += a * b; yy += b * b;
      }
      const score = yy > 0 ? xy / Math.sqrt(yy) : -Infinity;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };
  const pos = [], period = [], voiced = [];
  let t = 0, prevVoiced = false;
  while (t < x.length) {
    const f = f0At(t);
    if (f > 0) {
      const P = sampleRate / f;
      // first cycle of a voiced run: its highest peak; later cycles: the peak (or best-aligned cycle) near where the
      // next cycle is expected
      const m = !prevVoiced ? peakIn(Math.round(t), Math.round(t + P))
        : align ? alignedNear(pos[pos.length - 1], t, P)
        : peakIn(Math.round(t - P * reach), Math.round(t + P * reach));
      pos.push(m); period.push(P); voiced.push(1);
      t = m + P; // where the next cycle should start
      prevVoiced = true;
    } else {
      pos.push(Math.round(t)); period.push(unvoicedPeriod); voiced.push(0);
      t += unvoicedPeriod;
      prevVoiced = false;
    }
  }
  return { pos: Int32Array.from(pos), period: Float32Array.from(period), voiced: Uint8Array.from(voiced) };
}

/**
 * High-quality resampling by `ratio` (playback-rate semantics): ratio < 1 lowers pitch and formants and makes the
 * audio longer by 1/ratio. Windowed sinc, with anti-aliasing when ratio > 1.
 */
export function resample(x, ratio, zeroCrossings = 12) {
  if (Math.abs(ratio - 1) < 1e-9) return x.slice();
  const n = Math.floor(x.length / ratio);
  const y = new Float32Array(n);
  const fc = Math.min(1, 1 / ratio); // cutoff relative to the input's Nyquist
  const half = zeroCrossings / fc;
  for (let i = 0; i < n; i++) {
    const center = i * ratio;
    const k0 = Math.max(0, Math.ceil(center - half)), k1 = Math.min(x.length - 1, Math.floor(center + half));
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const dd = center - k;
      const arg = Math.PI * fc * dd;
      const sinc = arg === 0 ? 1 : Math.sin(arg) / arg;
      const w = 0.5 * (1 + Math.cos((Math.PI * dd) / half)); // Hann window
      sum += x[k] * fc * sinc * w;
    }
    y[i] = sum;
  }
  return y;
}

/**
 * TD-PSOLA: change pitch by `pitchFactor` (2 = one octave up) and length by `timeFactor` (output length / input length).
 * `jitterUnvoiced`: when a noise slice (s, sh, breath) would be used twice in a row, take it from a slightly different
 * place, so repeated noise doesn't turn into a buzz.
 * `lowerWindow`: when lowering the pitch, slices are laid further apart than they are long, leaving dips between
 * cycles (heard as roughness). Values above 1 widen the slices (up to this many periods each side) to fill them.
 */
export function psola(x, sampleRate, { pitchFactor = 1, timeFactor = 1, marks, jitterUnvoiced = false, lowerWindow = 1 } = {}) {
  const m = marks ?? pitchMarks(x, sampleRate, detectPitch(x, sampleRate));
  const outLen = Math.round(x.length * timeFactor);
  const y = new Float32Array(outLen);
  if (m.pos.length === 0) return y;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296); // deterministic
  let k = 0, lastK = -1;
  let tOut = m.pos[0] * timeFactor;
  while (tOut < outLen) {
    const tIn = tOut / timeFactor;
    while (k + 1 < m.pos.length && Math.abs(m.pos[k + 1] - tIn) <= Math.abs(m.pos[k] - tIn)) k++;
    const P = m.period[k];
    const widen = m.voiced[k] && pitchFactor < 1 ? Math.min(1 / pitchFactor, lowerWindow) : 1;
    const half = Math.max(2, Math.round(P * widen)); // Hann window around the mark: two periods, wider when lowering
    const center = m.pos[k] + (jitterUnvoiced && !m.voiced[k] && k === lastK ? Math.round((rand() - 0.5) * P) : 0);
    lastK = k;
    const at = Math.round(tOut);
    for (let j = -half; j <= half; j++) {
      const src = center + j, dst = at + j;
      if (src < 0 || src >= x.length || dst < 0 || dst >= outLen) continue;
      y[dst] += x[src] * 0.5 * (1 + Math.cos((Math.PI * j) / half));
    }
    tOut += m.voiced[k] ? P / pitchFactor : P;
  }
  return y;
}

const rmsOf = (a) => { let e = 0; for (const v of a) e += v * v; return Math.sqrt(e / Math.max(1, a.length)); };

/**
 * Noise gate: fades out stretches that are much quieter than the speech (pauses between words), where leftover
 * artifacts are most audible. Smooth gain changes (fast open, slower close) so it doesn't click.
 */
export function noiseGate(x, sampleRate, { thresholdDb = -38, floorDb = -30 } = {}) {
  const frame = Math.round(sampleRate * 0.01);
  const frames = Math.ceil(x.length / frame);
  const level = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const seg = x.subarray(f * frame, (f + 1) * frame);
    level[f] = rmsOf(seg);
    peak = Math.max(peak, level[f]);
  }
  const open = peak * 10 ** (thresholdDb / 20), floor = 10 ** (floorDb / 20);
  const target = Array.from(level, (l) => (l >= open ? 1 : floor));
  // hold the gate open one frame either side of speech, so word edges aren't cut
  const held = target.map((v, f) => Math.max(v, target[f - 1] ?? floor, target[f + 1] ?? floor));
  const y = new Float32Array(x.length);
  const attack = 1 - Math.exp(-1 / (sampleRate * 0.003)), release = 1 - Math.exp(-1 / (sampleRate * 0.04));
  let g = held[0];
  for (let i = 0; i < x.length; i++) {
    const want = held[Math.floor(i / frame)];
    g += (want - g) * (want > g ? attack : release);
    y[i] = x[i] * g;
  }
  return y;
}

/**
 * Average harmonics-to-noise ratio (dB) over voiced frames: how much of the voice is clean repeating cycles versus
 * noise. Higher = cleaner. For comparing versions of the same sentence, not an absolute quality score.
 */
export function harmonicsToNoise(x, sampleRate) {
  const { hop, f0 } = detectPitch(x, sampleRate);
  const half = Math.round(sampleRate * 0.02);
  let sum = 0, n = 0;
  for (let f = 0; f < f0.length; f += 2) {
    if (!f0[f]) continue;
    const c = f * hop, T = sampleRate / f0[f];
    let best = 0;
    for (let lag = Math.round(T * 0.9); lag <= Math.round(T * 1.1); lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let j = -half; j < half; j++) {
        const a = x[c + j] ?? 0, b = x[c + j + lag] ?? 0;
        xy += a * b; xx += a * a; yy += b * b;
      }
      const r = xx && yy ? xy / Math.sqrt(xx * yy) : 0;
      if (r > best) best = r;
    }
    const r = Math.min(best, 0.999);
    if (r <= 0) continue;
    sum += 10 * Math.log10(r / (1 - r));
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * @param {Float32Array} samples  mono
 * @param {number} pitchSt    semitones (negative = lower)
 * @param {number} formantSt  semitones (negative = larger/deeper vocal tract), independent of pitch
 * @param {object} [o]
 * @param {boolean} [o.improved]  steadier pitch marks, smoothed voicing, varied noise slices (less roughness/noise)
 * @param {boolean} [o.align]     place each pitch mark where its cycle best matches the previous one
 * @param {number}  [o.lowerWindow]  widen slices when lowering the pitch (see psola()); 1 = off
 * @param {boolean} [o.gate]      fade out leftover noise in pauses
 * @param {boolean} [o.stretch]   true: keep the input's length (PSOLA stretches, repeating slices). false: the caller
 *   already made the speech faster by 2^(formantSt/12) (e.g. piper's lengthScale), so nothing needs repeating and
 *   the output comes out at normal length.
 * @returns {Float32Array} same loudness as the input
 */
export function shiftVoicePsola(samples, sampleRate, pitchSt, formantSt = 0,
  { improved = false, align = false, lowerWindow = 1, gate = false, stretch = true } = {}) {
  if (!pitchSt && !formantSt) return samples;
  const r = 2 ** (formantSt / 12);
  const moved = resample(samples, r); // formants (and pitch) × r, length ÷ r
  let track = detectPitch(moved, sampleRate);
  if (improved) track = smoothVoicing(track);
  const marks = pitchMarks(moved, sampleRate, track, { stable: improved, align });
  const outLen = stretch ? samples.length : moved.length;
  const y = psola(moved, sampleRate, {
    pitchFactor: 2 ** (pitchSt / 12) / r,
    timeFactor: outLen / moved.length,
    marks,
    jitterUnvoiced: improved,
    lowerWindow,
  });
  let out = new Float32Array(outLen);
  out.set(y.subarray(0, outLen));
  // Overlap changes with the pitch factor, which changes loudness; match the input's level.
  const g = rmsOf(samples) / (rmsOf(out) || 1);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  if (gate) out = noiseGate(out, sampleRate);
  return out;
}
