// Where the page finds its libraries and models. This is the DEV version (serves straight from node_modules/ and
// models/). `npm run build:deploy` writes a different copy of this file into deploy/ (vendor/ paths, sbv2: false).
export const PATHS = {
  ortDist: "./node_modules/onnxruntime-web/dist/",
  piperRustWasm: "./node_modules/piper-plus/dist/rust-wasm/piper_plus_wasm.js", // wasm-bindgen glue (+ _bg.wasm next to it in dev)
  piperRustManifest: null, // deploy: manifest of the gzip-split phonemizer binary
  chunked: false, // deploy: voice models are split into parts (see chunks.js)
  sudachiManifest: "models/sudachi/manifest.json", // chunked + gzipped build (optional in dev)
  sudachiRaw: "models/sudachi/sudachi.wasm", // fallback: single raw file
  sbv2: true, // Style-BERT-VITS2 panel (needs ~500 MB of local model files, see README)
};
