// jp-analyzer: createAnalyzer and the page-wide engine pool. See API.md for the behaviour described here.
//
// Structure:
//   EngineHost  one per dictionary URL for the whole page. Owns the worker, the watchdog, the idle timer and the
//               crash-guard marker. Shared by every analyzer that lists that engine.
//   Analyzer    a cheap handle: the engine list and options, which engine it ended up using, its listeners.
import { AnalyzerError } from "./errors.js";
import { clearDict, dictInfo } from "./dict-store.js";

export { AnalyzerError };

const DEFAULTS = {
  idleTimeout: 60_000,
  stopWhenHidden: true,
  crashGuard: { retryAfterDays: 7 },
  timeouts: { loadStall: 60_000, analyzeStall: 20_000 },
  persistStorage: true,
};

// ------------------------------------------------------------------------------------------------ crash guard
//
// iOS kills a tab that uses too much memory and reloads it; no code runs. So a marker is written to sessionStorage
// (per tab, survives the reload) before an engine starts loading and removed when loading ends, or when the page is
// left normally (pagehide). A marker found when this module starts means the last load in this tab never ended:
// the engine crashed the tab. That is recorded in localStorage (all tabs, for retryAfterDays).

const PREFIX = "jp-analyzer:";
const LOADING = `${PREFIX}loading:`;
const CRASHED = `${PREFIX}crashed:`;

const store = (kind) => { try { return kind === "session" ? sessionStorage : localStorage; } catch { return null; } };
const safely = (fn) => { try { return fn(); } catch { return undefined; } };

safely(() => {
  const s = store("session"), l = store("local");
  for (const k of Object.keys(s)) {
    if (!k.startsWith(LOADING)) continue;
    l?.setItem(CRASHED + k.slice(LOADING.length), String(Date.now()));
    s.removeItem(k);
  }
});

const markLoading = (key) => safely(() => store("session").setItem(LOADING + key, String(Date.now())));
const clearLoading = (key) => safely(() => store("session").removeItem(LOADING + key));
const crashedAt = (key) => Number(safely(() => store("local").getItem(CRASHED + key)) ?? 0);
const forgetCrash = (key) => safely(() => store("local").removeItem(CRASHED + key));

// ------------------------------------------------------------------------------------------------ engine pool

const hosts = new Map();

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

class EngineHost {
  constructor(config) {
    this.name = config.name;
    this.createWorker = config.createWorker;
    this.url = new URL(config.dictUrl, location.href).href;
    this.key = `${this.name}|${this.url}`;
    this.status = "not-loaded"; // not-loaded | downloading | loading | ready | stopped
    this.worker = null;
    this.loading = null;
    this.pending = new Map(); // id -> { resolve, reject, onProgress, stall, timer }
    this.nextId = 1;
    this.users = new Set(); // analyzers attached to this engine
    this.idleTimer = null;
    this.stopWhenDone = false; // the page went hidden during a call: stop once nothing is pending
  }

