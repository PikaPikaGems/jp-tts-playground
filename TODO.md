# TODO: next work on wakachi, yomiage and kakera

A handoff for a fresh session. Everything needed to start is here; the details live in the files it points to.
Written 2026-10-09.

Items 1–3 are done (3 not released yet: ask the owner first). Next: **4 (reading fixes)**. Item 5 is parked.

1. [x] [Debug report](#1-debug-report) (implemented 2026-10-09)
2. [x] [TypeScript](#2-typescript) (all three packages; implemented 2026-10-09)
3. [x] [React hooks](#3-react-hooks) (yomiage/react, wakachi/react; implemented 2026-10-10, not released)
4. [Reading fixes](#4-reading-fixes) (wakachi)
5. [Parked: yomiage memory on Safari](#5-parked-yomiage-memory-on-safari)

---

## The projects

All in `~/Desktop/PikaPikaGems/`, each its own public GitHub repo under `PikaPikaGems/`, MIT, experimental:

| Folder | What it is | Docs to read first |
|---|---|---|
| `kakera/` | Shared plumbing, bundled into both packages: big files split into parts, downloaded once into IndexedDB, a Web Worker per engine (`createPool`, `handle`), crash guard, timeouts, `kakera/wasm` | README.md, src/host.ts |
| `wakachi/` | Japanese analyzer in the browser: Sudachi (our own WebAssembly build) + furigana, readings, bunsetsu | API.md, PENDING.md |
| `yomiage/` | Japanese text-to-speech in the browser: Tsukuyomi-chan voice (piper-plus + ONNX Runtime), presets | API.md, PENDING.md, NOTICE.md |
| `jp-tts-playground/` | The playground site that uses both, installed from their GitHub releases | README.md, PENDING.md |

- **Dependencies:** wakachi and yomiage depend on kakera as `file:../kakera` (devDependency, bundled by esbuild at
  build time), so the folders must stay side by side.
- **Files:** each package's big files (dictionary, voice model) are made by `npm run files` and attached to its GitHub
  release. Apps copy them in with `wakachi copy-files <folder>` / `yomiage copy-files <folder>`.
- **Demos:** https://pikapikagems.github.io/wakachi/ and https://pikapikagems.github.io/yomiage/ (`npm run publish:demo`
  in each package). Playground: https://pikapikagems.github.io/jp-tts-playground/
  (`npm run build:deploy && npm run publish:gh-pages`).
- **Versions now:** wakachi 0.1.0, yomiage 0.2.0 (pre-releases on GitHub; not on npm).

### Working on them

```bash
npm ci --prefix ../kakera # install build tools and build kakera first
npm ci                 # in wakachi/ or yomiage/
npm run build          # dist/
npm run files          # files/ (downloads the Sudachi build or the voice model into .cache/ once)
npm test               # Node tests; CI runs these plus `npm run test:types` on every push
npm run test:types     # type checks (types/*.d.ts against test/types)
```

Browser test pages, with a "Run checks" button: `wakachi/test/analyzer.html`, `yomiage/test/voice.html`,
`kakera/test/host.html`. Serve the package folder (e.g. `python3 -m http.server 8095 --bind 127.0.0.1` from it),
after `node bin/<package>.mjs copy-files test/files --from files`. `.claude/launch.json` in jp-tts-playground has
ready-made preview configs. yomiage also has `npm run test:webkit` (Safari's engine via Playwright, see item 5).

### Ground rules (from the owner)

- **Keep it simple.** Prefer the simplest design that works; explain decisions in plain language.
- **Ask before:** releasing, publishing anything new, making repos public, creating repos. Pushing to `main` and
  republishing the demos after a change has been fine.
- **jp-tts-playground:** never `git add -A`. `.claude/` and `datasets/` must never be committed; add files by name.
- **Docs:** each README starts with the experimental warning. Sizes are in decimal MB, like `info().downloadMB`.
- **Language:** wakachi's `pos` / `tags` are Japanese (Sudachi's own tags). English is only through the helpers
  `posInEnglish` / `posLabel(word, "en")`.
- **Loading:** nothing downloads or loads by itself, ever: only `load()` does, from something the user chose.
- **Measure, don't guess:** memory claims are measured (see item 5 for how). Chrome and Safari behave very
  differently.
- **Commits:** end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the attribution the
  session asks for).

### Releasing (only after the owner says yes)

1. Bump `version` in package.json.
2. Run `npm run build && npm run files && npm pack`.
3. Commit, tag `v<version>`, push the tag.
4. Run `gh release create v<version> <name>-<version>.tgz files/* --prerelease --verify-tag`, with notes like the
   previous release's.
5. Republish the demo.
6. In jp-tts-playground, point package.json at the new tarball URL, then `npm install && npm run files`. Test in the
   browser, commit, then `npm run build:deploy && npm run publish:gh-pages`.

`copy-files` takes the files from the release matching the package version, so a worker change that needs new files
also needs a release.

---

## 1. Debug report

**Goal:** one call that returns a block of plain text a user can paste into a bug report when loading or speaking
fails. Implemented 2026-10-09 in kakera and exposed by both package APIs.

**API:**
- `voice.debugReport()` / `analyzer.debugReport()` → `Promise<string>`.
- Later, `e.debugReport()` on the React engine hooks (item 3).

The report is built in kakera (both packages share it) and exposed from each package's API and types. It contains:
- **Versions:** the package version (passed in by the package), kakera's version, the date.
- **Browser and device:** `navigator.userAgent`; `navigator.deviceMemory` if present; `crossOriginIsolated`.
- **Files:** the files address (`filesUrl`) and the manifest version, and whether it matches the package's.
- **Status and last error:** `status`; the last error's `code`, `message` and `cause` (also nested causes).
- **The device copy:** which parts are in IndexedDB, and which are missing. kakera's file store already knows this;
  `info()` uses it.
- **Storage:** `navigator.storage.estimate()` and `navigator.storage.persisted()`.
- **Crash guard:** the record kept in localStorage (`${prefix}:crashed:<key>`; see `createPool` in kakera/src/host.ts).
  If the last load crashed the tab: when, and until when loading is blocked.
- **Log of the last load:** each step with time, file and part. kakera already emits these as `on("log")` lines and
  as `load()`'s `timings`; keep the last load's in memory.

Rules:
- **Never include the user's text** (what was analyzed or spoken), nor anything else personal. It must be safe to
  paste into a public GitHub issue.
- **It must work in every state:** never loaded, loading, failed, `unavailable`, after `dispose()`. It must never
  throw; a missing piece is written as "unknown".
- **Tests:** kakera's `test/debug-report.test.mjs` checks the report sections, a failed load, and that text given to
  calls doesn't appear. `fileStore.diagnostics()` is checked for cached and missing parts. Both package test pages
  (`test/voice.html`, `test/analyzer.html`) have a "Copy debug report" button.
- **Docs:** the planned sections in both API.md files are now current, and the PENDING items are checked off.

## 2. TypeScript

**Completed (2026-10-09, merged):** all three packages use strict TypeScript and generate declarations from source.
Kakera builds JavaScript and declarations into `dist/`; wakachi and yomiage retain their esbuild bundles and publish
self-contained declarations in `dist/types/`. Their original public APIs are preserved by compatibility tests.
Build kakera first (`npm ci --prefix ../kakera`); then build either package. Rebuild after editing source.

Checks passed:
- kakera: 13 Node tests and 19 host checks in each of Chromium and WebKit.
- wakachi: 23 Node tests and 13 analyzer checks in each browser.
- yomiage: 23 Node tests and 14 voice checks in each browser.
- Strict source checks, public type tests, and both packed packages checked outside the workspace without kakera.
- Playground analysis and speech using both local packages together in Chromium and WebKit; no model/dictionary
  downloads before explicit loading.

Generated Sudachi glue and model/dictionary data are unchanged. Each repository has its own migration checkpoint;
no releases or publishing are included.
The instructions below record the migration scope.

**Goal:** convert kakera, wakachi and yomiage from JavaScript (with hand-written `.d.ts`) to TypeScript, and generate
the published `.d.ts` from the code. The owner asked why the packages weren't TypeScript; the answer was "no strong
reason, inherited from the playground". The weak spot today: `types/index.d.ts` is hand-written, and nothing checks it
against the code.

Approach (agreed in outline; check it with the owner if something gets complicated):
- **Rename** `src/*.js` → `src/*.ts`, and type them properly. The React hooks' types (item 3) rely on status-based
  union types, so model `status` the same way.
- **Build:** esbuild already bundles each package (`scripts/build.mjs`) and compiles TypeScript as it bundles; only the
  entry points change. Generated glue files stay JavaScript, typed with `allowJs`:
  - `wakachi/src/sudachi-glue.js`, from the Sudachi build: keep it exactly as built;
  - piper-plus and onnxruntime-web, imported from node_modules.
- **Types:** `tsc --emitDeclarationOnly` writes the `.d.ts` files. They must describe the same public API as today's
  `types/index.d.ts` / `types/text.d.ts`. Compare before deleting the hand-written ones, and keep `test/types` (it
  checks example usage compiles) as the guard.
- **Order:** kakera first (both depend on it), then wakachi, then yomiage.
- **Must stay the same:** `dist/` output works the same, the files in `files/` don't change (no release needed just
  for this), and all tests and test pages pass. Run the browser checks after each package.
- **Scripts:** `scripts/*.mjs` (Node build tools) can stay JavaScript.
- **Docs:** update READMEs/API.md where they mention `types/`.

## 3. React hooks

**Implemented 2026-10-10** (branch `react-hooks` in kakera, wakachi, yomiage; not released). How it turned out:
- kakera has `engineStore()` (`kakera/store`): the engine hooks' state, without React.
- Each package has `src/react.ts` (the hooks) and `src/react-state.ts` (the use hook's state without React, for the
  Node tests). `dist/react.js` imports the main bundle (`./wakachi.js` / `./yomiage.js`), so the page has one engine.
- **One shared handle per `filesUrl`** for all hooks, not one per hook: in kakera each handle has its own "loaded"
  state, so with one handle per hook a `load()` in one component wouldn't have unlocked the others. Per-hook
  options (wakachi's `readings` / `everydayReadings`, yomiage's voice settings) are applied by each hook.
- The use hooks never reject: failures show as `status: "error"` with `retry()`. `cached` / `downloadMB` are `null`
  until the manifest has been read.
- Fixed in kakera on the way: a handle said `"ready"` before its own `load()` had finished.
- Checks: Node tests, type tests, and `test/react.html` in each package (Chromium and WebKit).

The original plan:

**Goal:** `yomiage/react` and `wakachi/react`, with React as an *optional* peer dependency (plain-JS apps never need
it). The design was agreed with the owner and is written up in yomiage/API.md §11 and wakachi/API.md §12. Read those
first. In short:

| | Manage it (settings page) | Use it (where the feature is) |
|---|---|---|
| wakachi | `useWakachiEngine(options?)` | `useWakachi(text, options?)` |
| yomiage | `useYomiageEngine(options?)` | `useYomiage(options?)` |

- **Engine hooks** (same shape in both): `status`, `cached`, `downloadMB`, `progress`, `error`, `load()`, `unload()`,
  `clearCache()`, `debugReport()` (from item 1).
- **Use hooks:** return one object whose fields depend on `status`, typed as a union, so TypeScript catches using
  `words` / `speak` too early:
  - `"not-loaded"`: `load`, `cached`, `downloadMB`
  - `"loading"`: `progress` (`stage` is `"downloading"` or `"preparing"`)
  - `"done"` (wakachi): `words`, `bunsetsu`, `furigana`, `stale`
  - `"ready"` (yomiage): `speak`, `stop`, `speaking`, `sentence`
  - `"unavailable"`: `reason`
  - `"error"`: `error`, `retry`

Rules:
- **Nothing loads by itself:** only `load()` starts a download or a load. No hook loads on mount.
- **No provider:** all components share one engine. In both packages the heavy part is already shared per page by
  kakera's pool; each `createAnalyzer()` / `createVoice()` is a light handle. So hooks create their own handle with
  their options; `load()` anywhere loads it for all.
- **When the memory was freed** (idle / hidden / `unload()`), the next use shows `"loading"` briefly. It reloads from
  the device, without downloading.
- **`useWakachi(text)`:**
  - when `text` changes, it drops answers to outdated text;
  - it keeps the previous result with `stale: true` until the new one arrives, so nothing flickers;
  - long texts are analyzed in batches (`analyzeMany` per line, like jp-tts-playground's app.js does).
- **`useYomiage()`:** `sentence` is `{ text, start, end }` of the sentence being read (from `onSentence`), for
  highlighting. Unmounting stops the sound this component started; the voice stays loaded for others.
- **No `<Furigana>` component** (decided). API.md shows the few lines with `furiganaOf` and `<ruby>`.

Packaging and testing:
- **Packaging:**
  - `package.json` `exports["./react"]`;
  - `peerDependencies: { react: ">=18" }` with `peerDependenciesMeta.react.optional = true`;
  - a build entry so `dist/react.js` doesn't bundle React.
- **Tests:**
  - Node tests with a fake engine where possible (status transitions, stale handling, no load on mount);
  - a small test page per package using the hooks;
  - types: extend `test/types` with hook usage, including the status narrowing.
- **Docs:** remove "*(planned, not built yet)*" from API.md §11 / §12 once built; update README and PENDING. (Done.)
- **Then**, with the owner's OK: release both packages, and consider moving jp-tts-playground's reader to the hooks
  only if the owner wants (it's plain JS today).

## 4. Reading fixes

**Goal:** fewer wrong readings in wakachi, judged against jp-word-ranks-data (a sibling checkout:
`~/Desktop/PikaPikaGems/jp-word-ranks-data/OUTPUT/with_definition.tsv`, word in column 0, readings in column 19,
comma-separated).

- **Tool:** `node scripts/check-readings.mjs` in wakachi (after `npm run build` and `npm run files`). It writes the mismatches to
  `.cache/readings-mismatches.tsv`: rank, word, wakachi's reading, expected readings, how Sudachi cut the word.
  - `--words 10000` for the most frequent only;
  - `--raw` for Sudachi without wakachi's fixes.
- **Today (2026-10-09):**
  - all 37,608 kanji words: 2,682 raw → **2,303** with the fixes;
  - top 10,000: 391 → **261**.
- **Where the fixes live:** `src/readings.ts` (`fixReadings`): a word table, family words, rules for 何, 人, 所, 中,
  会社, 私, numbers with counters, and so on. Tests are in `test/readings.test.mjs` (they need the Sudachi build from
  `npm run files`).

Rules:
- Rules must not look across whitespace or line breaks.
- **Every change:** run the full check before and after, and look at *new* mismatches, not just the count.
  Regressions happened before (三分の一, 私生活, 第一人者, 零時, 日本銀行). Add a test for each fix.
- **Some mismatches are fine.** A single kanji out of context (等, 社, 歳), or a list choice like その後 そのご vs. そのあと
  or 頁 ぺーじ vs. ページ, isn't worth a rule. Prefer readings that are right in sentences.
- **Decided:** punctuation and symbols keep an empty reading.
- **Candidates already noted:** 今日は (こんにちは, as a greeting), 良い (いい), 体中 (からだじゅう).
- **Time-box it:** start with the top 10,000 list, and stop when fixes get very specific.
- **Docs:** update the numbers in wakachi/API.md ("Readings" section), scripts/check-readings.mjs's header comment
  and PENDING.md. A release is needed for apps to get the fixes; ask first.

## 5. Parked: yomiage memory on Safari

The owner paused this. Don't continue without asking. Full notes are in yomiage/PENDING.md (the "Parked" item). In
short:
- **Fixed in 0.2.0:**
  - the phonemizer's dictionary is streamed into memory (`kakera/wasm`);
  - finished audio players are disconnected.
- **Still open:** in about 1 run in 3, speaking a long text in WebKit grows ~570 → ~740 MB over 3 minutes and stays
  until the worker ends.
- **Tool:** `npm run test:webkit` in yomiage: Playwright WebKit + macOS `footprint`, the same number as Activity
  Monitor's Memory column. Not in CI yet, because it fails in those runs.
