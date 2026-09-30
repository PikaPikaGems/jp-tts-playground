import { build } from "esbuild";
await build({
  entryPoints: ["src/sbv2-worker.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/sbv2-worker.js",
  alias: { "onnxruntime-web": "./node_modules/@jsr/hdae__sbv2-web/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs" },
  logLevel: "info",
});
