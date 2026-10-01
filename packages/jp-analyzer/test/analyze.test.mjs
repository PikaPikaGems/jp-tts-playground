// Node tests for the analysis logic that runs inside the Sudachi worker.
//
//   node --test packages/jp-analyzer/test/          (needs models/sudachi/sudachi.wasm: npm run fetch-assets)
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { splitInput } from "../src/split-input.js";
import { cutLongRuns, makeAnalyzeText } from "../src/engines/sudachi-analyze.js";

const WASM = new URL("../../../models/sudachi/sudachi.wasm", import.meta.url);
const glue = await import("../src/engines/sudachi-glue.js?test");
const { memory } = await glue.default(fs.readFileSync(WASM));
const analyzeText = makeAnalyzeText(glue.tokenize);

/** Every morpheme lines up with the input, and together they cover all of it. */
function assertCovers(text, morphs) {
  assert.equal(morphs.map((m) => m.surface).join(""), text);
  let pos = 0;
  for (const m of morphs) {
    assert.equal(m.start, pos);
    assert.equal(text.slice(m.start, m.end), m.surface);
    pos = m.end;
  }
}

test("splitInput: pieces join back, never split a surrogate pair, cut after sentence ends", () => {
  for (const text of ["猫が好き。", "吾輩は猫である。「名前は？」\n".repeat(500), "あ".repeat(9000), "𠮷".repeat(3000)]) {
    const pieces = splitInput(text);
    assert.equal(pieces.map((p) => p.text).join(""), text);
    for (const p of pieces) {
      assert.ok(p.text.length <= 2000);
      assert.ok(!/^[\udc00-\udfff]/.test(p.text) && !/[\ud800-\udbff]$/.test(p.text));
      assert.equal(text.slice(p.offset, p.offset + p.text.length), p.text);
    }
  }
  const novel = splitInput("吾輩は猫である。「名前は？」\n".repeat(500));
  for (const p of novel.slice(0, -1)) assert.match(p.text, /[。？」\n]$/);
});

test("cutLongRuns: cuts only long non-Japanese runs", () => {
  assert.deepEqual(cutLongRuns("猫が好き"), ["猫が好き"]);
  assert.equal(cutLongRuns("あ".repeat(500)).length, 1);
  const url = "見て https://example.com/" + "abcdefghij".repeat(30) + " すごい";
  const parts = cutLongRuns(url);
  assert.equal(parts.join(""), url);
  assert.ok(parts.length > 1 && parts.every((p) => Array.from(p).length <= 60));
});

test("analyze: fields, engine-neutral pos/tags, offsets", () => {
  const text = "東京で5分「走った」。";
  const m = analyzeText(text);
  assertCovers(text, m);
  const by = Object.fromEntries(m.map((x) => [x.surface, x]));
  assert.equal(by["東京"].pos, "noun");
  assert.ok(by["東京"].tags.includes("proper"));
  assert.equal(by["「"].pos, "punctuation");
  assert.ok(by["「"].tags.includes("bracket-open"));
  assert.equal(by["走っ"].pos, "verb");
  assert.equal(by["走っ"].dictionaryForm, "走る");
  assert.equal(by["走っ"].reading, "ハシッ");
  assert.equal(by["た"].pos, "auxiliary");
});

test("analyze: whitespace and line breaks come back as whitespace morphemes", () => {
  const text = " 猫 が\n\n好き　";
  const m = analyzeText(text);
  assertCovers(text, m);
  assert.ok(m.filter((x) => /^\s+$/.test(x.surface) && x.surface !== "　").every((x) => x.pos === "whitespace"));
});

test("analyze: long URLs, emoji runs and latin runs no longer crash Sudachi", () => {
  const before = analyzeText.traps();
  for (const text of [
    "見て https://example.com/" + "abcdefghij".repeat(30) + " すごい",
    "最高" + "😀".repeat(200) + "！",
    "w".repeat(1000), "ｗ".repeat(300), "𠮷".repeat(500),
  ]) assertCovers(text, analyzeText(text));
  assert.equal(analyzeText.traps(), before, "prevention should avoid every trap");
});

test("analyze: surfaces are the original characters even where Sudachi rewrites them", () => {
  for (const text of ["見て https://example.com/a?b=c&d=e", "時刻は12:30です", "㍿と①と㌔とＡＢＣとabcとｶﾀｶﾅ", "ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟとｶﾞｷﾞ"]) {
    assertCovers(text, analyzeText(text));
  }
});

test("analyze: the safety net splits a piece that still traps", () => {
  const fake = (text) => {
    if (Array.from(text).length > 10) throw new WebAssembly.RuntimeError("unreachable");
    return JSON.stringify(Array.from(text, (c) => ({ surface: c, poses: ["名詞", "普通名詞", "一般", "*", "*", "*"], dictionary_form: "", reading_form: c, normalized_form: c })));
  };
  const analyze = makeAnalyzeText(fake);
  const text = "あいうえおかきくけこさしすせそたちつてと".repeat(3);
  assertCovers(text, analyze(text));
  assert.ok(analyze.traps() > 0);
});

test("analyze: long text keeps memory flat and matches one call", () => {
  const text = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。\n".repeat(1500); // ~52,000 chars
  const m = analyzeText(text);
  assertCovers(text, m);
  assert.ok(memory.buffer.byteLength < 160 * 1048576, `memory grew to ${(memory.buffer.byteLength / 1048576).toFixed(0)} MB`);
  const short = text.slice(0, 5000);
  assert.deepEqual(analyzeText(short).map((x) => x.surface), JSON.parse(glue.tokenize(short, 2)).map((x) => x.surface));
});
