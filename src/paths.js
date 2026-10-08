// Where the page finds its models. This is the DEV version (serves straight from models/). `npm run build:deploy`
// writes a different copy of this file into deploy/ (sbv2: false). The voice (yomiage) is always in ./yomiage/.
export const PATHS = {
  sudachiManifest: "models/sudachi/manifest.json", // chunked + gzipped build (optional in dev)
  sudachiRaw: "models/sudachi/sudachi.wasm", // fallback: single raw file
  sbv2: true, // Style-BERT-VITS2 panel (needs ~500 MB of local model files, see README)
};
