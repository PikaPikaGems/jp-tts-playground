// ../kakera/src/errors.js
var KakeraError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, "cause" in options ? { cause: options.cause } : void 0);
    this.name = new.target.name;
    this.code = code;
  }
};
var codedError = (code, message) => Object.assign(new Error(message), { code });

// ../kakera/src/files.js
var MANIFEST_FORMAT = "kakera/1";
function indexedDbStorage(dbName) {
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction("files", mode);
        const req = fn(t.objectStore("files"));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (key) => tx("readonly", (s) => s.get(key)),
    put: (key, value) => tx("readwrite", (s) => s.put(value, key)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
    remove: (keys) => keys.length ? tx("readwrite", (s) => {
      for (const k of keys) s.delete(k);
    }) : Promise.resolve()
  };
}
var sha256Hex = async (bytes) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
};
async function* gunzip(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}
function fileStore({ dbName, storage, fetch: fetchFn } = {}) {
  storage ??= indexedDbStorage(dbName);
  const doFetch = fetchFn ?? ((...a) => fetch(...a));
  const idOf = (m) => `${m.name}@${m.version}`;
  async function getManifest(url) {
    try {
      const res = await doFetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const m = await res.json();
      if (m.format !== MANIFEST_FORMAT) throw new Error(`unknown manifest format ${m.format}`);
      storage.put(`manifest:${url}`, m).catch(() => {
      });
      return m;
    } catch (err) {
      const saved = await storage.get(`manifest:${url}`).catch(() => null);
      if (saved) return saved;
      throw codedError("download-failed", `could not load ${url}: ${err.message}`);
    }
  }
  async function removeName(name, keepId) {
    const keys = await storage.keys();
    await storage.remove(keys.filter((k) => typeof k === "string" && k.startsWith(`${name}@`) && (!keepId || k !== keepId && !k.startsWith(`${keepId}/`))));
  }
  async function download(url, expected, onBytes) {
    let res;
    try {
      res = await doFetch(url);
    } catch (e) {
      throw codedError("download-failed", `${url}: ${e.message}`);
    }
    if (!res.ok) throw codedError("download-failed", `${url}: ${res.status} ${res.statusText}`);
    const out = new Uint8Array(expected);
    const reader = res.body.getReader();
    let n = 0;
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > expected) throw codedError("download-failed", `${url} is larger than the manifest says`);
        out.set(value, n);
        n += value.length;
        onBytes(value.length);
      }
    } catch (e) {
      throw e.code ? e : codedError("download-failed", `${url}: ${e.message}`);
    }
    if (n !== expected) throw codedError("download-failed", `${url}: got ${n} bytes, the manifest says ${expected}`);
    return out;
  }
  return {
    /** Is everything stored on the device, and how big is the download if not? */
    async info(manifestUrl) {
      const m = await getManifest(manifestUrl);
      const cached = !!await storage.get(idOf(m)).catch(() => null);
      return { cached, downloadBytes: m.downloadSize, manifest: m };
    },
    /** Delete everything stored for the manifest's name (all versions). */
    async clear(manifestUrl) {
      const m = await getManifest(manifestUrl);
      await removeName(m.name, null);
    },
    /**
     * Go through the manifest's files in order. For each, `onFile(file, chunks)` gets the file's entry and an async
     * iterable of its unpacked bytes; it should consume them (whatever it leaves is read and dropped).
     *
     * `onProgress` is called at every step, and while bytes arrive (at most every 100 ms), with:
     *   step        "manifest" | "read" (a part from the device) | "download" | "verify" | "store" | "unpack" | "file-done"
     *   file, fileIndex, files      the file being worked on (1-based index) and how many files there are
     *   part, parts                 the part of that file (1-based) and how many it has
     *   downloaded, toDownload      bytes; toDownload counts only the parts not on the device (0 when all are)
     *   unpacked, toUnpack          bytes handed to onFile so far / in all files
     * @param {string} manifestUrl  absolute URL
     * @param {object} o
     * @param {(file: object, chunks: AsyncIterable<Uint8Array>, manifest: object) => Promise<void>} o.onFile
     * @param {(p: object) => void} [o.onProgress]
     * @param {(msg: string) => void} [o.log]
     * @returns {Promise<{ manifest: object, fromCache: boolean, cached: boolean }>}
     *   fromCache: nothing was downloaded; cached: everything is now stored on the device
     */
    async load(manifestUrl, { onFile, onProgress = () => {
    }, log = () => {
    } }) {
      if (typeof DecompressionStream !== "function") throw codedError("unsupported-browser", "this browser cannot unpack gzip (needs Safari 16.4+ or a recent Chrome/Firefox)");
      const where = { file: null, fileIndex: 0, files: 0, part: 0, parts: 0 };
      const counts = { downloaded: 0, toDownload: 0, unpacked: 0, toUnpack: 0 };
      const report = (step) => onProgress({ step, ...where, ...counts });
      report("manifest");
      const m = await getManifest(manifestUrl);
      const id = idOf(m);
      const complete = !!await storage.get(id).catch(() => null);
      const verify = !!globalThis.crypto?.subtle;
      if (!complete && !verify) log("No crypto.subtle (page is not https): skipping checksum verification.");
      const stored = new Set(complete ? [] : await storage.keys().catch(() => []));
      where.files = m.files.length;
      counts.toUnpack = m.files.reduce((n, f) => n + f.size, 0);
      counts.toDownload = complete ? 0 : m.files.flatMap((f) => f.parts).filter((p) => !stored.has(`${id}/${p.file}`)).reduce((n, p) => n + p.size, 0);
      let storing = true, downloaded = false, lastReport = 0;
      const partBytes = async ({ file: name, size, sha256 }) => {
        const key = `${id}/${name}`;
        report("read");
        const fromDevice = await storage.get(key).catch(() => null);
        if (fromDevice) return new Uint8Array(fromDevice);
        if (complete) {
          log(`${name} was missing from the device; downloading it again.`);
          counts.toDownload += size;
        }
        downloaded = true;
        report("download");
        const bytes = await download(new URL(name, manifestUrl), size, (n) => {
          counts.downloaded += n;
          const now = Date.now();
          if (now - lastReport >= 100) {
            lastReport = now;
            report("download");
          }
        });
        report("download");
        if (verify) {
          report("verify");
          if (await sha256Hex(bytes) !== sha256) throw codedError("checksum-mismatch", `${name} is corrupt (checksum mismatch); reload to try again`);
        }
        if (storing) {
          report("store");
          try {
            await storage.put(key, bytes.buffer);
          } catch (e) {
            storing = false;
            log(`Could not store the files on this device (${e?.name ?? e}); they will download again next time.`);
          }
        }
        return bytes;
      };
      for (const [i, file] of m.files.entries()) {
        Object.assign(where, { file: file.name, fileIndex: i + 1, part: 0, parts: file.parts.length });
        let written = 0;
        const chunks = (async function* () {
          for (const [j, part] of file.parts.entries()) {
            where.part = j + 1;
            const bytes = await partBytes(part);
            report("unpack");
            if (file.gzip) for await (const c of gunzip(bytes)) {
              written += c.length;
              counts.unpacked += c.length;
              yield c;
            }
            else {
              written += bytes.length;
              counts.unpacked += bytes.length;
              yield bytes;
            }
          }
          if (written !== file.size) throw codedError("checksum-mismatch", `${file.name} unpacked to ${written} bytes, the manifest says ${file.size}`);
        })();
        await onFile(file, chunks, m);
        for await (const _ of chunks) {
        }
        report("file-done");
      }
      if (!complete && storing) {
        try {
          await storage.put(id, m);
          await removeName(m.name, id);
        } catch (e) {
          storing = false;
          log(`Could not finish storing the files (${e?.name ?? e}).`);
        }
      }
      return { manifest: m, fromCache: !downloaded, cached: complete || storing };
    }
  };
}

