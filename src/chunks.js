// Loads a big file that was split into parts by scripts/build-deploy.mjs (static hosts limit file size: GitHub blocks
// pushes over 100 MB, Cloudflare Pages rejects files over 25 MiB). Used by the page and by the Sudachi worker.
//
// A manifest.json next to the parts describes the file:
//   { name, version, compression: "gzip" | "none", rawSize, rawSha256, parts: [{ file, size, sha256 }] }
// The parts are fetched in order, streamed through gunzip when needed into one preallocated buffer, verified against
// the manifest's SHA-256, and stored in IndexedDB so later visits download nothing.

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

const mb = (n) => (n / 1048576).toFixed(0);

const sha256Hex = async (bytes) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Download one URL into a single buffer (used for the un-chunked fallback used in local development). */
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

/** Stream every part in order (through gunzip if needed) into one preallocated buffer. */
async function downloadParts(manifest, baseUrl, log, label) {
  const gzip = manifest.compression === "gzip";
  if (gzip && !("DecompressionStream" in self)) throw new Error("This browser cannot unzip downloads (needs Safari/iOS 16.4+ or a recent Chrome/Firefox).");
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
            if (loaded - last > 8e6 || loaded === total) { last = loaded; log(`Downloading ${label}: ${mb(loaded)}/${mb(total)} MB${gzip ? " (compressed)" : ""}`); }
          }
        }
        controller.close();
      } catch (e) { controller.error(e); }
    },
  });
  const reader = (gzip ? compressed.pipeThrough(new DecompressionStream("gzip")) : compressed).getReader();
  const out = new Uint8Array(manifest.rawSize);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > out.length) throw new Error(`${label}: downloaded data is larger than the manifest says.`);
    out.set(value, n);
    n += value.length;
  }
  if (n !== manifest.rawSize) throw new Error(`${label}: downloaded ${n} bytes but the manifest says ${manifest.rawSize}.`);
  return out;
}

/**
 * @param {object} o
 * @param {string} o.manifestUrl  URL of manifest.json (parts are resolved relative to it)
 * @param {string} [o.rawUrl]     fallback when there is no manifest (local development): one un-split file
 * @param {(msg: string) => void} [o.log]
 * @param {string} [o.label]      name shown in progress messages
 * @returns {Promise<Uint8Array>} the complete, verified file
 */
export async function loadChunked({ manifestUrl, rawUrl = null, log = () => {}, label = "file" }) {
  let manifest = null;
  try {
    const res = await fetch(manifestUrl, { cache: "no-cache" });
    if (res.ok) manifest = await res.json();
  } catch { /* no manifest */ }
  if (!manifest && !rawUrl) throw new Error(`${label}: could not load ${manifestUrl}`);
  const key = manifest ? `${manifest.name}@${manifest.version}:${manifest.rawSha256.slice(0, 16)}` : `raw:${rawUrl}`;

  try {
    const cached = await idb("readonly", (s) => s.get(key));
    if (cached && cached.byteLength > 1e5 && (!manifest || cached.byteLength === manifest.rawSize)) {
      log(`${label}: loaded from IndexedDB cache (${mb(cached.byteLength)} MB) - no download.`);
      return cached instanceof Uint8Array ? cached : new Uint8Array(cached);
    }
  } catch (e) { log(`IndexedDB unavailable (${e?.message ?? e}); will download.`); }

  let bytes;
  if (manifest) {
    bytes = await downloadParts(manifest, manifestUrl, log, label);
    if (self.crypto?.subtle) {
      if ((await sha256Hex(bytes)) !== manifest.rawSha256) throw new Error(`${label}: checksum mismatch - the download is corrupt. Reload and try again.`);
    }
  } else {
    let last = 0;
    bytes = await fetchWithProgress(rawUrl, (l, t) => {
      if (l - last > 10e6 || l === t) { last = l; log(`Downloading ${label}: ${mb(l)}${t ? "/" + mb(t) : ""} MB`); }
    });
  }
  try {
    await idb("readwrite", (s) => s.put(bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer, key));
    log(`${label}: cached in IndexedDB for next time.`);
  } catch (e) { log(`${label}: could not cache in IndexedDB (${e?.name ?? ""} ${e?.message ?? e}); it will re-download next visit.`); }
  return bytes;
}
