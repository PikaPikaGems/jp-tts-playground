// Independent pitch + formant shifting with Rubber Band (R3 engine) compiled to WASM.
// NOTE: Rubber Band is GPL-2.0+ (commercial licence available) - fine for a personal test page.
import { RubberBandInterface, RubberBandOption as O } from "rubberband-wasm";
import { PATHS } from "./paths.js";

let rbPromise = null;
const getRb = () => (rbPromise ??= (async () => {
  const wasm = await WebAssembly.compileStreaming(fetch(new URL(PATHS.rubberbandWasm, document.baseURI)));
  return RubberBandInterface.initialize(wasm);
})());

/**
 * @param {Float32Array} samples mono
 * @param {number} pitchSt   semitones (negative = lower pitch)
 * @param {number} formantSt semitones (negative = larger/deeper vocal tract), independent of pitch
 */
export async function shiftVoice(samples, sampleRate, pitchSt, formantSt) {
  if (!pitchSt && !formantSt) return samples;
  const rb = await getRb();
  const options = O.RubberBandOptionProcessOffline | O.RubberBandOptionEngineFiner | O.RubberBandOptionPitchHighQuality
    | O.RubberBandOptionFormantPreserved; // formant scale is ONLY honoured with this option
  const state = rb.rubberband_new(sampleRate, 1, options, 1, 1);
  rb.rubberband_set_pitch_scale(state, 2 ** (pitchSt / 12));
  // Rubber Band applies formantScale ON TOP of the pitch shift (net formant factor = pitchScale * formantScale),
  // so divide the pitch factor out to make the slider mean "net formant shift vs. the original voice".
  rb.rubberband_set_formant_scale(state, 2 ** ((formantSt - pitchSt) / 12));
  const block = rb.rubberband_get_samples_required(state) || 1024;
  const bufPtr = rb.malloc(block * 4);
  const arrPtr = rb.malloc(4);
  rb.memWritePtr(arrPtr, bufPtr);
  rb.rubberband_set_expected_input_duration(state, samples.length);

  // Study pass (offline mode), then process pass.
  for (let read = 0; read < samples.length;) {
    const n = Math.min(block, samples.length - read);
    rb.memWrite(bufPtr, samples.subarray(read, read + n));
    read += n;
    rb.rubberband_study(state, arrPtr, n, read >= samples.length ? 1 : 0);
  }
  const out = [];
  const drain = () => {
    for (;;) {
      const avail = rb.rubberband_available(state);
      if (avail < 1) break;
      const n = Math.min(block, avail);
      const got = rb.rubberband_retrieve(state, arrPtr, n);
      out.push(rb.memReadF32(bufPtr, got).slice());
    }
  };
  for (let read = 0; read < samples.length;) {
    const n = Math.min(block, samples.length - read);
    rb.memWrite(bufPtr, samples.subarray(read, read + n));
    read += n;
    rb.rubberband_process(state, arrPtr, n, read >= samples.length ? 1 : 0);
    drain();
  }
  drain();
  rb.free(bufPtr); rb.free(arrPtr); rb.rubberband_delete(state);

  const total = out.reduce((a, c) => a + c.length, 0);
  const res = new Float32Array(total);
  let o = 0;
  for (const c of out) { res.set(c, o); o += c.length; }
  return res;
}

/**
 * Tame breathiness/hiss: a high-shelf cut above ~3 kHz (up to -15 dB) plus a gentle low-pass, rendered offline
 * so the result is real audio data (also ends up in the downloaded WAV).
 * @param {number} amount 0..1
 */
export async function reduceBreathiness(samples, sampleRate, amount) {
  if (!amount) return samples;
  const off = new OfflineAudioContext(1, samples.length, sampleRate);
  const buf = off.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  const shelf = off.createBiquadFilter();
  shelf.type = "highshelf";
  shelf.frequency.value = 3000;
  shelf.gain.value = -15 * amount;
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Math.min(sampleRate / 2 - 100, 10000 - 4000 * amount);
  lp.Q.value = 0.5;
  src.connect(shelf).connect(lp).connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

/**
 * Clean resampling by `ratio` (playbackRate semantics): ratio < 1 lowers pitch AND formants by that factor and makes the
 * audio longer by 1/ratio. Used for the "clean" part of a voice change - it adds no phase-vocoder artifacts, unlike
 * Rubber Band. The caller compensates the duration by asking the voice model to speak faster by 1/ratio first.
 */
export async function resampleBy(samples, sampleRate, ratio) {
  if (Math.abs(ratio - 1) < 1e-6) return samples;
  const off = new OfflineAudioContext(1, Math.ceil(samples.length / ratio), sampleRate);
  const buf = off.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = ratio;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}
