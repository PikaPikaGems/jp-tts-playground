// The Sudachi engine: `import { sudachi } from "jp-analyzer/sudachi"`.

/**
 * @param {{ dictUrl: string }} options  dictUrl = the manifest.json written by `jp-analyzer copy-dict sudachi`
 * @returns {import("../types.ts").EngineConfig}
 */
export function sudachi({ dictUrl } = {}) {
  if (!dictUrl) throw new TypeError("sudachi(): dictUrl is required");
  return Object.freeze({
    name: "sudachi",
    dictUrl,
    // Written as one expression so bundlers (Vite, webpack 5, esbuild, Parcel) find and bundle the worker file.
    createWorker: () => new Worker(new URL("./sudachi-worker.js", import.meta.url), { type: "module" }),
  });
}
