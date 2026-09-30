// Web Worker: loads the Sudachi wasm (dictionary compiled in) and tokenizes text.
// The 123 MB binary is cached in IndexedDB after the first download (iOS Safari friendly: no re-download).
import init, { tokenize } from "./sudachi-glue.js";

const WASM_KEY = "sudachi.wasm@0.1.5";
const DB_NAME = "jp-tts-playground";
const STORE = "blobs";

const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const idb = async (mode, fn) => {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
};

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  let out = new Uint8Array(total || 1 << 24);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, loaded + value.length));
      bigger.set(out.subarray(0, loaded));
      out = bigger;
    }
    out.set(value, loaded);
    loaded += value.length;
    onProgress(loaded, total);
  }
  return loaded === out.length ? out : out.slice(0, loaded);
}

const mb = (n) => (n / 1048576).toFixed(0);

/** Stream every part in order through gunzip into one preallocated buffer (never holds compressed + raw twice). */
async function downloadParts(manifest, baseUrl, log) {
  if (!("DecompressionStream" in self)) throw new Error("This browser cannot unzip downloads (needs Safari/iOS 16.4+ or a recent Chrome/Firefox).");
  const total = manifest.parts.reduce((a, p) => a + p.size, 0);
  let loaded = 0, last = 0;
  const compressed = new ReadableStream({
    async start(controller) {
      try {
        for (const part of manifest.parts) {
          const res = await fetch(new URL(part.file, baseUrl));
          if (!res.ok) throw new Error(`${part.file}: ${res.status} ${res.statusText}`);
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            loaded += value.length;
            if (loaded - last > 8e6 || loaded === total) { last = loaded; log(`Downloading Sudachi: ${mb(loaded)}/${mb(total)} MB (compressed)`); }
          }
        }
        controller.close();
      } catch (e) { controller.error(e); }
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream(manifest.compression || "gzip")).getReader();
  const out = new Uint8Array(manifest.rawSize);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > out.length) throw new Error("Downloaded data is larger than the manifest says.");
    out.set(value, n);
    n += value.length;
  }
  if (n !== manifest.rawSize) throw new Error(`Downloaded ${n} bytes but the manifest says ${manifest.rawSize}.`);
  return out;
}

const sha256Hex = async (bytes) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Prefer the chunked build (manifest + gzip parts, for static hosts with file-size limits); fall back to one raw file. */
async function loadWasmBytes({ manifestUrl, rawUrl }, log) {
  let manifest = null;
  try {
    const res = await fetch(manifestUrl, { cache: "no-cache" });
    if (res.ok) manifest = await res.json();
  } catch { /* no manifest: use the raw file */ }
  const key = manifest ? `sudachi@${manifest.version}:${manifest.rawSha256.slice(0, 16)}` : WASM_KEY;

  try {
    const cached = await idb("readonly", (s) => s.get(key));
    if (cached && cached.byteLength > 1e6 && (!manifest || cached.byteLength === manifest.rawSize)) {
      log(`Loaded from IndexedDB cache (${mb(cached.byteLength)} MB) - no download.`);
      return cached;
    }
  } catch (e) { log(`IndexedDB unavailable (${e?.message ?? e}); will download.`); }

  let bytes;
  if (manifest) {
    bytes = await downloadParts(manifest, manifestUrl, log);
    if (self.crypto?.subtle) {
      log("Verifying download...");
      if ((await sha256Hex(bytes)) !== manifest.rawSha256) throw new Error("Checksum mismatch: the downloaded Sudachi file is corrupt. Reload and try again.");
    }
  } else {
    let last = 0;
    bytes = await fetchWithProgress(rawUrl, (l, t) => {
      if (l - last > 10e6 || l === t) { last = l; log(`Downloading Sudachi: ${mb(l)}${t ? "/" + mb(t) : ""} MB`); }
    });
  }
  try {
    await idb("readwrite", (s) => s.put(bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer, key));
    log("Cached in IndexedDB for next time.");
  } catch (e) { log(`Could not cache in IndexedDB (${e?.name ?? ""} ${e?.message ?? e}); it will re-download next visit.`); }
  return bytes;
}

// The npm build swaps two JSON fields: `reading_form` holds the dictionary form and
// `dictionary_form` holds the katakana reading. Normalise here. Only tokenize mode C (=2) returns results.
const analyzeLine = (line) => JSON.parse(tokenize(line, 2)).map((m) => ({
  surface: m.surface, reading: m.dictionary_form, dict: m.reading_form, norm: m.normalized_form, pos: m.poses,
}));

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "load") {
      const bytes = await loadWasmBytes(data, (msg) => self.postMessage({ type: "log", id, msg }));
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
