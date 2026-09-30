import * as sbv2 from "./sbv2-entry.js";

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "load") {
      await sbv2.load({ ...data, log: (msg) => self.postMessage({ type: "log", id, msg }) });
      self.postMessage({ type: "done", id });
    } else if (type === "synth") {
      const { samples, sampleRate } = await sbv2.synthesize(data.text, data.scalars);
      self.postMessage({ type: "done", id, samples, sampleRate }, [samples.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message ?? String(err) });
  }
};
