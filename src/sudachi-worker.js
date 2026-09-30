// Web Worker: loads the Sudachi wasm (dictionary compiled in) and tokenizes text.
// The 118 MB binary comes from chunks.js (gzip parts + IndexedDB cache: iOS Safari friendly, no re-download).
import { loadChunked } from "./chunks.js";
import init, { tokenize } from "./sudachi-glue.js";

// The npm build swaps two JSON fields: `reading_form` holds the dictionary form and
// `dictionary_form` holds the katakana reading. Normalise here. Only tokenize mode C (=2) returns results.
const analyzeLine = (line) => JSON.parse(tokenize(line, 2)).map((m) => ({
  surface: m.surface, reading: m.dictionary_form, dict: m.reading_form, norm: m.normalized_form, pos: m.poses,
}));

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "load") {
      const bytes = await loadChunked({
        manifestUrl: data.manifestUrl, rawUrl: data.rawUrl, label: "Sudachi",
        log: (msg) => self.postMessage({ type: "log", id, msg }),
      });
      await init(bytes);
      self.postMessage({ type: "done", id });
    } else if (type === "analyze") {
      const lines = data.text.split("\n").map((l) => (l.trim() ? analyzeLine(l) : null));
      self.postMessage({ type: "done", id, lines });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message ?? String(err) });
  }
};