// ../kakera/src/host.js
var DEFAULTS = Object.freeze({
  filesUrl: null,
  // required from the package (e.g. "/yomiage/")
  idleTimeout: 6e4,
  stopWhenHidden: true,
  crashGuard: { retryAfterDays: 7 },
  loadStall: 6e4,
  persistStorage: true
});
var safely = (fn) => {
  try {
    return fn();
  } catch {
    return void 0;
  }
};
var storageOf = (kind) => safely(() => kind === "session" ? sessionStorage : localStorage);
var abortError = () => new DOMException("The operation was aborted.", "AbortError");
function loadTracker(profile) {
  const t0 = performance.now();
  const timings = [];
  let files = {}, fraction = 0, filesDone = false, current = null, last = null, doneMs = 0;
  const elapsed = (now) => Math.round(now - t0);
  const byTime = () => !!profile && files.toUnpack > 0 && !files.toDownload;
  function compute(now) {
    const { downloaded = 0, toDownload = 0, unpacked = 0, toUnpack = 0 } = files;
    let f;
    if (byTime()) {
      const inStep = current ? Math.min(now - current.start, profile.steps[current.key] ?? 0) : 0;
      f = (doneMs + inStep) / profile.total;
    } else {
      const u = toUnpack ? unpacked / toUnpack : 0;
      f = toDownload > 0 ? 0.75 * Math.min(1, downloaded / toDownload) + 0.2 * u : 0.9 * u;
    }
    fraction = Math.min(0.99, Math.max(fraction, f));
  }
  function event(now) {
    const { downloaded = 0, toDownload = 0, unpacked = 0, toUnpack = 0 } = files;
    const downloading = toDownload > 0 && downloaded < toDownload;
    const { engine, type, id, ...details } = last;
    return {
      ...details,
      stage: downloading ? "downloading" : "preparing",
      fraction,
      loaded: downloading ? downloaded : unpacked,
      total: downloading ? toDownload : toUnpack,
      ms: elapsed(now)
    };
  }
  return {
    /** @returns {{ event: object, newStep: boolean }} */
    update(p) {
      const now = performance.now();
      last = p;
      if (!p.engine) files = p;
      if (p.step === "file-done" && p.fileIndex === p.files) filesDone = true;
      const key = `${p.step}|${p.file ?? ""}|${p.part ?? ""}`;
      const newStep = current?.key !== key;
      if (newStep) {
        if (current) {
          current.ms = Math.round(now - current.start);
          doneMs += profile?.steps[current.key] ?? 0;
        }
        current = { key, start: now, step: p.step, ...p.file && { file: p.file }, ...p.part && { part: p.part }, at: elapsed(now) };
        timings.push(current);
      }
      compute(now);
      if (!byTime() && filesDone && p.engine && newStep) fraction = Math.min(0.99, fraction + (0.99 - fraction) / 3);
      return { newStep, event: event(now) };
    },
    /** While a step runs: a new event when the time-based bar has moved, else null. */
    tick() {
      if (!last || !byTime()) return null;
      const before = fraction;
      compute(performance.now());
      return fraction - before >= 5e-3 ? event(performance.now()) : null;
    },
    /** Every step with its duration, and the whole load's. */
    finish() {
      const now = performance.now();
      if (current) current.ms = Math.round(now - current.start);
      const steps = {};
      for (const t of timings) steps[t.key] = (steps[t.key] ?? 0) + t.ms;
      return {
        ms: elapsed(now),
        timings: timings.map(({ key, start, ...t }) => t),
        profile: { total: Math.max(1, timings.reduce((n, t) => n + t.ms, 0)), steps }
      };
    }
  };
}
function startWorker(url) {
  const u = new URL(url, location.href);
  if (u.origin === location.origin) return new Worker(u, { type: "module" });
  const blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(u.href)};`], { type: "text/javascript" }));
  const worker = new Worker(blobUrl, { type: "module" });
  const revoke = () => URL.revokeObjectURL(blobUrl);
  worker.addEventListener("message", revoke, { once: true });
  worker.addEventListener("error", revoke, { once: true });
  return worker;
}
async function explainStartFailure(workerUrl, err, ErrorClass, missingHint) {
  const url = new URL(workerUrl, location.href);
  const otherSite = url.origin !== location.origin;
  let res;
  try {
    res = await fetch(url, { method: "HEAD", cache: "no-store" });
  } catch {
    return new ErrorClass("download-failed", otherSite ? `could not load ${url.href}: is the site reachable, and does it send CORS headers (Access-Control-Allow-Origin)?` : `could not reach ${url.href} (is the server running, is the device online?)`, { cause: err });
  }
  if (res.status === 404) return new ErrorClass("engine-failed", `${url.href.replace(/\?.*/, "")} is missing${missingHint ? `: ${missingHint}` : ""}`, { cause: err });
  if (!res.ok) return new ErrorClass("download-failed", `${url.href}: ${res.status} ${res.statusText}`, { cause: err });
  return err;
}
function unsupported() {
  if (typeof WebAssembly !== "object") return "WebAssembly";
  if (typeof Worker !== "function") return "Web Workers";
  if (typeof indexedDB !== "object") return "IndexedDB";
  if (typeof DecompressionStream !== "function") return "DecompressionStream (Safari 16.4+)";
  return null;
}
function createPool({ prefix, ErrorClass = KakeraError }) {
  const LOADING = `${prefix}:loading:`, CRASHED = `${prefix}:crashed:`, PROFILE = `${prefix}:timings:`;
  safely(() => {
    const s = storageOf("session"), l = storageOf("local");
    for (const k of Object.keys(s)) {
      if (!k.startsWith(LOADING)) continue;
      l?.setItem(CRASHED + k.slice(LOADING.length), String(Date.now()));
      s.removeItem(k);
    }
  });
  const markLoading = (key) => safely(() => storageOf("session").setItem(LOADING + key, String(Date.now())));
  const clearLoading = (key) => safely(() => storageOf("session").removeItem(LOADING + key));
  const crashedAt = (key) => Number(safely(() => storageOf("local").getItem(CRASHED + key)) ?? 0);
  const forgetCrash = (key) => safely(() => storageOf("local").removeItem(CRASHED + key));
  const hosts = /* @__PURE__ */ new Map();
  const handlesWithHiddenHook = /* @__PURE__ */ new Set();
  class EngineHost {
    constructor({ name, manifestUrl, createWorker }) {
      this.name = name;
      this.url = manifestUrl;
      this.key = `${name}|${manifestUrl}`;
      this.createWorker = createWorker;
      this.status = "not-loaded";
      this.worker = null;
      this.loading = null;
      this.pending = /* @__PURE__ */ new Map();
      this.nextId = 1;
      this.users = /* @__PURE__ */ new Set();
      this.idleTimer = null;
      this.stopWhenDone = false;
    }
    active() {
      return [...this.users].filter((h) => h._active);
    }
    setStatus(status) {
      if (status === this.status) return;
      this.status = status;
      for (const h of this.users) h._emitStatus();
    }
    // ---- policy, combined over the handles using this engine
    idleMs() {
      const v = this.active().map((h) => h._opts.idleTimeout);
      return v.length === 0 || v.includes(0) ? 0 : Math.max(...v);
    }
    stopsWhenHidden() {
      const a = this.active();
      return a.length > 0 && a.every((h) => h._opts.stopWhenHidden);
    }
    loadStallMs() {
      return Math.max(...this.active().map((h) => h._opts.loadStall), 1);
    }
    /** Start the worker and load the engine. Shared: concurrent callers get the same promise. */
    load() {
      if (this.status === "ready") return Promise.resolve({ fromCache: true });
      this.loading ??= (async () => {
        markLoading(this.key);
        this.worker = this.createWorker();
        this.worker.onmessage = ({ data }) => this.onMessage(data);
        this.worker.onerror = (e) => {
          e.preventDefault?.();
          const loading = this.status !== "ready";
          this.kill(new ErrorClass(
            loading ? "engine-failed" : "worker-crashed",
            `${this.name} worker ${loading ? "failed to start" : "crashed"}: ${e.message || "unknown error"}`
          ));
        };
        this.setStatus("loading");
        const profileKey = `${PROFILE}${this.key}`;
        const tracker = loadTracker(safely(() => JSON.parse(storageOf("local").getItem(profileKey))) ?? null);
        const emit = (event, value) => {
          for (const h of this.active()) h._emit(event, value);
        };
        const ticker = setInterval(() => {
          const e = tracker.tick();
          if (e) emit("progress", e);
        }, 200);
        try {
          const result = await this.call({ type: "load", manifestUrl: this.url, dbName: prefix }, {
            stall: this.loadStallMs(),
            onProgress: (p) => {
              if (!p.step) return;
              const { event, newStep } = tracker.update(p);
              if (newStep) {
                const where = event.file ? ` ${event.file}${event.parts > 1 ? ` part ${event.part}/${event.parts}` : ""}` : "";
                emit("log", `${(event.ms / 1e3).toFixed(2)} s  ${event.step}${where}`);
              }
              if (p.step === "manifest") return;
              this.setStatus(event.stage === "downloading" ? "downloading" : "loading");
              emit("progress", event);
            }
          });
          clearInterval(ticker);
          const { ms, timings, profile } = tracker.finish();
          if (result?.fromCache !== false) safely(() => storageOf("local").setItem(profileKey, JSON.stringify(profile)));
          this.setStatus("ready");
          emit("progress", { stage: "ready", step: "ready", fraction: 1, ms });
          emit("log", `${(ms / 1e3).toFixed(2)} s  ready`);
          this.touch();
          return { fromCache: true, ...result, ms, timings };
        } catch (err) {
          if (this.worker) this.kill(err, "not-loaded");
          throw err;
        } finally {
          clearInterval(ticker);
          clearLoading(this.key);
          this.loading = null;
        }
      })();
      return this.loading;
    }
    /** Send a message; resolves with the worker's result. `stall` = ms without any message before giving up. */
    call(msg, { stall, signal, onProgress } = {}) {
      if (!this.worker) return Promise.reject(new ErrorClass("not-loaded", `${this.name} is not loaded`));
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        const entry = { resolve, reject, onProgress, stall, timer: null };
        const onAbort = () => {
          this.settle(id);
          reject(abortError());
        };
        entry.cleanup = () => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.pending.set(id, entry);
        this.armWatchdog(id);
        this.worker.postMessage({ id, ...msg });
      });
    }
    armWatchdog(id) {
      const e = this.pending.get(id);
      if (!e?.stall) return;
      clearTimeout(e.timer);
      e.timer = setTimeout(() => {
        this.kill(new ErrorClass("timeout", `${this.name} stopped responding (no progress for ${Math.round(e.stall / 1e3)} s); it was stopped to free memory`));
      }, e.stall);
    }
    /** Remove a pending call (finished, failed or aborted). */
    settle(id) {
      const e = this.pending.get(id);
      if (!e) return null;
      clearTimeout(e.timer);
      e.cleanup?.();
      this.pending.delete(id);
      if (this.pending.size === 0 && this.stopWhenDone) {
        this.stopWhenDone = false;
        queueMicrotask(() => this.unload());
      }
      return e;
    }
    onMessage(data) {
      const e = this.pending.get(data.id);
      if (!e) return;
      if (data.type === "done" || data.type === "error") {
        this.settle(data.id);
        if (data.type === "done") e.resolve(data.result);
        else e.reject(new ErrorClass(data.code ?? "engine-failed", data.message));
        return;
      }
      for (const id of this.pending.keys()) this.armWatchdog(id);
      if (data.type === "progress") e.onProgress?.(data);
      if (data.type === "log") for (const h of this.users) h._emit("log", data.msg);
    }
    /** Terminate the worker and reject everything pending with `err`. */
    kill(err, status = "stopped") {
      this.worker?.terminate();
      this.worker = null;
      clearTimeout(this.idleTimer);
      clearLoading(this.key);
      for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
      this.stopWhenDone = false;
      this.setStatus(this.status === "ready" || this.status === "stopped" ? status : "not-loaded");
    }
    /** Free the memory. The next call of a handle that loaded it reloads from the device. */
    unload() {
      if (!this.worker) return;
      this.kill(new ErrorClass("disposed", `${this.name} was unloaded`), "stopped");
    }
    /** Unload if no handle wants the engine any more. */
    release() {
      if (this.active().length === 0) this.unload();
    }
    /** Restart the idle countdown. */
    touch() {
      clearTimeout(this.idleTimer);
      const ms = this.idleMs();
      if (ms > 0 && this.status === "ready") {
        this.idleTimer = setTimeout(() => this.pending.size ? this.touch() : this.unload(), ms);
      }
    }
    onHidden() {
      if (this.status !== "ready" || !this.stopsWhenHidden()) return;
      if (this.pending.size) this.stopWhenDone = true;
      else this.unload();
    }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        for (const h of hosts.values()) h.onHidden();
        for (const h of handlesWithHiddenHook) safely(() => h._onHidden());
      }
    });
    addEventListener("pagehide", () => {
      for (const h of hosts.values()) if (h.loading) clearLoading(h.key);
    });
    addEventListener("pageshow", (e) => {
      if (e.persisted) {
        for (const h of hosts.values()) if (h.loading) markLoading(h.key);
      }
    });
  }
  class Handle {
    constructor(options) {
      const o = { ...DEFAULTS, ...options };
      if (o.workerUrl) o.createWorker = () => startWorker(o.workerUrl);
      if (!o.name || !o.filesUrl || typeof o.createWorker !== "function") throw new TypeError("handle(): name, filesUrl and workerUrl (or createWorker) are required");
      o.crashGuard = o.crashGuard === false ? false : { ...DEFAULTS.crashGuard, ...o.crashGuard };
      this._opts = o;
      const manifestUrl = new URL("manifest.json", new URL(o.filesUrl.endsWith("/") ? o.filesUrl : `${o.filesUrl}/`, location.href)).href;
      const key = `${o.name}|${manifestUrl}`;
      if (!hosts.has(key)) hosts.set(key, new EngineHost({ name: o.name, manifestUrl, createWorker: o.createWorker }));
      this._host = hosts.get(key);
      this._active = false;
      this._loaded = false;
      this._own = this._crashed() ? "unavailable" : "not-loaded";
      this._loadPromise = null;
      this._calls = /* @__PURE__ */ new Set();
      this._disposeCtrl = new AbortController();
      this._listeners = /* @__PURE__ */ new Map();
      this._lastStatus = this.status;
      this._files = fileStore({ dbName: prefix });
    }
    get status() {
      if (this._active) return this._host.status === "not-loaded" ? this._loaded ? "stopped" : "loading" : this._host.status;
      return this._loaded ? "stopped" : this._own;
    }
    /** Subscribe to "status", "progress" or "log". Returns an unsubscribe function. */
    on(event, listener) {
      if (!this._listeners.has(event)) this._listeners.set(event, /* @__PURE__ */ new Set());
      const set = this._listeners.get(event);
      set.add(listener);
      return () => set.delete(listener);
    }
    _emit(event, value) {
      for (const fn of this._listeners.get(event) ?? []) safely(() => fn(value));
    }
    _emitStatus() {
      const s = this.status;
      if (s === this._lastStatus) return;
      this._lastStatus = s;
      this._emit("status", s);
    }
    /** Called when the page is hidden (for packages that also stop playback then). */
    onHidden(fn) {
      this._onHidden = fn;
      handlesWithHiddenHook.add(this);
    }
    _crashed() {
      const g = this._opts.crashGuard;
      if (!g) return false;
      const t = crashedAt(this._host.key);
      return t > 0 && Date.now() - t < g.retryAfterDays * 864e5;
    }
    _attach() {
      this._active = true;
      this._host.users.add(this);
      this._emitStatus();
    }
    async info() {
      const { cached, downloadBytes } = await this._files.info(this._host.url);
      return { cached, downloadBytes, downloadMB: Math.round(downloadBytes / 1e6) };
    }
    load() {
      if (this._loaded && this._active && this._host.status === "ready") return Promise.resolve({ fromCache: true });
      this._loadPromise ??= this._load().finally(() => {
        this._loadPromise = null;
      });
      return this._loadPromise;
    }
    async _load() {
      const missing = unsupported();
      if (missing) {
        this._fail("error");
        throw new ErrorClass("unsupported-browser", `this browser lacks ${missing}`);
      }
      if (this._crashed()) {
        this._fail("unavailable");
        throw new ErrorClass("unavailable", `loading ${this._opts.name} crashed this tab recently; not loading it again yet (resetCrashGuard() to retry)`);
      }
      this._attach();
      try {
        const res = await this._host.load();
        this._loaded = true;
        this._emitStatus();
        if (!res.fromCache && this._opts.persistStorage) navigator.storage?.persist?.()?.catch?.(() => {
        });
        return { fromCache: !!res.fromCache, ...res.timings && { ms: res.ms, timings: res.timings } };
      } catch (err) {
        this._active = false;
        this._host.users.delete(this);
        this._host.release();
        this._fail("error");
        const { workerUrl, missingHint } = this._opts;
        throw workerUrl && err.code === "engine-failed" && /failed to start/.test(err.message) ? await explainStartFailure(workerUrl, err, ErrorClass, missingHint) : err;
      }
    }
    _fail(status) {
      this._own = status;
      this._emitStatus();
    }
    /**
     * Run a call in the worker. Reloads the engine first if it was unloaded (idle, hidden, unload()).
     * @param {string} type
     * @param {object} payload
     * @param {{ stall?: number, signal?: AbortSignal }} [o]
     */
    call(type, payload = {}, { stall, signal } = {}) {
      if (!this._loaded) return Promise.reject(new ErrorClass("not-loaded", "call load() first"));
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      const disposed = this._disposeCtrl.signal;
      signal?.addEventListener("abort", abort, { once: true });
      disposed.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) ctrl.abort();
      return new Promise((resolve, reject) => {
        const entry = reject;
        this._calls.add(entry);
        (async () => {
          if (!this._active) this._attach();
          if (this._host.status !== "ready") await this._host.load();
          if (ctrl.signal.aborted) throw abortError();
          const result = await this._host.call({ type, ...payload }, { stall, signal: ctrl.signal });
          this._host.touch();
          return result;
        })().then(resolve, reject).finally(() => {
          this._calls.delete(entry);
          signal?.removeEventListener("abort", abort);
          disposed.removeEventListener("abort", abort);
        });
      });
    }
    /** Free the memory now, if no other handle needs the engine. The next call reloads it from the device. */
    unload() {
      if (!this._active) return;
      this._active = false;
      this._host.release();
      this._emitStatus();
    }
    /** Back to "not-loaded": pending calls reject with "disposed"; load() is needed again. */
    dispose() {
      const err = new ErrorClass("disposed", "disposed");
      for (const reject of [...this._calls]) reject(err);
      this._calls.clear();
      this._disposeCtrl.abort();
      this._disposeCtrl = new AbortController();
      this._active = false;
      this._loaded = false;
      this._host.users.delete(this);
      this._host.release();
      handlesWithHiddenHook.delete(this);
      this._own = "not-loaded";
      this._emitStatus();
    }
    /** Delete the engine's files from this device. */
    async clearCache() {
      await this._files.clear(this._host.url);
    }
    /** Forget a recorded crash so the next load() tries again. */
    resetCrashGuard() {
      forgetCrash(this._host.key);
      if (this._own === "unavailable") this._fail("not-loaded");
    }
  }
  return {
    handle: (options) => new Handle(options),
    /** For tests: the page's engines. */
    engines: () => [...hosts.values()].map((h) => ({ name: h.name, status: h.status, worker: !!h.worker, users: h.users.size }))
  };
}

// src/readings.js
var toKatakana = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 96));
var WORDS = {
  "\u79C1": "\u30EF\u30BF\u30B7",
  "\u660E\u65E5": "\u30A2\u30B7\u30BF",
  "\u65E5\u672C": "\u30CB\u30DB\u30F3",
  "\u4E00\u5EA6": "\u30A4\u30C1\u30C9",
  "\u4F55\u4EBA": "\u30CA\u30F3\u30CB\u30F3",
  "\u4F55\u5206": "\u30CA\u30F3\u30D7\u30F3",
  "\u4E0A\u624B": "\u30B8\u30E7\u30A6\u30BA",
  "\u6216\u3044\u306F": "\u30A2\u30EB\u30A4\u30CF",
  "\u82E5\u3057\u304F\u306F": "\u30E2\u30B7\u30AF\u30CF",
  "\u6240\u8B02": "\u30A4\u30EF\u30E6\u30EB",
  "\u7169\u3044": "\u30A6\u30EB\u30B5\u30A4",
  "\u4E0D\u5473\u3044": "\u30DE\u30BA\u30A4"
};
var FAMILY = { "\u7236": "\u30C8\u30A6", "\u6BCD": "\u30AB\u30A2", "\u5144": "\u30CB\u30A4", "\u59C9": "\u30CD\u30A8" };
var FAMILY_AFTER = /* @__PURE__ */ new Set(["\u3055\u3093", "\u3061\u3083\u3093", "\u69D8", "\u3055\u307E"]);
var NANI_BEFORE = /* @__PURE__ */ new Set(["\u304B", "\u3082", "\u304C", "\u3092", "\u306B", "\u304B\u3089", "\u307E\u3067", "\u3088\u308A", "\u305D\u308C", "\u3053\u308C", "\u3042\u308C", "\u4E00\u3064"]);
var JIN_AFTER = /* @__PURE__ */ new Set([
  "\u793E\u4F1A",
  "\u5B87\u5B99",
  "\u6709\u540D",
  "\u5730\u7403",
  "\u82B8\u80FD",
  "\u7570\u90A6",
  "\u4E00\u822C",
  "\u73FE\u4EE3",
  "\u7570\u661F",
  "\u77E5\u8B58",
  "\u6C11\u9593",
  "\u82F1",
  "\u8457\u540D",
  "\u500B\u3005",
  "\u6B27\u7C73",
  "\u672A\u6765",
  "\u65E5\u7CFB",
  "\u897F\u6D0B",
  "\u91CE\u86EE",
  "\u770C",
  "\u539F\u59CB",
  "\u81EA\u7531",
  "\u6587\u5316",
  "\u706B\u661F",
  "\u5916\u56FD",
  "\u65E5\u672C"
]);
var JO_AFTER = /* @__PURE__ */ new Set([
  "\u7814\u7A76",
  "\u76F8\u8AC7",
  "\u505C\u7559",
  "\u4FDD\u5065",
  "\u51FA\u5F35",
  "\u6D3E\u51FA",
  "\u8A3A\u7642",
  "\u53CE\u5BB9",
  "\u6D17\u9762",
  "\u767A\u884C",
  "\u6559\u7FD2",
  "\u8208\u4FE1",
  "\u8131\u8863",
  "\u907F\u96E3",
  "\u53D6\u5F15",
  "\u9020\u8239",
  "\u691C\u554F",
  "\u5370\u5237",
  "\u990A\u6210",
  "\u7559\u7F6E",
  "\u89B3\u6E2C",
  "\u64AE\u5F71"
]);
var JUU_AFTER = /* @__PURE__ */ new Set(["\u4E16\u754C", "\u4E00\u65E5", "\u65E5\u672C", "\u4E00\u6669", "\u8EAB\u4F53", "\u9854", "\u4E00\u5E74", "\u56FD", "\u6751"]);
var SHI_BEFORE = /* @__PURE__ */ new Set(["\u751F\u6D3B", "\u7ACB", "\u6709", "\u9244", "\u670D", "\u7269", "\u7528", "\u4E8B", "\u7684", "\u60C5", "\u5FC3", "\u6B32", "\u8CBB", "\u898B", "\u8A2D", "\u90B8", "\u8A9E", "\u5229", "\u6028", "\u8CA1"]);
var NIPPON_BEFORE = /* @__PURE__ */ new Set(["\u9280\u884C", "\u751F\u547D", "\u901A\u904B", "\u96FB\u6C17", "\u5E1D\u56FD", "\u653E\u9001", "\u9244\u9053", "\u6B66\u9053\u9928", "\u6A4B"]);
var NIPPON_AFTER = /* @__PURE__ */ new Set(["\u5927", "\u8FD1\u757F", "\u5168"]);
var GAISHA_AFTER = /* @__PURE__ */ new Set(["\u682A\u5F0F", "\u5B50", "\u89AA", "\u5408\u540C", "\u5408\u8CC7", "\u6709\u9650", "\u95A2\u9023"]);
var neighbour = (w) => w && w.pos !== "\u7A7A\u767D" ? w : null;
var nextWord = (ws, i) => neighbour(ws[i + 1]);
var prevWord = (ws, i) => neighbour(ws[i - 1]);
function fixWord(ws, i) {
  const w = ws[i];
  const next = nextWord(ws, i), prev = prevWord(ws, i);
  if (w.surface === "\u79C1" && SHI_BEFORE.has(next?.surface)) return "\u30B7";
  if (w.surface === "\u79C1") return w.reading === "\u30EF\u30BF\u30AF\u30B7" && !["\u3069\u3082", "\u3081"].includes(next?.surface) ? "\u30EF\u30BF\u30B7" : null;
  if (w.surface === "\u65E5\u672C" && (NIPPON_BEFORE.has(next?.surface) || NIPPON_AFTER.has(prev?.surface))) return null;
  if (WORDS[w.surface] && w.reading) return WORDS[w.surface];
  if (w.dictionaryForm === "\u8A00\u3046" && w.reading.startsWith("\u30E6")) return `\u30A4${w.reading.slice(1)}`;
  if (FAMILY[w.surface] && next && FAMILY_AFTER.has(next.surface)) return FAMILY[w.surface];
  if (w.surface === "\u4F55" && w.reading === "\u30CA\u30F3" && next && NANI_BEFORE.has(next.surface) && !(next.surface === "\u306B" && ["\u3057", "\u305B\u3088"].includes(nextWord(ws, ws.indexOf(next))?.surface))) return "\u30CA\u30CB";
  const before = prev ? [prev.surface, (prevWord(ws, ws.indexOf(prev))?.surface ?? "") + prev.surface] : [];
  const after = (set) => before.some((b) => set.has(b));
  if (w.surface === "\u4EBA" && w.reading === "\u30CB\u30F3" && prev && (prev.posDetail[2] === "\u5730\u540D" || after(JIN_AFTER))) return "\u30B8\u30F3";
  if (w.surface === "\u6240" && w.reading === "\u30B7\u30E7" && after(JO_AFTER)) return "\u30B8\u30E7";
  if (w.surface === "\u4E2D" && w.reading === "\u30C1\u30E5\u30A6" && after(JUU_AFTER)) return "\u30B8\u30E5\u30A6";
  if (w.surface === "\u4F1A\u793E" && prev && (GAISHA_AFTER.has(prev.surface) || prev.pos === "\u540D\u8A5E" && !prev.tags.includes("\u6570\u8A5E") || prev.pos === "\u63A5\u982D\u8F9E")) return "\u30AC\u30A4\u30B7\u30E3";
  if (w.surface === "\u901A\u308A" && w.reading === "\u30C8\u30AA\u30EA" && prev && (["\u540D\u8A5E", "\u4EE3\u540D\u8A5E", "\u526F\u8A5E", "\u63A5\u5C3E\u8F9E"].includes(prev.pos) || prev.surface === "\u307E\u3067")) return "\u30C9\u30AA\u30EA";
  if (w.surface === "\u65E5" && (prev?.surface === "\u8A95\u751F" || prev?.surface.endsWith("\u66DC"))) return "\u30D3";
  if (w.dictionaryForm === "\u5165\u308B" && w.reading.startsWith("\u30CF\u30A4") && prev?.surface === "\u306B" && prevWord(ws, ws.indexOf(prev))?.surface === "\u6C17") return w.reading.slice(1);
  if (/^[1１一]日$/.test(w.surface) && w.reading === "\u30C4\u30A4\u30BF\u30C1" && prev?.surface !== "\u6708") return "\u30A4\u30C1\u30CB\u30C1";
  return null;
}
var ONES = ["", "\u30A4\u30C1", "\u30CB", "\u30B5\u30F3", "\u30E8\u30F3", "\u30B4", "\u30ED\u30AF", "\u30CA\u30CA", "\u30CF\u30C1", "\u30AD\u30E5\u30A6"];
var DIGIT_SPOKEN = ["\u30BC\u30ED", "\u30A4\u30C1", "\u30CB", "\u30B5\u30F3", "\u30E8\u30F3", "\u30B4", "\u30ED\u30AF", "\u30CA\u30CA", "\u30CF\u30C1", "\u30AD\u30E5\u30A6"];
var KANJI_DIGIT = { "\u3007": 0, "\u96F6": 0, "\u4E00": 1, "\u4E8C": 2, "\u4E09": 3, "\u56DB": 4, "\u4E94": 5, "\u516D": 6, "\u4E03": 7, "\u516B": 8, "\u4E5D": 9 };
var KANJI_SMALL = { "\u5341": 10, "\u767E": 100, "\u5343": 1e3 };
var KANJI_BIG = { "\u4E07": 1e4, "\u5104": 1e8, "\u5146": 1e12 };
var isDigitText = (s) => /^[0-9０-９]+$/.test(s);
var isNumeralWord = (w) => w.tags.includes("\u6570\u8A5E") && w.surface !== "\u4F55" && (/^[0-9０-９][0-9０-９,，.．]*$/.test(w.surface) || /^[〇零一二三四五六七八九十百千万億兆]+$/.test(w.surface));
var D = "[0-9\uFF10-\uFF19]";
var NUMBER_TEXT = new RegExp(`^(${D}{1,3}([,\uFF0C]${D}{3})+|${D}+)([.\uFF0E]${D}+)?$`);
var halfWidth = (s) => s.replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248));
function parseNumber(s) {
  s = halfWidth(s).replace(/,/g, "");
  if (/^[0-9]+$/.test(s)) return Number(s);
  if (/^[〇零一二三四五六七八九]+$/.test(s) && s.length > 1) {
    return /[〇零]/.test(s) ? Number([...s].map((c) => KANJI_DIGIT[c]).join("")) : null;
  }
  let total = 0, section = 0, buf = null;
  for (const c of s) {
    if (/[0-9]/.test(c)) buf = (buf ?? 0) * 10 + Number(c);
    else if (c in KANJI_DIGIT) buf = (buf ?? 0) * 10 + KANJI_DIGIT[c];
    else if (c in KANJI_SMALL) {
      section += (buf ?? 1) * KANJI_SMALL[c];
      buf = null;
    } else if (c in KANJI_BIG) {
      total += (section + (buf ?? 0) || 1) * KANJI_BIG[c];
      section = 0;
      buf = null;
    } else return null;
  }
  const n = total + section + (buf ?? 0);
  return Number.isSafeInteger(n) ? n : null;
}
function smallPieces(n) {
  const out = [];
  const [th, hu, te, on] = [Math.floor(n / 1e3), Math.floor(n / 100) % 10, Math.floor(n / 10) % 10, n % 10];
  if (th) out.push({ 1: "\u30BB\u30F3", 3: "\u30B5\u30F3\u30BC\u30F3", 8: "\u30CF\u30C3\u30BB\u30F3" }[th] ?? `${ONES[th]}\u30BB\u30F3`);
  if (hu) out.push({ 1: "\u30D2\u30E3\u30AF", 3: "\u30B5\u30F3\u30D3\u30E3\u30AF", 6: "\u30ED\u30C3\u30D4\u30E3\u30AF", 8: "\u30CF\u30C3\u30D4\u30E3\u30AF" }[hu] ?? `${ONES[hu]}\u30D2\u30E3\u30AF`);
  if (te) out.push(te === 1 ? "\u30B8\u30E5\u30A6" : `${ONES[te]}\u30B8\u30E5\u30A6`);
  if (on) out.push(ONES[on]);
  return out;
}
function numberPieces(n) {
  if (n === 0) return ["\u30BC\u30ED"];
  const out = [];
  for (const [unit, name] of [[1e12, "\u30C1\u30E7\u30A6"], [1e8, "\u30AA\u30AF"], [1e4, "\u30DE\u30F3"]]) {
    const k = Math.floor(n / unit) % 1e4;
    if (k) out.push(...smallPieces(k), name);
  }
  out.push(...smallPieces(n % 1e4));
  if (out[0] === "\u30A4\u30C1" && out[1] === "\u30C1\u30E7\u30A6") out[0] = "\u30A4\u30C3";
  return out;
}
var GEM_KST = ["\u30A4\u30C1", "\u30CF\u30C1", "\u30B8\u30E5\u30A6"];
var GEM_K = [...GEM_KST, "\u30ED\u30AF", "\u30D2\u30E3\u30AF"];
var COUNTERS = {
  // か-row
  "\u56DE": { gem: GEM_K },
  "\u500B": { gem: GEM_K },
  "\u968E": { gem: GEM_K, afterN: "\u30AC\u30A4" },
  "\u8AB2": { gem: GEM_K },
  "\u30F6\u6708": { gem: GEM_K },
  "\u304B\u6708": { gem: GEM_K },
  "\u30AB\u6708": { gem: GEM_K },
  "\u30B1\u6708": { gem: GEM_K },
  "\u7B87\u6708": { gem: GEM_K },
  "\u66F2": { gem: GEM_K },
  "\u4EF6": { gem: GEM_K },
  "\u8ED2": { gem: GEM_K, afterN: "\u30B2\u30F3" },
  "\u6821": { gem: GEM_K },
  // さ / た-row
  "\u6B73": { gem: GEM_KST },
  "\u624D": { gem: GEM_KST },
  "\u518A": { gem: GEM_KST },
  "\u9031": { gem: GEM_KST },
  "\u9031\u9593": { gem: GEM_KST },
  "\u901A": { gem: GEM_KST },
  "\u7740": { gem: GEM_KST },
  "\u982D": { gem: GEM_KST },
  "\u70B9": { gem: GEM_KST },
  "\u8DB3": { gem: GEM_KST },
  // は-row: いっぽん, さんぼん, よんほん; いっぷん, さんぷん, よんぷん
  "\u672C": { gem: GEM_K, h: "b" },
  "\u676F": { gem: GEM_K, h: "b" },
  "\u5339": { gem: GEM_K, h: "b" },
  "\u5206": { gem: GEM_K, h: "p", pAfterYon: true },
  "\u6CCA": { gem: GEM_K, h: "p" },
  "\u767A": { gem: GEM_K, h: "p" },
  "\u6B69": { gem: GEM_K, h: "p" },
  "\u7968": { gem: GEM_K, h: "p" },
  "\u54C1": { gem: GEM_K, h: "p" },
  // no sound change, but よ / し / く for 4, 7, 9
  "\u6642": { four: "\u30E8", seven: "\u30B7\u30C1", nine: "\u30AF" },
  "\u6642\u9593": { four: "\u30E8" },
  "\u5E74": { four: "\u30E8" },
  "\u5186": { four: "\u30E8" },
  "\u6708": { four: "\u30B7", seven: "\u30B7\u30C1", nine: "\u30AF" },
  "\u4EBA": { four: "\u30E8" }
};
var BASE = {
  "\u56DE": "\u30AB\u30A4",
  "\u500B": "\u30B3",
  "\u968E": "\u30AB\u30A4",
  "\u8AB2": "\u30AB",
  "\u30F6\u6708": "\u30AB\u30B2\u30C4",
  "\u304B\u6708": "\u30AB\u30B2\u30C4",
  "\u30AB\u6708": "\u30AB\u30B2\u30C4",
  "\u30B1\u6708": "\u30AB\u30B2\u30C4",
  "\u7B87\u6708": "\u30AB\u30B2\u30C4",
  "\u66F2": "\u30AD\u30E7\u30AF",
  "\u4EF6": "\u30B1\u30F3",
  "\u8ED2": "\u30B1\u30F3",
  "\u6821": "\u30B3\u30A6",
  "\u6B73": "\u30B5\u30A4",
  "\u624D": "\u30B5\u30A4",
  "\u518A": "\u30B5\u30C4",
  "\u9031": "\u30B7\u30E5\u30A6",
  "\u9031\u9593": "\u30B7\u30E5\u30A6\u30AB\u30F3",
  "\u901A": "\u30C4\u30A6",
  "\u7740": "\u30C1\u30E3\u30AF",
  "\u982D": "\u30C8\u30A6",
  "\u70B9": "\u30C6\u30F3",
  "\u8DB3": "\u30BD\u30AF",
  "\u672C": "\u30DB\u30F3",
  "\u676F": "\u30CF\u30A4",
  "\u5339": "\u30D2\u30AD",
  "\u5206": "\u30D5\u30F3",
  "\u6CCA": "\u30CF\u30AF",
  "\u767A": "\u30CF\u30C4",
  "\u6B69": "\u30DB",
  "\u7968": "\u30D2\u30E7\u30A6",
  "\u54C1": "\u30D2\u30F3",
  "\u6642": "\u30B8",
  "\u6642\u9593": "\u30B8\u30AB\u30F3",
  "\u5E74": "\u30CD\u30F3",
  "\u5186": "\u30A8\u30F3",
  "\u6708": "\u30AC\u30C4",
  "\u4EBA": "\u30CB\u30F3"
};
var H_TO = { b: { "\u30CF": "\u30D0", "\u30D2": "\u30D3", "\u30D5": "\u30D6", "\u30D8": "\u30D9", "\u30DB": "\u30DC" }, p: { "\u30CF": "\u30D1", "\u30D2": "\u30D4", "\u30D5": "\u30D7", "\u30D8": "\u30DA", "\u30DB": "\u30DD" } };
var DAYS = { 1: "\u30C4\u30A4\u30BF\u30C1", 2: "\u30D5\u30C4\u30AB", 3: "\u30DF\u30C3\u30AB", 4: "\u30E8\u30C3\u30AB", 5: "\u30A4\u30C4\u30AB", 6: "\u30E0\u30A4\u30AB", 7: "\u30CA\u30CE\u30AB", 8: "\u30E8\u30A6\u30AB", 9: "\u30B3\u30B3\u30CE\u30AB", 10: "\u30C8\u30AA\u30AB", 14: "\u30B8\u30E5\u30A6\u30E8\u30C3\u30AB", 20: "\u30CF\u30C4\u30AB", 24: "\u30CB\u30B8\u30E5\u30A6\u30E8\u30C3\u30AB" };
var TSU = { 1: "\u30D2\u30C8\u30C4", 2: "\u30D5\u30BF\u30C4", 3: "\u30DF\u30C3\u30C4", 4: "\u30E8\u30C3\u30C4", 5: "\u30A4\u30C4\u30C4", 6: "\u30E0\u30C3\u30C4", 7: "\u30CA\u30CA\u30C4", 8: "\u30E4\u30C3\u30C4", 9: "\u30B3\u30B3\u30CE\u30C4" };
var PEOPLE = { 1: "\u30D2\u30C8\u30EA", 2: "\u30D5\u30BF\u30EA" };
var CUT = { "\u30A4\u30C1": "\u30A4\u30C3", "\u30ED\u30AF": "\u30ED\u30C3", "\u30CF\u30C1": "\u30CF\u30C3", "\u30B8\u30E5\u30A6": "\u30B8\u30E5\u30C3", "\u30D2\u30E3\u30AF": "\u30D2\u30E3\u30C3" };
function countReading(n, pieces, counter, { afterMonth = false, afterDai = false } = {}) {
  if (counter === "\u65E5" && n != null) {
    if (n === 1 && !afterMonth) return { number: "\u30A4\u30C1", counter: "\u30CB\u30C1" };
    if (DAYS[n]) return { whole: DAYS[n] };
    const ones2 = n % 10;
    const last2 = ones2 === 7 ? "\u30B7\u30C1" : ones2 === 9 ? "\u30AF" : pieces.at(-1);
    return { number: pieces.slice(0, -1).join("") + last2, counter: "\u30CB\u30C1" };
  }
  if (counter === "\u3064" && TSU[n]) return { whole: TSU[n] };
  if (counter === "\u4EBA" && PEOPLE[n] && !afterDai) return { whole: PEOPLE[n] };
  if ((counter === "\u6B73" || counter === "\u624D") && n === 20) return { whole: "\u30CF\u30BF\u30C1" };
  const rule = COUNTERS[counter];
  if (!rule) return null;
  const head = pieces.slice(0, -1).join("");
  let last = pieces.at(-1);
  let reading = BASE[counter];
  const ones = n != null && n % 10 !== 0 && pieces.at(-1) === ONES[n % 10];
  if (ones && n % 10 === 4 && rule.four) last = rule.four;
  if (ones && n % 10 === 7 && rule.seven) last = rule.seven;
  if (ones && n % 10 === 9 && rule.nine) last = rule.nine;
  const cut = rule.gem && CUT[Object.keys(CUT).find((k) => last.endsWith(k) && rule.gem.includes(k))];
  if (cut) {
    last = last.slice(0, last.length - Object.keys(CUT).find((k) => last.endsWith(k)).length) + cut;
    if (rule.h) reading = (H_TO.p[reading[0]] ?? reading[0]) + reading.slice(1);
  } else if (last.endsWith("\u30F3")) {
    const yon = last.endsWith("\u30E8\u30F3");
    if (rule.h === "b" && !yon) reading = H_TO.b[reading[0]] + reading.slice(1);
    if (rule.h === "p" && (!yon || rule.pAfterYon)) reading = H_TO.p[reading[0]] + reading.slice(1);
    if (rule.afterN && !yon) reading = rule.afterN;
  }
  return { number: head + last, counter: reading };
}
function merged(ws, i, j, reading) {
  const first = ws[i], last = ws[j - 1];
  return {
    ...first,
    surface: ws.slice(i, j).map((w) => w.surface).join(""),
    reading,
    dictionaryForm: ws.slice(i, j).map((w) => w.dictionaryForm).join(""),
    normalizedForm: ws.slice(i, j).map((w) => w.normalizedForm).join(""),
    end: last.end
  };
}
function fixNumbers(ws) {
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const isNan = w.surface === "\u4F55" && w.reading === "\u30CA\u30F3";
    if (!isNumeralWord(w) && !isNan) {
      out.push(w);
      continue;
    }
    let j = i + 1;
    if (!isNan) {
      while (j < ws.length) {
        if (isNumeralWord(ws[j])) {
          j++;
          continue;
        }
        const between = isDigitText(ws[j - 1].surface) && ws[j + 1] && isDigitText(ws[j + 1].surface);
        if (between && /^[,，.．]$/.test(ws[j].surface)) {
          j++;
          continue;
        }
        break;
      }
    }
    const runText = ws.slice(i, j).map((x) => x.surface).join("");
    const digits = /^[0-9０-９]/.test(runText);
    if (digits && !NUMBER_TEXT.test(runText)) {
      out.push(...ws.slice(i, j));
      i = j - 1;
      continue;
    }
    const [intPart, frac] = digits ? halfWidth(runText).replace(/,/g, "").split(".") : [runText, void 0];
    const decimal = frac === void 0 ? -1 : 1;
    const n = isNan || /^[万億兆]/.test(w.surface) ? null : parseNumber(intPart);
    if (!isNan && n == null) {
      out.push(...ws.slice(i, j));
      i = j - 1;
      continue;
    }
    let pieces = isNan ? ["\u30CA\u30F3"] : numberPieces(n);
    if (/^0[0-9]+$/.test(intPart)) pieces = [[...intPart].map((d) => DIGIT_SPOKEN[d]).join("")];
    if (frac !== void 0) pieces = [...pieces.slice(0, -1), pieces.at(-1) + "\u30C6\u30F3" + [...frac].map((d) => DIGIT_SPOKEN[d]).join("")];
    let counter = ws[j];
    if (counter?.surface === "\u5206" && ws[j + 1]?.surface === "\u306E") counter = null;
    if (n === 0 && decimal < 0 && counter?.tags.includes("\u52A9\u6570\u8A5E")) pieces = ["\u30EC\u30A4"];
    const hasRule = counter && decimal < 0 && (counter.tags.includes("\u52A9\u6570\u8A5E") || counter.pos === "\u63A5\u5C3E\u8F9E") && countReading(n, pieces, counter.surface);
    if (j - i === 1 && !digits && !isNan && !hasRule) {
      out.push(w);
      continue;
    }
    const prev = out.at(-1);
    const rule = counter && decimal < 0 && (counter.tags.includes("\u52A9\u6570\u8A5E") || counter.pos === "\u63A5\u5C3E\u8F9E") ? countReading(isNan ? null : n, pieces, counter.surface, { afterMonth: prev?.surface.endsWith("\u6708"), afterDai: prev?.surface === "\u7B2C" }) : null;
    if (rule?.whole) {
      out.push({ ...merged(ws, i, j + 1, rule.whole), pos: "\u540D\u8A5E", tags: ["\u6570\u8A5E", "\u52A9\u6570\u8A5E"] });
      i = j;
      continue;
    }
    out.push(j - i > 1 || !isNan ? { ...merged(ws, i, j, rule ? rule.number : pieces.join("")), pos: "\u540D\u8A5E" } : { ...w, reading: rule ? rule.number : w.reading });
    if (rule) {
      out.push({ ...counter, reading: rule.counter });
      i = j;
    } else i = j - 1;
  }
  return out;
}
function applyOwn(ws, own) {
  const keys = Object.keys(own).sort((a, b) => b.length - a.length);
  if (!keys.length) return ws;
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    let hit = null;
    for (const k of keys) {
      if (!k.startsWith(ws[i].surface)) continue;
      let s = "", j = i;
      while (j < ws.length && s.length < k.length) s += ws[j++].surface;
      if (s === k) {
        hit = { j, reading: toKatakana(own[k]) };
        break;
      }
    }
    if (!hit) {
      out.push(ws[i]);
      continue;
    }
    out.push(hit.j - i === 1 ? { ...ws[i], reading: hit.reading } : merged(ws, i, hit.j, hit.reading));
    i = hit.j - 1;
  }
  return out;
}
function fixReadings(words, { everydayReadings = true, readings = {} } = {}) {
  let ws = words;
  if (everydayReadings) {
    ws = fixNumbers(ws);
    ws = ws.map((w, i) => {
      const r = fixWord(ws, i);
      return r == null ? w : { ...w, reading: r };
    });
  }
  return applyOwn(ws, readings);
}

// src/text.js
var KANJI = /[㐀-鿿豈-﫿々〆ヵヶ]/;
var DIGIT = /[0-9０-９]/;
var isRubyChar = (c) => KANJI.test(c) || DIGIT.test(c);
var toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 96));
function furigana({ surface, reading }) {
  if (!reading || ![...surface].some(isRubyChar)) return [{ text: surface }];
  const hira = toHiragana(reading);
  const whole = [{ text: surface, reading: hira }];
  const runs = [];
  for (const ch of surface) {
    const k = isRubyChar(ch);
    const last = runs.at(-1);
    if (last && last.k === k) last.text += ch;
    else runs.push({ k, text: ch });
  }
  const out = [];
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.k) {
      const h = toHiragana(run.text);
      if (!hira.startsWith(h, pos)) return whole;
      out.push({ text: run.text });
      pos += h.length;
    } else {
      const next = runs[i + 1];
      const end = next ? hira.indexOf(toHiragana(next.text), pos + 1) : hira.length;
      if (end <= pos) return whole;
      out.push({ text: run.text, reading: hira.slice(pos, end) });
      pos = end;
    }
  }
  return pos === hira.length ? out : whole;
}
function furiganaOf(words) {
  const out = [];
  for (const w of words) {
    for (const seg of furigana(w)) {
      const last = out.at(-1);
      if (!seg.reading && last && !last.reading) last.text += seg.text;
      else out.push({ ...seg });
    }
  }
  return out;
}
function groupBunsetsu(words) {
  const groups = [];
  let cur = null;
  let attachNext = false;
  const start = (w) => {
    cur = { morphemes: [w] };
    groups.push(cur);
  };
  const add = (w) => cur ? cur.morphemes.push(w) : start(w);
  for (const w of words) {
    if (w.pos === "\u7A7A\u767D" || !w.surface.trim()) {
      cur = null;
      attachNext = false;
      continue;
    }
    const prev = cur?.morphemes.at(-1);
    if (w.tags.includes("\u62EC\u5F27\u958B")) {
      start(w);
      attachNext = true;
      continue;
    }
    if (w.pos === "\u88DC\u52A9\u8A18\u53F7" || w.pos === "\u8A18\u53F7") {
      add(w);
      attachNext = false;
      continue;
    }
    if (w.pos === "\u63A5\u982D\u8F9E") {
      start(w);
      attachNext = true;
      continue;
    }
    if (attachNext && cur) {
      cur.morphemes.push(w);
      attachNext = false;
      continue;
    }
    attachNext = false;
    if (w.pos === "\u52A9\u8A5E" || w.pos === "\u52A9\u52D5\u8A5E" || w.pos === "\u63A5\u5C3E\u8F9E") {
      add(w);
      continue;
    }
    if (cur && prev) {
      const helper = w.tags.includes("\u975E\u81EA\u7ACB\u53EF\u80FD") && (w.pos === "\u52D5\u8A5E" || w.pos === "\u5F62\u5BB9\u8A5E") && (prev.pos === "\u52D5\u8A5E" || prev.pos === "\u52A9\u52D5\u8A5E" || prev.pos === "\u5F62\u5BB9\u8A5E" || prev.tags.includes("\u63A5\u7D9A\u52A9\u8A5E"));
      const counter = w.pos === "\u540D\u8A5E" && (w.tags.includes("\u6570\u8A5E") || w.tags.includes("\u52A9\u6570\u8A5E")) && prev.tags.includes("\u6570\u8A5E");
      const nameSuffix = w.pos === "\u540D\u8A5E" && [...w.surface].length === 1 && KANJI.test(w.surface) && prev.pos === "\u540D\u8A5E" && prev.tags.includes("\u56FA\u6709\u540D\u8A5E");
      if (helper || counter || nameSuffix) {
        cur.morphemes.push(w);
        continue;
      }
    }
    start(w);
  }
  const NON_HEAD = /* @__PURE__ */ new Set(["\u52A9\u8A5E", "\u52A9\u52D5\u8A5E", "\u63A5\u5C3E\u8F9E", "\u88DC\u52A9\u8A18\u53F7", "\u8A18\u53F7", "\u63A5\u982D\u8F9E"]);
  return groups.map(({ morphemes }) => {
    const i = morphemes.findIndex((w) => !NON_HEAD.has(w.pos));
    const head = i < 0 ? [morphemes[0]] : morphemes.slice(0, i + 1);
    return {
      surface: morphemes.map((w) => w.surface).join(""),
      morphemes,
      head,
      headDictionaryForm: head.map((w) => w.dictionaryForm || w.surface).join(""),
      start: morphemes[0].start,
      end: morphemes.at(-1).end
    };
  });
}
var POS_ENGLISH = Object.freeze({
  // first level: what `pos` holds
  "\u540D\u8A5E": "noun",
  "\u4EE3\u540D\u8A5E": "pronoun",
  "\u52D5\u8A5E": "verb",
  "\u5F62\u5BB9\u8A5E": "adjective (\u3044)",
  "\u5F62\u72B6\u8A5E": "adjectival noun (\u306A)",
  "\u526F\u8A5E": "adverb",
  "\u9023\u4F53\u8A5E": "adnominal",
  "\u63A5\u7D9A\u8A5E": "conjunction",
  "\u611F\u52D5\u8A5E": "interjection",
  "\u52A9\u8A5E": "particle",
  "\u52A9\u52D5\u8A5E": "auxiliary verb",
  "\u63A5\u982D\u8F9E": "prefix",
  "\u63A5\u5C3E\u8F9E": "suffix",
  "\u88DC\u52A9\u8A18\u53F7": "punctuation",
  "\u8A18\u53F7": "symbol",
  "\u7A7A\u767D": "whitespace",
  "\u305D\u306E\u4ED6": "other",
  // what `tags` can hold
  "\u56FA\u6709\u540D\u8A5E": "proper noun",
  "\u6570\u8A5E": "numeral",
  "\u52A9\u6570\u8A5E": "counter",
  "\u975E\u81EA\u7ACB\u53EF\u80FD": "dependent (helper use)",
  "\u63A5\u7D9A\u52A9\u8A5E": "conjunctive particle",
  "\u62EC\u5F27\u958B": "opening bracket",
  "\u62EC\u5F27\u9589": "closing bracket",
  // other levels of posDetail
  "\u666E\u901A\u540D\u8A5E": "common noun",
  "\u4E00\u822C": "general",
  "\u30D5\u30A3\u30E9\u30FC": "filler",
  "\u526F\u8A5E\u53EF\u80FD": "can act as adverb",
  "\u52A9\u6570\u8A5E\u53EF\u80FD": "can act as counter",
  "\u30B5\u5909\u53EF\u80FD": "suru-verb capable",
  "\u30B5\u5909\u5F62\u72B6\u8A5E\u53EF\u80FD": "suru-verb / \u306A-adjective capable",
  "\u5F62\u72B6\u8A5E\u53EF\u80FD": "\u306A-adjective capable",
  "\u30BF\u30EA": "tari-type",
  "\u52A9\u52D5\u8A5E\u8A9E\u5E79": "auxiliary stem",
  "\u4FC2\u52A9\u8A5E": "binding particle (\u306F, \u3082)",
  "\u683C\u52A9\u8A5E": "case particle (\u304C, \u3092, \u306B)",
  "\u7D42\u52A9\u8A5E": "sentence-final particle (\u306D, \u3088)",
  "\u526F\u52A9\u8A5E": "adverbial particle (\u3060\u3051, \u307E\u3067)",
  "\u6E96\u4F53\u52A9\u8A5E": "nominalizing particle (\u306E, \u3093)",
  "\u9593\u6295\u52A9\u8A5E": "interjectory particle",
  "\u4E26\u7ACB\u52A9\u8A5E": "parallel particle (\u3068, \u3084)",
  "\u53E5\u70B9": "period",
  "\u8AAD\u70B9": "comma",
  "\uFF21\uFF21": "ASCII art",
  "\u9854\u6587\u5B57": "emoticon",
  "\u5730\u540D": "place name",
  "\u4EBA\u540D": "person name",
  "\u56FD": "country",
  "\u540D": "given name",
  "\u59D3": "family name",
  "\u7D44\u7E54\u540D": "organization",
  "\u656C\u8A9E": "honorific",
  "\u6587\u5B57": "character"
});

// src/index.js
var VERSION = true ? "0.1.0" : "dev";
var AnalyzerError = class extends KakeraError {
};
var pool = createPool({ prefix: "wakachi", ErrorClass: AnalyzerError });
var versionChecked = false;
function checkReadings(readings) {
  if (readings == null || typeof readings !== "object" || Array.isArray(readings)) throw new TypeError('readings must be an object like { "\u79C1": "\u308F\u305F\u304F\u3057" }');
  for (const [k, v] of Object.entries(readings)) {
    if (!k || typeof v !== "string" || !/^[ぁ-ゖァ-ヺー]+$/.test(v)) throw new TypeError(`readings["${k}"] must be kana, not ${JSON.stringify(v)}`);
  }
  return { ...readings };
}
function createAnalyzer(options = {}) {
  const {
    filesUrl = "/wakachi/",
    readings = {},
    everydayReadings = true,
    idleTimeout,
    stopWhenHidden,
    crashGuard,
    timeouts = {},
    persistStorage
  } = options;
  const own = checkReadings(readings);
  const analyzeStall = timeouts.analyzeStall ?? 2e4;
  const base = new URL(filesUrl.endsWith("/") ? filesUrl : `${filesUrl}/`, globalThis.location?.href).href;
  const workerUrl = new URL(`wakachi-worker.js?v=${encodeURIComponent(VERSION)}`, base).href;
  const definedOnly = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== void 0));
  const handle = pool.handle(definedOnly({
    name: "sudachi",
    filesUrl: base,
    workerUrl,
    // kakera starts it, also from another site (CORS), and explains why it didn't start
    missingHint: 'run "wakachi copy-files" into the folder served at that address',
    idleTimeout,
    stopWhenHidden,
    crashGuard,
    persistStorage,
    loadStall: timeouts.loadStall
  }));
  async function analyzeMany(texts, { signal } = {}) {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) throw new TypeError("analyzeMany() takes an array of strings");
    const results = await handle.call("analyze", { texts }, { stall: analyzeStall, signal });
    return results.map((words) => fixReadings(words, { everydayReadings, readings: own }));
  }
  async function analyze(text, o) {
    if (typeof text !== "string") throw new TypeError("analyze() takes a string");
    return (await analyzeMany([text], o))[0];
  }
  return {
    get status() {
      return handle.status;
    },
    /** Subscribe to "status", "progress" or "log". Returns an unsubscribe function. */
    on: (event, fn) => handle.on(event, fn),
    /** { cached, downloadBytes, downloadMB } without downloading anything. */
    info: () => handle.info(),
    /** Download (first time) and start Sudachi. Resolves { fromCache, ms, timings }. */
    async load() {
      const res = await handle.load();
      if (!versionChecked) {
        const engine = await handle.call("version");
        if (engine !== VERSION && engine !== "dev" && VERSION !== "dev") {
          throw new AnalyzerError("engine-failed", `the files at ${base} are from wakachi ${engine}, but the page uses ${VERSION}: run "wakachi copy-files" again`);
        }
        versionChecked = true;
      }
      return res;
    },
    /** Words of `text`, with readings, dictionary forms and parts of speech. */
    analyze,
    /** Many texts in one trip to the worker; result i belongs to text i. */
    analyzeMany,
    /** Phrases (文節) of `text`, each with its words: groupBunsetsu() of analyze(). */
    async bunsetsu(text, o) {
      return groupBunsetsu(await analyze(text, o));
    },
    /** Furigana for `text`: [{ text, reading? }]; joining every `text` gives back the input. */
    async furigana(text, o) {
      return furiganaOf(await analyze(text, o));
    },
    /** Free the memory now (if no other analyzer needs it). The next call reloads from the device. */
    unload() {
      handle.unload();
    },
    /** Back to "not-loaded": pending calls reject, load() is needed again. */
    dispose() {
      handle.dispose();
    },
    /** Delete the dictionary from this device. */
    clearCache: () => handle.clearCache(),
    /** Forget a recorded crash so load() tries again. */
    resetCrashGuard: () => handle.resetCrashGuard()
  };
}
export {
  AnalyzerError,
  VERSION,
  createAnalyzer
};
