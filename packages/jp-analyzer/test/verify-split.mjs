// Checks that Sudachi loaded the split way (program + dictionary parts written into memory) gives exactly the same
// output as the original single wasm, and reports memory use.
//
//   node packages/jp-analyzer/test/verify-split.mjs <original sudachi.wasm> <dict dir written by copy-dict>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [origPath, dictDir] = process.argv.slice(2);
if (!origPath || !dictDir) { console.error("usage: verify-split.mjs <sudachi.wasm> <dict dir>/sudachi"); process.exit(1); }

// Two separate instances of the glue module (it keeps the wasm instance in module state).
const orig = await import("../src/engines/sudachi-glue.js?original");
const split = await import("../src/engines/sudachi-glue.js?split");

await orig.default(fs.readFileSync(origPath));

const manifest = JSON.parse(fs.readFileSync(path.join(dictDir, "manifest.json"), "utf8"));
const { memory } = await split.default(fs.readFileSync(path.join(dictDir, manifest.code.file)));
const data = Buffer.concat(manifest.data.parts.map((p) => zlib.gunzipSync(fs.readFileSync(path.join(dictDir, p.file)))));
if (data.length !== manifest.data.rawSize) throw new Error("rawSize mismatch");
let o = 0;
for (const s of manifest.segments) { new Uint8Array(memory.buffer, s.offset, s.length).set(data.subarray(o, o + s.length)); o += s.length; }

const texts = [
  "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。",
  "今日は良い天気ですね。", "東京スカイツリーに行きたい。", "彼はスマホでツイートした。",
  "食べさせられたくなかった。", "附属病院で新型コロナウイルスのワクチンを接種した。", "推しの配信が尊すぎて無理。",
  "お疲れ様でした！また明日。", "「行こう！」と彼は言った。", "2024年3月15日（金）午後5時30分に集合。",
  "ｶﾀｶﾅとＡＢＣと𠮷野家", "すもももももももものうち", "", " ", "日本語の形態素解析をブラウザで行う。",
];
const long = fs.readFileSync(new URL("../../../src/furigana.js", import.meta.url), "utf8").match(/[　-鿿＀-￯]+/g).join("。");
texts.push(long);

let same = 0;
for (const t of texts) {
  const a = orig.tokenize(t, 2), b = split.tokenize(t, 2);
  if (a === b) same++;
  else console.log("DIFF:", t.slice(0, 40), "\n  original:", a.slice(0, 200), "\n  split:   ", b.slice(0, 200));
}
console.log(`${same}/${texts.length} texts identical (${long.length} chars in the longest)`);
console.log(`split instance linear memory: ${(memory.buffer.byteLength / 1048576).toFixed(1)} MB`);
process.exit(same === texts.length ? 0 : 1);