  /** Analyzers that currently want the engine loaded. */
  active() { return [...this.users].filter((a) => a._active); }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    for (const a of this.users) a._emitStatus();
  }

  // ---- policy, combined over the analyzers using this engine
  idleMs() {
    const v = this.active().map((a) => a._opts.idleTimeout);
    return v.length === 0 || v.includes(0) ? 0 : Math.max(...v);
  }
  stopsWhenHidden() { const a = this.active(); return a.length > 0 && a.every((x) => x._opts.stopWhenHidden); }
  loadStallMs() { return Math.max(...this.active().map((a) => a._opts.timeouts.loadStall), 1); }

  /** Start the worker and load the dictionary. Shared: concurrent callers get the same promise. */
  load() {
    if (this.status === "ready") return Promise.resolve({ fromCache: true });
    this.loading ??= (async () => {
      markLoading(this.key);
      this.worker = this.createWorker();
      this.worker.onmessage = ({ data }) => this.onMessage(data);
      this.worker.onerror = (e) => {
        e.preventDefault?.();
        const loading = this.status !== "ready";
        this.kill(new AnalyzerError(loading ? "engine-failed" : "worker-crashed",
          `${this.name} worker ${loading ? "failed to start" : "crashed"}: ${e.message || "unknown error"}`, { engine: this.name }));
      };
      this.setStatus("loading");
      try {
        const res = await this.call({ type: "load", manifestUrl: this.url }, {
          stall: this.loadStallMs(),
          onProgress: (p) => {
            this.setStatus(p.loaded < p.total ? "downloading" : "loading");
            for (const a of this.active()) a._emitProgress({ engine: this.name, ...p });
          },
        });
        this.setStatus("ready");
        this.touch();
        return res;
      } catch (err) {
        if (this.worker) this.kill(err, "not-loaded");
        throw err;
      } finally {
        clearLoading(this.key);
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Send a message; resolves with the worker's "done" data. `stall` = ms without any message before giving up. */
  call(msg, { stall, signal, onProgress } = {}) {
    if (!this.worker) return Promise.reject(new AnalyzerError("not-loaded", `${this.name} is not loaded`, { engine: this.name }));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const entry = { resolve, reject, onProgress, stall, timer: null };
      const onAbort = () => { this.settle(id); reject(abortError()); };
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
      this.kill(new AnalyzerError("timeout", `${this.name} stopped responding (no progress for ${Math.round(e.stall / 1000)} s); it was stopped to free memory`, { engine: this.name }));
    }, e.stall);
  }

  /** Remove a pending call (finished, failed or aborted). */
  settle(id) {
    const e = this.pending.get(id);
    if (!e) return null;
    clearTimeout(e.timer);
    e.cleanup?.();
    this.pending.delete(id);
    if (this.pending.size === 0 && this.stopWhenDone) { this.stopWhenDone = false; queueMicrotask(() => this.stop()); }
    return e;
  }

  onMessage(data) {
    const e = this.pending.get(data.id);
    if (!e) return; // aborted or killed
    if (data.type === "done" || data.type === "error") {
      this.settle(data.id);
      if (data.type === "done") e.resolve(data);
      else e.reject(new AnalyzerError(data.code ?? "engine-failed", data.message, { engine: this.name }));
      return;
    }
    // progress, alive and log all mean "the worker is still working". Calls queued behind this one are waiting on
    // the same worker, so their watchdogs are reset too.
    for (const id of this.pending.keys()) this.armWatchdog(id);
    if (data.type === "progress") e.onProgress?.(data);
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

  /** Free the memory. The next analyze() of an analyzer that loaded it reloads from the cache. */
  stop() {
    if (!this.worker) return;
    this.kill(new AnalyzerError("disposed", `${this.name} was stopped`, { engine: this.name }), "stopped");
  }

  /** Stop if no analyzer wants the engine any more. */
  release() { if (this.active().length === 0) this.stop(); }

  /** Restart the idle countdown. */
  touch() {
    clearTimeout(this.idleTimer);
    const ms = this.idleMs();
    if (ms > 0 && this.status === "ready") {
      this.idleTimer = setTimeout(() => (this.pending.size ? this.touch() : this.stop()), ms);
    }
  }

  onHidden() {
    if (this.status !== "ready" || !this.stopsWhenHidden()) return;
    if (this.pending.size) this.stopWhenDone = true;
    else this.stop();
  }
}

function hostFor(config) {
  const key = `${config.name}|${new URL(config.dictUrl, location.href).href}`;
  let h = hosts.get(key);
  if (!h) hosts.set(key, (h = new EngineHost(config)));
  return h;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") for (const h of hosts.values()) h.onHidden();
  });
  // Leaving the page normally (close, navigate, reload) is not a crash.
  addEventListener("pagehide", () => { for (const h of hosts.values()) if (h.loading) clearLoading(h.key); });
  addEventListener("pageshow", (e) => { if (e.persisted) for (const h of hosts.values()) if (h.loading) markLoading(h.key); });
}

// ------------------------------------------------------------------------------------------------ analyzer

function unsupported() {
  if (typeof WebAssembly !== "object") return "WebAssembly";
  if (typeof Worker !== "function") return "Web Workers";
  if (typeof indexedDB !== "object") return "IndexedDB";
  if (typeof DecompressionStream !== "function") return "DecompressionStream (Safari 16.4+)";
  return null;
}

class Analyzer {
  constructor(options) {
    if (!options?.engines?.length) throw new TypeError("createAnalyzer(): `engines` must list at least one engine");
    this._opts = {
      ...DEFAULTS,
      ...options,
      timeouts: { ...DEFAULTS.timeouts, ...options.timeouts },
      crashGuard: options.crashGuard === false ? false : { ...DEFAULTS.crashGuard, ...options.crashGuard },
    };
    this._hosts = options.engines.map(hostFor);
    this._host = null; // the engine this analyzer uses after load()
    this._active = false; // wants its engine loaded (false after stop(), before load())
    this._own = "not-loaded"; // status when no engine is attached: not-loaded | unavailable | error
    this._loadPromise = null;
    this._calls = new Set(); // reject functions of this analyzer's pending calls
    this._disposeCtrl = new AbortController(); // aborted by dispose(): drops this analyzer's calls from the engine
    this._listeners = { status: new Set(), progress: new Set() };
    this._lastStatus = null;
    if (this._hosts.every((h) => this._crashed(h))) this._own = "unavailable";
    this._lastStatus = this.status;
  }

  get status() {
    if (!this._host) return this._own;
    if (!this._active) return "stopped";
    return this._host.status === "not-loaded" ? "stopped" : this._host.status;
  }

  get engine() { return this._host?.name ?? null; }

  on(event, listener) {
    const set = this._listeners[event];
    if (!set) throw new TypeError(`unknown event "${event}" (use "status" or "progress")`);
    set.add(listener);
    return () => set.delete(listener);
  }

  _emitStatus() {
    const s = this.status;
    if (s === this._lastStatus) return;
    this._lastStatus = s;
    for (const fn of this._listeners.status) safely(() => fn(s));
  }
  _emitProgress(p) { for (const fn of this._listeners.progress) safely(() => fn(p)); }

