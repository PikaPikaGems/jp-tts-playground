// Downloads the large files that are NOT stored in git (see .gitignore): voice models, the Sudachi binary and,
// optionally, the Style-BERT-VITS2 files.
//
//   npm run fetch-assets            piper-plus voices + Sudachi           (~200 MB)
//   npm run fetch-assets:sbv2       ...plus the Style-BERT-VITS2 files    (~+500 MB)
//   add --force to re-download files that already exist
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FORCE = process.argv.includes("--force");
const SBV2 = process.argv.includes("--sbv2");
const HF = "https://huggingface.co";

const rel = (p) => path.relative(ROOT, p);
async function download(url, dest) {
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log(`  have  ${rel(dest)}`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0, lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
    if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  fetch ${rel(dest)} ${total ? pct + "%" : (got / 1048576).toFixed(0) + " MB"}   `); }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, dest);
  console.log(`\r  saved ${rel(dest)} (${(got / 1048576).toFixed(1)} MB)          `);
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---- piper-plus voices ------------------------------------------------------------------------------------------
console.log("piper-plus voices");
const voices = {
  tsukuyomi: [`${HF}/ayousanz/piper-plus-tsukuyomi-chan/resolve/main`, "tsukuyomi-chan-6lang-fp16.onnx"],
  css10: [`${HF}/ayousanz/piper-plus-css10-ja-6lang/resolve/main`, "css10-ja-6lang-fp16.onnx"],
  mera: [`${HF}/kizuna-intelligence/piper-plus-mera-multilingual/resolve/main`, "mera-multilingual.onnx"],
};
for (const [name, [base, onnx]] of Object.entries(voices)) {
  await download(`${base}/${onnx}`, path.join(ROOT, "models", name, "model.onnx"));
  await download(`${base}/config.json`, path.join(ROOT, "models", name, "config.json"));
}

// ---- Sudachi (wasm extracted from the npm package) ------------------------------------------------------------
console.log("Sudachi");
const SUDACHI_SHA256 = "c1485e172eb74e07c487ef8e0ed43044ec7424281cca3784dd2e81182f45dc8e";
const sudachiDest = path.join(ROOT, "models/sudachi/sudachi.wasm");
if (!FORCE && fs.existsSync(sudachiDest)) console.log(`  have  ${rel(sudachiDest)}`);
else {
  // The npm file `sudachi.js` is wasm-bindgen glue followed by the whole binary as one base64 string. The glue is
  // already committed as src/sudachi-glue.js; here we only need the binary.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sudachi-"));
  console.log("  npm pack sudachi@0.1.5 (a 164 MB download)...");
  execFileSync("npm", ["pack", "sudachi@0.1.5", "--pack-destination", tmp, "--silent"], { stdio: "inherit" });
  execFileSync("tar", ["-xzf", path.join(tmp, "sudachi-0.1.5.tgz"), "-C", tmp]);
  const js = fs.readFileSync(path.join(tmp, "package/sudachi.js"));
  const marker = Buffer.from("const wasmBASE64 = '");
  const start = js.indexOf(marker) + marker.length;
  const end = js.indexOf(Buffer.from("';"), start);
  if (start < marker.length || end < 0) throw new Error("could not find the embedded wasm in sudachi.js (package layout changed?)");
  const wasm = Buffer.from(js.subarray(start, end).toString("latin1"), "base64");
  const hash = sha256(wasm);
  if (hash !== SUDACHI_SHA256) console.warn(`  WARNING: sha256 ${hash} differs from the version this project was built with`);
  fs.mkdirSync(path.dirname(sudachiDest), { recursive: true });
  fs.writeFileSync(sudachiDest, wasm);
  fs.copyFileSync(path.join(tmp, "package/LICENSE"), path.join(ROOT, "models/sudachi/LICENSE-Apache-2.0.txt"));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  saved ${rel(sudachiDest)} (${(wasm.length / 1048576).toFixed(1)} MB)`);
}

// ---- Style-BERT-VITS2 (optional, local only) -------------------------------------------------------------------------
if (SBV2) {
  console.log("Style-BERT-VITS2 (local-only panel)");
  const acoustic = path.join(ROOT, "models/sbv2-tsukuyomi");
  await download(`${HF}/googlefan/sbv2_onnx_models/resolve/main/model_tsukuyomi.onnx`, path.join(acoustic, "model.onnx"));
  const stylesJson = path.join(acoustic, "style_vectors.json");
  await download(`${HF}/googlefan/sbv2_onnx_models/resolve/main/style_vectors_tsukuyomi.json`, stylesJson);
  // The runtime wants a NumPy .npy file: write float32 [rows, dims] by hand.
  const { data } = JSON.parse(fs.readFileSync(stylesJson, "utf8"));
  const rows = data.length, dims = data[0].length;
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${dims}), }`;
  header += " ".repeat((64 - ((10 + header.length + 1) % 64)) % 64) + "\n";
  const prefix = Buffer.alloc(10);
  prefix.write("\x93NUMPY", 0, "latin1"); prefix[6] = 1; prefix[7] = 0; prefix.writeUInt16LE(header.length, 8);
  const floats = Buffer.alloc(rows * dims * 4);
  data.flat().forEach((v, i) => floats.writeFloatLE(v, i * 4));
  fs.writeFileSync(path.join(acoustic, "style_vectors.npy"), Buffer.concat([prefix, Buffer.from(header, "latin1"), floats]));
  console.log(`  saved ${rel(path.join(acoustic, "style_vectors.npy"))}`);

  const shared = path.join(ROOT, "models/sbv2-shared");
  const deberta = `${HF}/hdae/deberta-v2-large-japanese-char-wwm-onnx-int4-rtn-b256/resolve/3c6921bf67ee5f64a285f49df8636c1036b81881`;
  for (const f of ["model.onnx", "vocab.txt", "clean_ranges.json", "meta.json"]) await download(`${deberta}/${f}`, path.join(shared, `deberta-${f}`));
  await download(`${HF}/datasets/hdae/yomi-dict/resolve/ab847217c833593c3aec9875b9bfa6ff9789dc29/naist-jdic.jtd.gz`, path.join(shared, "naist-jdic.jtd.gz"));
  console.log("  done. Next: npm run build:sbv2   (bundles the worker into dist/)");
}
console.log("\nDone.");
