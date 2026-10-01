// Browser tests for createAnalyzer. Results are shown on the page and in window.__results.
import { __engines, createAnalyzer } from "../src/index.js";
import { sudachi } from "../src/engines/sudachi.js";

const DICT = new URL("./dict/sudachi/manifest.json", location.href).href;
const MISSING = new URL("./dict/missing/manifest.json", location.href).href;
const phase = new URLSearchParams(location.search).get("phase") ?? "1";

const results = [];
window.__results = results;
const list = document.getElementById("results");

async function t(name, fn) {
  const li = document.createElement("li");
  li.textContent = `${name} ...`;
  list.append(li);
  const t0 = performance.now();
  try {
    await fn();
    const ms = Math.round(performance.now() - t0);
    li.innerHTML = `<span class="ok">PASS</span> ${name} <small>(${ms} ms)</small>`;
    results.push({ name, ok: true, ms });
  } catch (e) {
    li.innerHTML = `<span class="bad">FAIL</span> ${name}<pre>${e?.stack ?? e}</pre>`;
    results.push({ name, ok: false, error: String(e?.message ?? e) });
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const rejects = async (p, check) => {
  try { await p; } catch (e) { check(e); return; }
  throw new Error("expected a rejection");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (opts = {}) => createAnalyzer({ engines: [sudachi({ dictUrl: DICT })], ...opts });
const workers = () => __engines().filter((e) => e.worker).length;
function covers(text, morphs) {
  eq(morphs.map((m) => m.surface).join(""), text, "surfaces join to the input");
  let pos = 0;
  for (const m of morphs) {
    eq(m.start, pos, `start of ${m.surface}`);
    eq(text.slice(m.start, m.end), m.surface, "slice equals surface");
    pos = m.end;
  }
}
const longText = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。\n".repeat(1800); // ~63,000 chars

async function phase1() {
  localStorage.removeItem(`jp-analyzer:crashed:sudachi|${DICT}`); // left over from an interrupted run
  const a = make();

  await t("analyze() before load() rejects with not-loaded", async () => {
    eq(a.status, "not-loaded", "status");
    await rejects(a.analyze("猫"), (e) => eq(e.code, "not-loaded", "code"));
  });

  await t("downloadSize() and isCached() read the manifest", async () => {
    const size = await a.downloadSize();
    assert(size > 40e6 && size < 50e6, `download size ${size}`);
    eq(typeof (await a.isCached()), "boolean", "isCached type");
  });

  await t("load() goes to ready and reports progress or cache", async () => {
    const seen = [];
    let progress = 0;
    const off1 = a.on("status", (s) => seen.push(s));
    const off2 = a.on("progress", () => progress++);
    const res = await a.load();
    off1(); off2();
    eq(res.engine, "sudachi", "engine");
    eq(a.status, "ready", "status");
    eq(seen.at(-1), "ready", "last status event");
    assert(res.fromCache || progress > 0, "a download reports progress");
    eq(workers(), 1, "workers");
  });

  await t("analyze(): fields, pos, tags and offsets", async () => {
    const text = "東京で5分「走った」。";
    const m = await a.analyze(text);
    covers(text, m);
    const run = m.find((x) => x.surface === "走っ");
    eq(run.dictionaryForm, "走る", "dictionary form");
    eq(run.reading, "ハシッ", "reading");
    eq(run.pos, "verb", "pos");
    assert(m.find((x) => x.surface === "東京").tags.includes("proper"), "proper tag");
    assert(m.find((x) => x.surface === "「").tags.includes("bracket-open"), "bracket tag");
  });

  await t("analyze(): original characters are kept (Sudachi rewrites ':' as '：')", async () => {
    const text = "見て https://example.com/" + "abcdefghij".repeat(30) + " すごい😀😀";
    covers(text, await a.analyze(text));
  });

  await t("analyzeMany(): one result per text, in order", async () => {
    const texts = ["猫が好き。", "", "  ", "今日は晴れ。"];
    const r = await a.analyzeMany(texts);
    eq(r.length, 4, "results");
    r.forEach((m, i) => covers(texts[i], m));
  });

  await t("analyze(): 63,000 characters in one call", async () => {
    covers(longText, await a.analyze(longText));
  });

  await t("engines are shared: a second analyzer uses the same worker", async () => {
    const b = make();
    const res = await b.load();
    eq(res.fromCache, true, "no second load");
    eq(workers(), 1, "workers");
    eq(__engines()[0].users, 2, "users");
    b.dispose();
    eq(workers(), 1, "still loaded for the first analyzer");
  });

  await t("abort: an aborted call rejects with AbortError", async () => {
    const ctrl = new AbortController();
    const p = a.analyze(longText, { signal: ctrl.signal });
    ctrl.abort();
    await rejects(p, (e) => eq(e.name, "AbortError", "error name"));
    covers("猫", await a.analyze("猫"));
  });

  await t("stop(): frees the worker; the next analyze() reloads from cache", async () => {
    a.stop();
    eq(a.status, "stopped", "status after stop");
    eq(workers(), 0, "workers after stop");
    covers("猫が好き", await a.analyze("猫が好き"));
    eq(a.status, "ready", "status after reload");
  });

  await t("dispose(): pending calls reject with disposed", async () => {
    const c = make();
    await c.load();
    const p = c.analyze(longText);
    c.dispose();
    await rejects(p, (e) => eq(e.code, "disposed", "code"));
    eq(c.status, "not-loaded", "status");
  });

  await t("page hidden: the engine is stopped (stopWhenHidden)", async () => {
    await a.load();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.visibilityState;
    eq(workers(), 0, "workers while hidden");
    eq(a.status, "stopped", "status");
    covers("猫", await a.analyze("猫"));
  });

  await t("analyze stall timeout: rejects with timeout, the next call recovers", async () => {
    const d = make({ timeouts: { analyzeStall: 1 } });
    await d.load();
    await rejects(d.analyze(longText), (e) => eq(e.code, "timeout", "code"));
    eq(workers(), 0, "worker stopped after timeout");
    d.dispose();
    covers("猫", await a.analyze("猫"));
  });

  await t("idle timeout: the engine stops after idleTimeout", async () => {
    a.dispose();
    const e = make({ idleTimeout: 300 });
    await e.load();
    await e.analyze("猫");
    await sleep(800);
    eq(e.status, "stopped", "status");
    eq(workers(), 0, "workers");
    covers("猫", await e.analyze("猫"));
    e.dispose();
  });

  await t("fallback: a broken first engine is skipped", async () => {
    const f = createAnalyzer({ engines: [sudachi({ dictUrl: MISSING }), sudachi({ dictUrl: DICT })] });
    const res = await f.load();
    eq(res.skipped.length, 1, "skipped");
    eq(res.skipped[0].reason, "download-failed", "reason");
    eq(f.status, "ready", "status");
    f.dispose();
  });

  await t("a single broken engine: load() rejects with its error, status error", async () => {
    const g = createAnalyzer({ engines: [sudachi({ dictUrl: MISSING })] });
    await rejects(g.load(), (e) => eq(e.code, "download-failed", "code"));
    eq(g.status, "error", "status");
  });

  // Crash guard: leave a "loading" marker behind, as a tab killed by iOS would, then reload.
  await t("crash guard: simulating a crash (the page reloads)...", async () => {
    sessionStorage.setItem("jp-analyzer:results", JSON.stringify(results));
    sessionStorage.setItem(`jp-analyzer:loading:sudachi|${DICT}`, String(Date.now()));
    location.replace(`${location.pathname}?phase=2`);
    await new Promise(() => {}); // wait for the reload
  });
}

async function phase2() {
  for (const r of JSON.parse(sessionStorage.getItem("jp-analyzer:results") ?? "[]")) {
    results.push(r);
    const li = document.createElement("li");
    li.innerHTML = `<span class="${r.ok ? "ok" : "bad"}">${r.ok ? "PASS" : "FAIL"}</span> ${r.name}`;
    list.append(li);
  }
  sessionStorage.removeItem("jp-analyzer:results");

  await t("crash guard: after a crash the engine is unavailable, without loading", async () => {
    const a = make();
    eq(a.status, "unavailable", "status before load");
    await rejects(a.load(), (e) => eq(e.code, "unavailable", "code"));
    eq(workers(), 0, "nothing was loaded");
  });

  await t("crash guard: resetCrashGuard() allows loading again", async () => {
    const a = make();
    a.resetCrashGuard();
    eq(a.status, "not-loaded", "status");
    await a.load();
    covers("猫が好き", await a.analyze("猫が好き"));
    a.dispose();
  });

  await t("crash guard: crashGuard: false ignores crash records", async () => {
    localStorage.setItem(`jp-analyzer:crashed:sudachi|${DICT}`, String(Date.now()));
    const a = make({ crashGuard: false });
    eq(a.status, "not-loaded", "status");
    await a.load();
    a.dispose();
    make().resetCrashGuard();
  });
}

await (phase === "2" ? phase2() : phase1());
const failed = results.filter((r) => !r.ok).length;
const summary = document.getElementById("summary");
summary.textContent = failed ? `${failed} of ${results.length} failed` : `All ${results.length} passed`;
summary.className = failed ? "bad" : "ok";
window.__done = true;
