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

// src/presets.js
var PRESETS = Object.freeze({
  original: Object.freeze({ pitch: 0, formant: 0, breathReduction: 0 }),
  soft: Object.freeze({ pitch: -2, formant: -0.5, breathReduction: 0.6 }),
  low: Object.freeze({ pitch: -6, formant: -1.5, breathReduction: 0.6 }),
  deep: Object.freeze({ pitch: -9, formant: -4, breathReduction: 0.6 }),
  deeper: Object.freeze({ pitch: -11, formant: -5.5, breathReduction: 0.6 })
});
var RANGES = Object.freeze({
  speed: [0.5, 1.5],
  pitch: [-14, 6],
  formant: [-8, 4],
  breathReduction: [0, 1],
  expressiveness: [0, 1],
  rhythmVariation: [0, 1]
});
var DEFAULTS2 = Object.freeze({ preset: "soft", speed: 0.8, expressiveness: 0.5, rhythmVariation: 0.5 });
var BASE = DEFAULTS2;
var NAMES = ["preset", ...Object.keys(RANGES)];
function resolveSettings(...levels) {
  const out = { ...BASE, ...PRESETS[BASE.preset] };
  for (const level of levels) {
    if (!level) continue;
    if (level.preset !== void 0) {
      if (!Object.hasOwn(PRESETS, level.preset)) {
        throw new TypeError(`unknown preset "${level.preset}" (use ${Object.keys(PRESETS).join(", ")})`);
      }
      Object.assign(out, PRESETS[level.preset], { preset: level.preset });
    }
    for (const name of NAMES) {
      if (name === "preset") continue;
      const v = level[name];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const [min, max] = RANGES[name];
      out[name] = Math.min(max, Math.max(min, v));
    }
  }
  return out;
}

// src/sentences.js
var MAX_CHARS = 40;
var ENDERS = "\u3002\uFF01\uFF1F!?\u2026";
var OPEN = "\u300C\u300E\uFF08(\uFF3B[\u3010";
var CLOSE = "\u300D\u300F\uFF09)\uFF3D]\u3011";
var QUOTES = `"\u201D\u2019'`;
var JAPANESE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
var isOtherLanguage = (text) => !JAPANESE.test(text) && /\p{L}/u.test(text);
function splitSentences(text) {
  const out = [];
  let from = 0, depth = 0;
  const flush = (to) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ text: t, start: from + lead, end: from + lead + t.length });
    from = to;
    depth = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      flush(i);
      from = i + 1;
      continue;
    }
    if (OPEN.includes(c)) {
      depth++;
      continue;
    }
    if (CLOSE.includes(c)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const next = text[i + 1];
    const ender = ENDERS.includes(c) || c === "." && (next === void 0 || /\s/.test(next));
    if (!ender || depth > 0) continue;
    while (i + 1 < text.length && (ENDERS.includes(text[i + 1]) || CLOSE.includes(text[i + 1]) || QUOTES.includes(text[i + 1]) || text[i + 1] === ".")) i++;
    flush(i + 1);
  }
  flush(text.length);
  return out;
}
function splitForSpeech(text, maxChars = MAX_CHARS) {
  const out = [];
  for (const s of splitSentences(text)) {
    if (s.text.length <= maxChars) {
      out.push(s);
      continue;
    }
    let piece = null;
    for (const m of s.text.matchAll(/[^、，,]+[、，,]?/g)) {
      const start = s.start + m.index, end = start + m[0].length;
      if (piece && end - piece.start > maxChars) {
        out.push(piece);
        piece = null;
      }
      piece = piece ? { ...piece, end } : { start, end };
    }
    if (piece) out.push(piece);
  }
  return out.map((p) => {
    const raw = text.slice(p.start, p.end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    return { text: t, start: p.start + lead, end: p.start + lead + t.length };
  }).filter((p) => p.text);
}

// src/playback.js
var ctx = null;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function audioContext() {
  ctx ??= new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
  return ctx;
}
function unlockAudio() {
  try {
    const c = audioContext();
    if (c.state === "running") return;
    c.resume().catch(() => {
    });
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, c.sampleRate);
    src.connect(c.destination);
    src.start(0);
  } catch {
  }
}
var listening = false;
function unlockOnGestures() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) {
    document.addEventListener(type, unlockAudio, { capture: true, passive: true });
  }
}
async function audioRunning(waitMs = 1500) {
  let c;
  try {
    c = audioContext();
  } catch {
    return false;
  }
  if (c.state === "running") return true;
  await Promise.race([c.resume().catch(() => {
  }), sleep(waitMs)]);
  return c.state === "running";
}
var Playback = class {
  constructor() {
    this.ctx = audioContext();
    this.next = 0;
    this.sources = /* @__PURE__ */ new Set();
    this.timers = /* @__PURE__ */ new Set();
    this.last = Promise.resolve();
  }
  /** Schedule a piece after the previous one; `onStart` runs when it starts playing. */
  add(samples, sampleRate, onStart) {
    const c = this.ctx;
    const buf = c.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    const at = Math.max(this.next, c.currentTime + 0.05);
    src.start(at);
    this.next = at + buf.duration;
    this.sources.add(src);
    this.last = new Promise((resolve) => {
      src.onended = () => {
        this.sources.delete(src);
        src.onended = null;
        try {
          src.disconnect();
          src.buffer = null;
        } catch {
        }
        resolve();
      };
    });
    if (onStart) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        onStart();
      }, Math.max(0, (at - c.currentTime) * 1e3));
      this.timers.add(t);
    }
  }
  /** Seconds of audio scheduled but not played yet. */
  ahead() {
    return Math.max(0, this.next - this.ctx.currentTime);
  }
  /** Resolves when everything scheduled so far has played (or was stopped). */
  finished() {
    return this.last;
  }
  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
      }
    }
    this.sources.clear();
  }
};

