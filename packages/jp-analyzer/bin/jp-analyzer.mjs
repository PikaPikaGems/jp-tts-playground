#!/usr/bin/env node
// jp-analyzer command line.
//
//   npx jp-analyzer copy-dict sudachi <out-dir> [--part-size <MB>] [--source <sudachi.wasm>]
//
// Writes <out-dir>/sudachi/: manifest.json, the program (sudachi-code.wasm, dictionary removed) and the dictionary
// as independently gzipped parts of at most --part-size MB (default 20) before compression, so every file fits
// Cloudflare Pages (25 MiB per file) and GitHub Pages. The browser streams each part straight into Sudachi's memory.
//
// The Sudachi binary comes from --source, or from the npm package sudachi@0.1.5 (downloaded once, cached in
// ~/.cache/jp-analyzer).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { splitWasm } from "./split-wasm.mjs";

const SUDACHI_NPM = "sudachi@0.1.5";
const SUDACHI_SHA256 = "c1485e172eb74e07c487ef8e0ed43044ec7424281cca3784dd2e81182f45dc8e";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CACHE = path.join(os.homedir(), ".cache", "jp-analyzer");

const die = (msg) => { console.error(`jp-analyzer: ${msg}`); process.exit(1); };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const mb = (n) => (n / 1048576).toFixed(1);

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) die(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

/** The original Sudachi binary (program + dictionary in one wasm file). */
function sudachiSource(source) {
  if (source) return fs.readFileSync(source);
  const cached = path.join(CACHE, "sudachi-0.1.5.wasm");
  if (fs.existsSync(cached)) return fs.readFileSync(cached);

  // The npm file `sudachi.js` is wasm-bindgen glue followed by the whole binary as one base64 string.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jp-analyzer-"));
  try {
    console.log(`Downloading ${SUDACHI_NPM} (164 MB, once)...`);
    execFileSync("npm", ["pack", SUDACHI_NPM, "--pack-destination", tmp, "--silent"], { stdio: "inherit" });
    execFileSync("tar", ["-xzf", path.join(tmp, "sudachi-0.1.5.tgz"), "-C", tmp]);
    const js = fs.readFileSync(path.join(tmp, "package/sudachi.js"));
    const marker = Buffer.from("const wasmBASE64 = '");
    const start = js.indexOf(marker) + marker.length;
    const end = js.indexOf(Buffer.from("';"), start);
    if (start < marker.length || end < 0) die("could not find the embedded wasm in sudachi.js (package layout changed?)");
    const wasm = Buffer.from(js.subarray(start, end).toString("latin1"), "base64");
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(cached, wasm);
    fs.copyFileSync(path.join(tmp, "package/LICENSE"), path.join(CACHE, "sudachi-LICENSE-Apache-2.0.txt"));
    return wasm;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function copyDictSudachi(outRoot, partMB, source) {
  const wasm = sudachiSource(source);
  const hash = sha256(wasm);
  if (hash !== SUDACHI_SHA256) console.warn(`WARNING: sha256 ${hash} is not the Sudachi build this package was tested with`);

  const { code, segments } = splitWasm(wasm);
  const out = path.join(outRoot, "sudachi");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  fs.writeFileSync(path.join(out, "sudachi-code.wasm"), code);
  const data = Buffer.concat(segments.map((s) => s.bytes));
  const partBytes = Math.floor(partMB * 1024 * 1024);
  const parts = [];
  for (let i = 0, n = 1; i < data.length; i += partBytes, n++) {
    const raw = data.subarray(i, i + partBytes);
    const gz = zlib.gzipSync(raw, { level: 9 });
    const file = `dict.part${String(n).padStart(3, "0")}.gz`;
    fs.writeFileSync(path.join(out, file), gz);
    parts.push({ file, size: gz.length, rawSize: raw.length, sha256: sha256(gz) });
  }

  const manifest = {
    format: "jp-analyzer-dict/1",
    engine: "sudachi",
    version: `${SUDACHI_NPM.split("@")[1]}+${hash.slice(0, 12)}`,
    code: { file: "sudachi-code.wasm", size: code.length, sha256: sha256(code) },
    // Where each piece of the data stream goes in Sudachi's memory (the data segments removed from the wasm).
    segments: segments.map((s) => ({ offset: s.offset, length: s.bytes.length })),
    data: { rawSize: data.length, parts },
    downloadSize: code.length + parts.reduce((a, p) => a + p.size, 0),
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const license = [path.join(CACHE, "sudachi-LICENSE-Apache-2.0.txt"), path.join(HERE, "../../../models/sudachi/LICENSE-Apache-2.0.txt")]
    .find((p) => fs.existsSync(p));
  if (license) fs.copyFileSync(license, path.join(out, "LICENSE-Apache-2.0.txt"));

  console.log(`Wrote ${out}`);
  console.log(`  sudachi-code.wasm  ${mb(code.length)} MB`);
  for (const p of parts) console.log(`  ${p.file}  ${mb(p.size)} MB (${mb(p.rawSize)} MB unpacked)`);
  console.log(`  download total     ${mb(manifest.downloadSize)} MB`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "copy-dict") {
  const partMB = Number(argValue(args, "--part-size") ?? 20);
  const source = argValue(args, "--source");
  const [engine, outDir] = args;
  if (!engine || !outDir) die("usage: jp-analyzer copy-dict sudachi <out-dir> [--part-size <MB>] [--source <sudachi.wasm>]");
  if (!(partMB > 0 && partMB <= 24)) die("--part-size must be between 0 and 24 (MB, before compression)");
  if (engine === "sudachi") copyDictSudachi(outDir, partMB, source);
  else die(`unknown engine "${engine}" (available: sudachi)`);
} else {
  die("usage: jp-analyzer copy-dict sudachi <out-dir> [--part-size <MB>] [--source <sudachi.wasm>]");
}
