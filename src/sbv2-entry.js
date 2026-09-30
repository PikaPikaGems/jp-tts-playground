// Bundled (via src/sbv2-worker.js) with esbuild -> dist/sbv2-worker.js; runs inside a Web Worker. Wraps @hdae/sbv2-web (Style-BERT-VITS2 JP-Extra) for the test page.
import * as ort from "onnxruntime-web";
import { Sbv2ModelAdapter, buildDebertaTokenizer, synthesizeText } from "@jsr/hdae__sbv2-web";
import { JtdDictionary } from "@jsr/hdae__yomi";

// Single-threaded. A 4-thread attempt (with serve.py's COOP/COEP headers) was still stuck in
// InferenceSession.create after 2+ minutes, but session creation was also slow (30-40s) on an
// already memory-starved machine, so that test was inconclusive. Not retried.
export const THREADS = 1;
ort.env.wasm.numThreads = THREADS;
ort.env.wasm.wasmPaths = new URL("../node_modules/@jsr/hdae__sbv2-web/node_modules/onnxruntime-web/dist/", import.meta.url).href;

let base = "";
const abs = (p) => new URL(p, base).href;

// Streams straight into one preallocated buffer when Content-Length is known
// (the naive chunks[] + concat approach briefly holds 2x the model size).
async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  let out = new Uint8Array(total || 1 << 20);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, loaded + value.length));
      bigger.set(out.subarray(0, loaded));
      out = bigger;
    }
    out.set(value, loaded);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return loaded === out.length ? out : out.slice(0, loaded);
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

const mb = (n) => (n / 1048576).toFixed(0);

let adapter = null, tokenizer = null, dict = null, sampleRate = 44100;

export const DEFAULT_SCALARS = { lengthScale: 1, sdpRatio: 0.2, noiseScale: 0.6, noiseScaleW: 0.8 };

/** @param {{base: string, log: (m:string)=>void}} o  base = folder with sbv2-shared/ and the acoustic model files */
export async function load({ baseUrl, acousticDir, acousticFile = "model.onnx", sharedDir, log }) {
  base = baseUrl;
  await adapter?.release?.();
  adapter = null;
  const prog = (label) => { let last = 0; return (l, t) => { if (l - last > 8e6 || l === t) { last = l; log(`${label}: ${mb(l)}${t ? "/" + mb(t) : ""} MB`); } }; };

  log("Loading tokenizer + dictionary...");
  const text = async (f) => (await fetch(abs(`${sharedDir}/${f}`))).text();
  tokenizer = buildDebertaTokenizer(await text("deberta-vocab.txt"), await text("deberta-clean_ranges.json"), await text("deberta-meta.json"));
  const dictBytes = await gunzip(await fetchBytes(abs(`${sharedDir}/naist-jdic.jtd.gz`)));
  dict = JtdDictionary.load(dictBytes, { verifyChecksums: false }); // needs an ArrayBuffer, not a Uint8Array view

  const bertOnnxBytes = await fetchBytes(abs(`${sharedDir}/deberta-model.onnx`), prog("DeBERTa"));
  const acousticOnnxBytes = await fetchBytes(abs(`${acousticDir}/${acousticFile}`), prog("Acoustic model"));
  const styleVectorsNpy = await fetchBytes(abs(`${acousticDir}/style_vectors.npy`));

  log(`Creating ONNX sessions with ${THREADS} thread(s) (this can take a while)...`);
  adapter = await Sbv2ModelAdapter.createFromOnnx({
    acousticOnnxBytes, bertOnnxBytes, tokenizer, styleVectorsNpy, sampleRate,
    sessionOptions: { executionProviders: ["wasm"] },
  });
  return { sampleRate };
}

export async function synthesize(text, scalars) {
  if (!adapter) throw new Error("model not loaded");
  const samples = await synthesizeText(text, dict, tokenizer, adapter, {
    scalars: { ...DEFAULT_SCALARS, ...scalars },
    postSilenceSec: 0.1,
  });
  return { samples, sampleRate };
}
