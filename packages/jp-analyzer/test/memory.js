// Test page logic. Serve the repository root (python3 serve.py 8080) and open
// /packages/jp-analyzer/test/memory.html. Needs `copy-dict sudachi packages/jp-analyzer/test/dict` first.
const $ = (id) => document.getElementById(id);
const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const NEW_MANIFEST = new URL("./dict/sudachi/manifest.json", location.href).href;
const OLD_MANIFEST = new URL("../../../models/sudachi/manifest.json", location.href).href;
const OLD_RAW = new URL("../../../models/sudachi/sudachi.wasm", location.href).href;

let worker = null, method = null, nextId = 1;
const pending = new Map();

const log = (msg) => { const el = $("log"); el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`; el.scrollTop = el.scrollHeight; };
const set = (id, text, cls = "") => { $(id).textContent = text; $(id).className = cls; };

function startWorker(which) {
  stopWorker();
  method = which;
  worker = which === "new"
    ? new Worker(new URL("../src/engines/sudachi-worker.js", import.meta.url), { type: "module" })
    : new Worker(new URL("../../../src/sudachi-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.type === "log") log(data.msg);
    else if (data.type === "progress") set("m-download", `${MB(data.loaded)} / ${MB(data.total)}`);
    else { pending.delete(data.id); data.type === "error" ? p.reject(new Error(data.message)) : p.resolve(data); }
  };
  worker.onerror = (e) => {
    log(`Worker error: ${e.message || "crashed"}`);
    for (const p of pending.values()) p.reject(new Error(e.message || "worker crashed"));
    pending.clear();
  };
  set("m-method", which);
}

function stopWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error("stopped"));
  pending.clear();
  set("m-status", "stopped");
  log("Worker stopped.");
}

const call = (msg) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, ...msg });
});

async function load(which) {
  startWorker(which);
  set("m-status", "loading...");
  for (const id of ["m-download", "m-time", "m-cache", "m-mem"]) set(id, "-");
  const t0 = performance.now();
  try {
    const res = which === "new"
      ? await call({ type: "load", manifestUrl: NEW_MANIFEST })
      : await call({ type: "load", manifestUrl: OLD_MANIFEST, rawUrl: OLD_RAW });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    set("m-status", "ready", "ok");
    set("m-time", `${secs} s`);
    if (which === "new") {
      set("m-cache", res.fromCache ? "yes (nothing downloaded)" : `no${res.cached ? " (now stored)" : " (could not store)"}`);
      set("m-mem", `${MB(res.memoryBytes)} (the old method also keeps a ~116 MB copy in the compiled module)`);
    } else {
      set("m-cache", "see log");
      set("m-mem", "not reported (about 150 MB + ~116 MB module copy + the downloaded file until freed)");
    }
    log(`${which}: ready in ${secs} s`);
  } catch (e) {
    set("m-status", `error: ${e.message}`, "bad");
    log(`${which}: ${e.message}`);
  }
}

async function analyze() {
  if (!worker) { $("out").textContent = "Load a method first."; return; }
  const text = $("text").value;
  try {
    let words;
    if (method === "new") words = (await call({ type: "analyze", texts: [text] })).results[0];
    else words = (await call({ type: "analyze", text })).lines.flat().filter(Boolean).map((m) => ({ surface: m.surface, reading: m.reading, dictionaryForm: m.dict }));
    $("out").textContent = words.map((m) => `${m.surface}\t${m.reading}\t${m.dictionaryForm}`).join("\n");
  } catch (e) {
    $("out").textContent = `Error: ${e.message}`;
  }
}

async function clearCaches() {
  stopWorker();
  for (const name of ["jp-analyzer", "jp-tts-playground"]) {
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = resolve; });
  }
  log("Deleted cached dictionaries (new and old).");
}

$("load-new").onclick = () => load("new");
$("load-old").onclick = () => load("old");
$("stop").onclick = stopWorker;
$("clear").onclick = clearCaches;
$("analyze").onclick = analyze;
log(`${navigator.userAgent}`);
log(`Secure context: ${isSecureContext} (checksums are ${isSecureContext ? "verified" : "skipped on plain http"})`);
