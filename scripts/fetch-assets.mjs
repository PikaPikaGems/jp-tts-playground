// Downloads the Style-BERT-VITS2 files (~500 MB, not stored in git; see .gitignore) for the local-only panel.
// The other models come with their packages: `npm run files` (yomiage's voice, wakachi's dictionary).
//
//   npm run fetch-assets:sbv2       add --force to re-download files that already exist
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FORCE = process.argv.includes("--force");
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

// ---- Style-BERT-VITS2 (optional, local only) -------------------------------------------------------------------------
{
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
