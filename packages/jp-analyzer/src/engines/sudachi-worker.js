// Web Worker running Sudachi. The program (0.8 MB) is instantiated first; then the dictionary is streamed part by
// part straight into its linear memory at the offsets the data segments had (see bin/split-wasm.mjs). The browser
// therefore holds the dictionary once (in wasm memory) instead of twice (wasm memory + the compiled module's copy).
//
// Messages in:  { id, type: "load", manifestUrl }  |  { id, type: "analyze", texts: string[] }
// Messages out: { id, type: "progress", loaded, total } | { id, type: "log", msg } | { id, type: "done", ... }
//               | { id, type: "error", message }
import { loadDict } from "../dict-store.js";
import init, { tokenize } from "./sudachi-glue.js";

const MODE_C = 2; // the 2020 build only returns results in mode C

let ready = false;

// The npm build swaps two JSON fields: `reading_form` holds the dictionary form and `dictionary_form` holds the
// katakana reading.
const analyzeText = (text) => (text ? JSON.parse(tokenize(text, MODE_C)) : []).map((m) => ({
  surface: m.surface, reading: m.dictionary_form, dictionaryForm: m.reading_form, normalizedForm: m.normalized_form, posDetail: m.poses,
}));

/** Returns a function that writes a stream of bytes across the data segments, in order. */
function segmentWriter(memory, segments) {
  const end = Math.max(...segments.map((s) => s.offset + s.length));
  if (memory.buffer.byteLength < end) memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
  let seg = 0, pos = 0;
  return (chunk) => {
    let c = 0;
    while (c < chunk.length) {
      const s = segments[seg];
      if (!s) throw new Error("dictionary data is longer than its segment table");
      const n = Math.min(s.length - pos, chunk.length - c);
      new Uint8Array(memory.buffer, s.offset + pos, n).set(chunk.subarray(c, c + n));
      pos += n; c += n;
      if (pos === s.length) { seg++; pos = 0; }
    }
  };
}

async function load(id, manifestUrl) {
  let memory, write;
  const result = await loadDict(manifestUrl, {
    onCode: async (code, manifest) => {
      memory = (await init(code)).memory;
      write = segmentWriter(memory, manifest.segments);
    },
    onData: (chunk) => write(chunk),
    onProgress: ({ loaded, total }) => self.postMessage({ id, type: "progress", loaded, total }),
    log: (msg) => self.postMessage({ id, type: "log", msg }),
  });
  analyzeText("今日は良い天気ですね。"); // warm-up: Sudachi builds its lookup structures on the first call
  ready = true;
  return { fromCache: result.fromCache, cached: result.cached, memoryBytes: memory.buffer.byteLength };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "load") {
      self.postMessage({ id, type: "done", ...(await load(id, data.manifestUrl)) });
    } else if (type === "analyze") {
      if (!ready) throw new Error("not loaded");
      self.postMessage({ id, type: "done", results: data.texts.map(analyzeText) });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message ?? String(err) });
  }
};
