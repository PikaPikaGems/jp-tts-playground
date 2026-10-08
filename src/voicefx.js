// Voice clean-up applied after synthesis. (Pitch and formant shifting is in psola.js.)

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
