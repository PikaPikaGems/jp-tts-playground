// Web Worker running Sudachi. The program (1.1 MB) is instantiated first; then the dictionary is streamed part by
// part straight into its linear memory at the offsets the data segments had (see bin/split-wasm.mjs). The browser
// therefore holds the dictionary once (in wasm memory) instead of twice (wasm memory + the compiled module's copy).
//
// Instantiating the program reserves Sudachi's 117.5 MB of memory. That happens before any dictionary part is
// downloaded, so a browser that refuses the memory fails fast with "out-of-memory" instead of after a 43 MB download.
//
// Messages in:  { id, type: "load", manifestUrl }  |  { id, type: "analyze", texts: string[] }
// Messages out: { id, type: "progress", loaded, total }  download progress
//               { id, type: "alive" }                    still working (resets the page's watchdog)
//               { id, type: "log", msg }
//               { id, type: "done", ... }  |  { id, type: "error", code, message }
import { loadDict } from "../dict-store.js";
import { makeAnalyzeText } from "./sudachi-analyze.js";
import init, { tokenize } from "./sudachi-glue.js";

const analyzeText = makeAnalyzeText(tokenize);

let memory = null;
let ready = false;

/** Returns a function that writes a stream of bytes across the data segments, in order. */
function segmentWriter(mem, segments) {
  const end = Math.max(...segments.map((s) => s.offset + s.length));
  if (mem.buffer.byteLength < end) mem.grow(Math.ceil((end - mem.buffer.byteLength) / 65536));
  let seg = 0, pos = 0;
  return (chunk) => {
    let c = 0;
    while (c < chunk.length) {
      const s = segments[seg];
      if (!s) throw new Error("dictionary data is longer than its segment table");
      const n = Math.min(s.length - pos, chunk.length - c);
      new Uint8Array(mem.buffer, s.offset + pos, n).set(chunk.subarray(c, c + n));
      pos += n; c += n;
      if (pos === s.length) { seg++; pos = 0; }
    }
  };
}

async function load(id, manifestUrl) {
  let write;
  const post = (msg) => self.postMessage({ id, ...msg });
  const result = await loadDict(manifestUrl, {
    onCode: async (code, manifest) => {
      memory = (await init(code)).memory;
      write = segmentWriter(memory, manifest.segments);
    },
    onData: (chunk) => write(chunk),
    onProgress: ({ loaded, total }) => post({ type: "progress", loaded, total }),
    onStep: () => post({ type: "alive" }),
    log: (msg) => post({ type: "log", msg }),
  });
  analyzeText("今日は良い天気ですね。"); // warm-up: Sudachi builds its lookup structures on the first call
  ready = true;
  return { fromCache: result.fromCache, cached: result.cached, memoryBytes: memory.buffer.byteLength };
}

function errorCode(err) {
  if (err?.code) return err.code;
  const msg = String(err?.message ?? err);
  if (err instanceof RangeError || /out of memory|allocation/i.test(msg)) return "out-of-memory";
  return "engine-failed";
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "load") {
      self.postMessage({ id, type: "done", ...(await load(id, data.manifestUrl)) });
    } else if (type === "analyze") {
      if (!ready) throw Object.assign(new Error("engine not loaded"), { code: "not-loaded" });
      const alive = () => self.postMessage({ id, type: "alive" });
      const results = data.texts.map((t) => analyzeText(t, alive));
      self.postMessage({ id, type: "done", results, memoryBytes: memory.buffer.byteLength, traps: analyzeText.traps() });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", code: errorCode(err), message: err?.message ?? String(err) });
  }
};
