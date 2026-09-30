// Downloads and caches a dictionary written by `jp-analyzer copy-dict`, and streams it into an engine's memory.
//
// The compressed parts are what gets stored in IndexedDB (about 42 MB for Sudachi, not the 125 MB unpacked). Each
// load unpacks them one at a time and hands the unpacked bytes to `onData`, so no full copy of the dictionary is ever
// held outside the engine's own memory. Peak extra memory is about one part (~20 MB).
//
// IndexedDB layout (database "jp-analyzer", store "files"):
//   "<engine>@<version>/<file>"   compressed bytes of one file
//   "<engine>@<version>"          the manifest, written last: its presence means every file above is stored
//   "manifest:<manifest url>"     the last manifest seen at that URL, so a cached dictionary also loads offline

const DB_NAME = "jp-analyzer";
const STORE = "files";

const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}
const idbGet = (key) => tx("readonly", (s) => s.get(key));
const idbPut = (key, value) => tx("readwrite", (s) => s.put(value, key));

/** Delete stored files of `engine` except those belonging to `keepId` (all of them when keepId is null). */
async function idbDeleteEngine(engine, keepId) {
  const keys = await tx("readonly", (s) => s.getAllKeys());
  const stale = keys.filter((k) => typeof k === "string" && k.startsWith(`${engine}@`) && (!keepId || (k !== keepId && !k.startsWith(`${keepId}/`))));
  if (stale.length) await tx("readwrite", (s) => { for (const k of stale) s.delete(k); });
}

const sha256Hex = async (bytes) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
};

const cacheId = (m) => `${m.engine}@${m.version}`;

/** Fetch the manifest; fall back to the last one seen (offline, or the host is down). */
async function getManifest(manifestUrl) {
  try {
    const res = await fetch(manifestUrl, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const m = await res.json();
    if (m.format !== "jp-analyzer-dict/1") throw new Error(`unknown dictionary format ${m.format}`);
    idbPut(`manifest:${manifestUrl}`, m).catch(() => {});
    return m;
  } catch (err) {
    const saved = await idbGet(`manifest:${manifestUrl}`).catch(() => null);
    if (saved) return saved;
    throw new Error(`could not load ${manifestUrl}: ${err.message}`);
  }
}

export async function dictInfo(manifestUrl) {
  const m = await getManifest(manifestUrl);
  const cached = !!(await idbGet(cacheId(m)).catch(() => null));
  return { manifest: m, cached, downloadSize: m.downloadSize };
}

export async function clearDict(engine) {
  await idbDeleteEngine(engine, null);
}

async function download(url, expectedSize, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const out = new Uint8Array(expectedSize);
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > out.length) throw new Error(`${url} is larger than the manifest says`);
    out.set(value, n);
    n += value.length;
    onBytes(value.length);
  }
  if (n !== expectedSize) throw new Error(`${url}: got ${n} bytes, the manifest says ${expectedSize}`);
  return out;
}

/**
 * @param {string} manifestUrl
 * @param {object} o
 * @param {(code: Uint8Array, manifest: object) => Promise<void>} o.onCode  called first, with the engine's program
 * @param {(chunk: Uint8Array) => void} o.onData           then with the unpacked dictionary bytes, in order
 * @param {(p: {loaded: number, total: number}) => void} [o.onProgress]  download progress (not called when cached)
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{ manifest: object, fromCache: boolean, cached: boolean }>}
 *   cached = the dictionary is now stored on the device (false when storing failed, e.g. storage full)
 */
export async function loadDict(manifestUrl, { onCode, onData, onProgress = () => {}, log = () => {} }) {
  if (!("DecompressionStream" in self)) throw new Error("this browser cannot unpack gzip (needs Safari 16.4+ or a recent Chrome/Firefox)");
  const m = await getManifest(manifestUrl);
  const id = cacheId(m);
  const fromCache = !!(await idbGet(id).catch(() => null));
  const verify = !!self.crypto?.subtle; // not available on plain http:// LAN addresses
  if (!fromCache && !verify) log("No crypto.subtle (page is not https): skipping checksum verification.");

  let storing = !fromCache;
  let loaded = 0;
  const total = m.downloadSize;

  /** Bytes of one file: from the cache, or downloaded, verified and stored. */
  const file = async ({ file: name, size, sha256 }) => {
    const key = `${id}/${name}`;
    if (fromCache) {
      const bytes = await idbGet(key);
      if (!bytes) throw new Error(`cached dictionary is incomplete (${name} missing); clear the cache and reload`);
      return new Uint8Array(bytes);
    }
    const bytes = await download(new URL(name, new URL(manifestUrl, location.href)), size, (n) => {
      loaded += n;
      onProgress({ loaded, total });
    });
    if (verify && (await sha256Hex(bytes)) !== sha256) throw new Error(`${name} is corrupt (checksum mismatch); reload to try again`);
    if (storing) {
      try { await idbPut(key, bytes.buffer); }
      catch (e) { storing = false; log(`Could not store the dictionary on this device (${e?.name ?? e}); it will download again next time.`); }
    }
    return bytes;
  };

  await onCode(await file(m.code), m);

  let written = 0;
  for (const part of m.data.parts) {
    const gz = await file(part);
    const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onData(value);
      written += value.length;
    }
  }
  if (written !== m.data.rawSize) throw new Error(`dictionary unpacked to ${written} bytes, the manifest says ${m.data.rawSize}`);

  if (storing) {
    try {
      await idbPut(id, m); // marks the stored copy complete
      await idbDeleteEngine(m.engine, id); // drop older versions of this engine's dictionary
    } catch (e) { storing = false; log(`Could not finish storing the dictionary (${e?.name ?? e}).`); }
  }
  return { manifest: m, fromCache, cached: fromCache || storing };
}