// src/wav.js
function toWav({ samples, sampleRate }) {
  const n = samples.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const ascii = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) view.setInt16(o, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([view], { type: "audio/wav" });
}

// src/index.js
var VERSION = true ? "0.2.0" : "dev";
var CREDIT = "\u97F3\u58F0\u5408\u6210\u306B\u306F\u3001\u30D5\u30EA\u30FC\u7D20\u6750\u30AD\u30E3\u30E9\u30AF\u30BF\u30FC\u300C\u3064\u304F\u3088\u307F\u3061\u3083\u3093\u300D\uFF08\xA9 Rei Yumesaki\uFF09\u304C\u7121\u6599\u516C\u958B\u3057\u3066\u3044\u308B\u97F3\u58F0\u30C7\u30FC\u30BF\u3092\u4F7F\u7528\u3057\u3066\u3044\u307E\u3059\u3002\u25A0\u3064\u304F\u3088\u307F\u3061\u3083\u3093\u30B3\u30FC\u30D1\u30B9\uFF08CV.\u5922\u524D\u9ECE\uFF09https://tyc.rei-yumesaki.net/material/corpus/";
var VoiceError = class extends KakeraError {
};
var pool = createPool({ prefix: "yomiage", ErrorClass: VoiceError });
var SETTINGS = /* @__PURE__ */ new Set(["preset", ...Object.keys(RANGES)]);
var OTHER_LANGUAGES = ["read", "skip"];
var LOOKAHEAD_S = 8;
var STOPPED = Symbol("stopped");
var versionChecked = false;
var speeches = /* @__PURE__ */ new Set();
var stopAll = () => {
  for (const s of [...speeches]) s.stop();
};
var abortError2 = () => new DOMException("The operation was aborted.", "AbortError");
var definedOnly = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== void 0));
var pick = (o, keys) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.has(k)));
function checkOtherLanguages(v) {
  if (!OTHER_LANGUAGES.includes(v)) throw new TypeError(`otherLanguages must be "read" or "skip", not ${JSON.stringify(v)}`);
  return v;
}
function createVoice(options = {}) {
  const {
    filesUrl = "/yomiage/",
    idleTimeout,
    stopWhenHidden = true,
    crashGuard,
    timeouts = {},
    persistStorage,
    otherLanguages = "read"
  } = options;
  const defaults = pick(options, SETTINGS);
  resolveSettings(defaults);
  checkOtherLanguages(otherLanguages);
  const speakStall = timeouts.speakStall ?? 2e4;
  const base = new URL(filesUrl.endsWith("/") ? filesUrl : `${filesUrl}/`, globalThis.location?.href).href;
  const workerUrl = new URL(`yomiage-worker.js?v=${encodeURIComponent(VERSION)}`, base).href;
  const handle = pool.handle(definedOnly({
    name: "tsukuyomi",
    filesUrl: base,
    workerUrl,
    // kakera starts it, also from another site (CORS), and explains why it didn't start
    missingHint: 'run "yomiage copy-files" into the folder served at that address',
    idleTimeout,
    stopWhenHidden,
    crashGuard,
    persistStorage,
    loadStall: timeouts.loadStall
  }));
  if (stopWhenHidden) handle.onHidden(stopAll);
  unlockOnGestures();
  async function* pieces(text, settings, otherLangs, signal) {
    for (const piece of splitForSpeech(String(text ?? ""))) {
      const other = isOtherLanguage(piece.text);
      if (other && otherLangs === "skip") continue;
      const audio = await handle.call("synth", { ...settings, text: piece.text, language: other ? "en" : "ja" }, { stall: speakStall, signal });
      yield { piece, audio };
    }
  }
  const callSettings = (o) => {
    const settings = resolveSettings(defaults, pick(o, SETTINGS));
    delete settings.preset;
    return settings;
  };
  return {
    get status() {
      return handle.status;
    },
    /** Subscribe to "status", "progress" ({ loaded, total } bytes) or "log". Returns an unsubscribe function. */
    on: (event, fn) => handle.on(event, fn),
    /** { cached, downloadBytes, downloadMB } without downloading anything. */
    info: () => handle.info(),
    /** Download (first time) and start the engine. Resolves { fromCache }. */
    async load() {
      const res = await handle.load();
      if (!versionChecked) {
        const engine = await handle.call("version");
        if (engine !== VERSION && engine !== "dev" && VERSION !== "dev") {
          throw new VoiceError("engine-failed", `the files at ${base} are from yomiage ${engine}, but the page uses ${VERSION}: run "yomiage copy-files" again`);
        }
        versionChecked = true;
      }
      return res;
    },
    /**
     * Read `text` aloud. Resolves "done", or "stopped" when stop(), a newer speak() or the page being hidden ended it.
     * Call it from a tap or click handler (iPhone).
     */
    speak(text, o = {}) {
      unlockAudio();
      let settings, otherLangs;
      try {
        settings = callSettings(o);
        otherLangs = checkOtherLanguages(o.otherLanguages ?? otherLanguages);
      } catch (e) {
        return Promise.reject(e);
      }
      if (o.signal?.aborted) return Promise.reject(abortError2());
      const waitFor = o.queue ? [...speeches].map((s) => s.done) : [];
      if (!o.queue) stopAll();
      const ctrl = new AbortController();
      const speech = { stop: () => ctrl.abort(STOPPED) };
      const onUserAbort = () => ctrl.abort(abortError2());
      o.signal?.addEventListener("abort", onUserAbort, { once: true });
      const check = () => {
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
      };
      const until = (p) => new Promise((resolve, reject) => {
        if (ctrl.signal.aborted) {
          reject(ctrl.signal.reason);
          return;
        }
        const onAbort = () => reject(ctrl.signal.reason);
        ctrl.signal.addEventListener("abort", onAbort, { once: true });
        p.then(resolve, reject).finally(() => ctrl.signal.removeEventListener("abort", onAbort));
      });
      speech.done = (async () => {
        let playback = null;
        try {
          await until(Promise.allSettled(waitFor));
          playback = new Playback();
          const running = audioRunning();
          for await (const { piece, audio } of pieces(text, settings, otherLangs, ctrl.signal)) {
            check();
            if (!await until(running)) throw new VoiceError("audio-blocked", "the browser did not allow sound: call speak() from a tap or click");
            const { onSentence } = o;
            playback.add(audio.samples, audio.sampleRate, onSentence && (() => {
              if (!ctrl.signal.aborted) try {
                onSentence({ ...piece });
              } catch (e) {
                console.error(e);
              }
            }));
            while (playback.ahead() > LOOKAHEAD_S) await until(new Promise((r) => setTimeout(r, 250)));
          }
          await until(playback.finished());
          return "done";
        } catch (e) {
          playback?.stop();
          if (ctrl.signal.reason === STOPPED) return "stopped";
          if (ctrl.signal.aborted) throw ctrl.signal.reason;
          throw e;
        }
      })().finally(() => {
        speeches.delete(speech);
        o.signal?.removeEventListener("abort", onUserAbort);
      });
      speeches.add(speech);
      return speech.done;
    },
    /** Stop whatever is speaking on the page (from any voice), including queued speech. */
    stop: stopAll,
    /** The audio of `text` without playing it: { samples: Float32Array, sampleRate }. See toWav(). */
    async synthesize(text, o = {}) {
      const settings = callSettings(o);
      const otherLangs = checkOtherLanguages(o.otherLanguages ?? otherLanguages);
      const parts = [];
      let sampleRate = 22050;
      for await (const { audio } of pieces(text, settings, otherLangs, o.signal)) {
        parts.push(audio.samples);
        sampleRate = audio.sampleRate;
      }
      const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        samples.set(p, at);
        at += p.length;
      }
      return { samples, sampleRate };
    },
    /** Free the memory now (if no other voice needs it). The next speak() reloads from the device. */
    unload() {
      handle.unload();
    },
    /** Back to "not-loaded"; load() is needed again. */
    dispose() {
      handle.dispose();
    },
    /** Delete the downloaded files from this device. */
    clearCache: () => handle.clearCache(),
    /** Forget a recorded crash so load() tries again. */
    resetCrashGuard: () => handle.resetCrashGuard()
  };
}
export {
  CREDIT,
  DEFAULTS2 as DEFAULTS,
  PRESETS,
  RANGES,
  VERSION,
  VoiceError,
  createVoice,
  toWav
};