  _crashed(host) {
    const g = this._opts.crashGuard;
    if (!g) return false;
    const t = crashedAt(host.key);
    return t > 0 && Date.now() - t < g.retryAfterDays * 86_400_000;
  }

  _attach(host) {
    if (this._host && this._host !== host) this._detach();
    this._host = host;
    this._active = true;
    host.users.add(this);
    this._emitStatus();
  }
  _detach() {
    const h = this._host;
    if (!h) return;
    this._active = false;
    this._host = null;
    h.users.delete(this);
    h.release();
  }

  load() {
    if (this._host && this._active && this._host.status === "ready") {
      return Promise.resolve({ engine: this._host.name, fromCache: true, skipped: [] });
    }
    this._loadPromise ??= this._load().finally(() => { this._loadPromise = null; });
    return this._loadPromise;
  }

  async _load() {
    const missing = unsupported();
    if (missing) {
      this._own = "error";
      this._emitStatus();
      throw new AnalyzerError("unsupported-browser", `this browser lacks ${missing}`);
    }
    const skipped = [];
    const errors = [];
    for (const host of this._hosts) {
      if (this._crashed(host)) {
        skipped.push({ engine: host.name, reason: "crashed-before", message: `${host.name} crashed this tab while loading; skipped (resetCrashGuard() to retry)` });
        continue;
      }
      this._attach(host);
      try {
        const res = await host.load();
        if (!res.fromCache && this._opts.persistStorage) navigator.storage?.persist?.()?.catch?.(() => {});
        return { engine: host.name, fromCache: !!res.fromCache, skipped };
      } catch (err) {
        this._detach();
        errors.push(err);
        skipped.push({ engine: host.name, reason: err.code ?? "engine-failed", message: err.message });
      }
    }
    if (errors.length === 0) {
      this._own = "unavailable";
      this._emitStatus();
      throw new AnalyzerError("unavailable", "every engine crashed this tab before; showing the page without analysis is recommended", { cause: skipped });
    }
    this._own = "error";
    this._emitStatus();
    if (errors.length === 1 && skipped.length === 1) throw errors[0];
    throw new AnalyzerError("all-engines-failed", `no engine could load: ${skipped.map((s) => `${s.engine}: ${s.message}`).join("; ")}`, { cause: errors });
  }

  async analyze(text, options) {
    return (await this.analyzeMany([text], options))[0];
  }

  analyzeMany(texts, { signal } = {}) {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) {
      return Promise.reject(new TypeError("analyzeMany() takes an array of strings"));
    }
    const host = this._host;
    if (!host) return Promise.reject(new AnalyzerError("not-loaded", "call load() before analyze()"));
    // One signal for "the caller aborted" or "this analyzer was disposed".
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
        if (!this._active) this._attach(host);
        if (host.status !== "ready") await host.load(); // stopped (idle, hidden, stop()): reload from cache
        if (ctrl.signal.aborted) throw abortError();
        const res = await host.call({ type: "analyze", texts }, { stall: this._opts.timeouts.analyzeStall, signal: ctrl.signal });
        host.touch();
        return res.results;
      })().then(resolve, reject).finally(() => {
        this._calls.delete(entry);
        signal?.removeEventListener("abort", abort);
        disposed.removeEventListener("abort", abort);
      });
    });
  }

  async isCached(engine) { return (await dictInfo(this._pick(engine).url)).cached; }
  async downloadSize(engine) { return (await dictInfo(this._pick(engine).url)).downloadSize; }

  async clearCache(engine) {
    const names = new Set(engine ? [this._pick(engine).name] : this._hosts.map((h) => h.name));
    for (const n of names) await clearDict(n);
  }

  resetCrashGuard() {
    for (const h of this._hosts) forgetCrash(h.key);
    if (this._own === "unavailable") { this._own = "not-loaded"; this._emitStatus(); }
  }

  stop() {
    if (!this._host || !this._active) return;
    this._active = false;
    this._host.release();
    this._emitStatus();
  }

  dispose() {
    const err = new AnalyzerError("disposed", "the analyzer was disposed");
    for (const reject of [...this._calls]) reject(err);
    this._calls.clear();
    this._disposeCtrl.abort(); // remove those calls from the engine too, so it isn't kept busy for nobody
    this._disposeCtrl = new AbortController();
    this._detach();
    this._own = "not-loaded";
    this._emitStatus();
  }

  /** The engine `isCached()` etc. talk about: the named one, or the one load() would try first. */
  _pick(engine) {
    if (engine) {
      const h = this._hosts.find((x) => x.name === engine);
      if (!h) throw new TypeError(`this analyzer has no "${engine}" engine`);
      return h;
    }
    return this._host ?? this._hosts.find((h) => !this._crashed(h)) ?? this._hosts[0];
  }
}

/** @param {import("./types.ts").AnalyzerOptions} options @returns {import("./types.ts").Analyzer} */
export function createAnalyzer(options) {
  return new Analyzer(options);
}

/** For tests: the page-wide engine pool. Not part of the public API. */
export const __engines = () => [...hosts.values()].map((h) => ({ name: h.name, url: h.url, status: h.status, worker: !!h.worker, users: h.users.size }));
