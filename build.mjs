import fs from "node:fs";
import { build } from "esbuild";

// The ONNX Runtime that @jsr/hdae__sbv2-web was made for (it pins its own version): nested under it, or hoisted to the
// top of node_modules when nothing else needs a different version.
const ORT_BUNDLE = "onnxruntime-web/dist/ort.bundle.min.mjs";
const ort = [`./node_modules/@jsr/hdae__sbv2-web/node_modules/${ORT_BUNDLE}`, `./node_modules/${ORT_BUNDLE}`].find((p) => fs.existsSync(p));
if (!ort) throw new Error("onnxruntime-web for Style-BERT-VITS2 not found: run `npm install`");

await build({
  entryPoints: ["src/sbv2-worker.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/sbv2-worker.js",
  alias: { "onnxruntime-web": ort },
  logLevel: "info",
});
