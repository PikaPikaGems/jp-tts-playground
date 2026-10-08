# jp-tts-playground

A small in-browser playground for Japanese text-to-speech. Paste Japanese text, press **Speak**, and it is read aloud by
a neural voice running entirely in your browser (no server, nothing uploaded). A second panel analyses the same text
and shows it with furigana, bunsetsu grouping, part-of-speech colours and a dictionary-form popover.

**Live site:** https://pikapikagems.github.io/jp-tts-playground/

## Features

- **Speak** with the Tsukuyomi-chan voice through [yomiage](https://github.com/PikaPikaGems/yomiage), our package that
  runs [piper-plus](https://github.com/ayutaz/piper-plus) (ONNX in WebAssembly) in a Web Worker. Speed, expressiveness
  and rhythm sliders, and a loading bar with every loading step in the panel's log.
- **Voice presets** (from yomiage): independent *pitch* and *voice size (formant)* shifting with PSOLA, five filter
  presets (Original, Soft, Low, Deep, Deeper; Soft is the default) on top of the Tsukuyomi-chan voice, plus a
  *breathiness reduction* filter. The presets were picked by ear in `voice-lab.html`; large shifts still sound less
  clean than the original voice.
- **Reading view** ([Sudachi](https://github.com/WorksApplications/sudachi.rs) in WebAssembly): furigana on kanji
  (always, or on hover/tap), a space between bunsetsu, main words coloured by part of speech, and a popover with the
  dictionary form, the parts of each phrase (Japanese and English tag names) and 🔊 buttons for the word and the phrase.
- **Study mode**: one line per sentence, each with a 🔊 button (selected speed) and a 🐢 button (slow: 0.75x the selected speed).
- **Sentences with no Japanese** (e.g. English) are detected: read them (piper-plus in its English mode) or skip them.
- Optional, **local only**: a [Style-BERT-VITS2](https://github.com/litagin02/Style-Bert-VITS2) panel for comparison
  (needs ~500 MB of model files and 1.5 GB+ of RAM, so it is not part of the hosted site).

## Run it locally

Needs Node 22+ and Python 3.

```bash
npm install              # needs the yomiage repository checked out next to this one (../yomiage, built), see below
npm run fetch-assets     # downloads the Sudachi binary into models/ (git-ignored)
npm start                # copies yomiage's voice files into yomiage/, then serves http://localhost:8080
```

**yomiage** is installed from the folder next to this one (`"yomiage": "file:../yomiage"`) and its voice files come
from `../yomiage/files` (`npm run yomiage:files`; in yomiage: `npm install && npm run build && npm run files`).
yomiage is private for now; once it has a GitHub release, both will come from there instead.

Open http://localhost:8080, press **Load model** in the piper-plus panel, then **Speak**. Press **Load analyzer** in the
reading view (the first time this downloads ~42 MB; afterwards it comes from your browser's IndexedDB cache).

## Style-BERT-VITS2 panel (optional, local only)

The hosted site leaves this panel out because its models are far too large for GitHub Pages (and a phone). To run it
on your own machine:

```bash
npm run fetch-assets:sbv2    # ~500 MB: acoustic model, DeBERTa text encoder, dictionary, style vectors
npm run build:sbv2           # bundles the worker into dist/sbv2-worker.js
npm start                    # the panel appears at http://localhost:8080
```

What gets downloaded (all into `models/`, which is git-ignored):

| File | Size | Source |
|---|---|---|
| `sbv2-tsukuyomi/model.onnx` | 253 MB | [googlefan/sbv2_onnx_models](https://huggingface.co/googlefan/sbv2_onnx_models) (`model_tsukuyomi.onnx`) |
| `sbv2-tsukuyomi/style_vectors.npy` | 1 KB | same repo (`style_vectors_tsukuyomi.json`, converted to `.npy` by the script) |
| `sbv2-shared/deberta-*.{onnx,txt,json}` | 229 MB | [hdae/deberta-v2-large-japanese-char-wwm-onnx-int4-rtn-b256](https://huggingface.co/hdae/deberta-v2-large-japanese-char-wwm-onnx-int4-rtn-b256) (CC BY-SA 4.0) |
| `sbv2-shared/naist-jdic.jtd.gz` | 6.4 MB | [hdae/yomi-dict](https://huggingface.co/datasets/hdae/yomi-dict) |

Notes:

- Loading needs roughly **1.5-2 GB of RAM** and runs at about half real-time speed on a laptop. Close other heavy apps
  first; on a busy machine the browser can show a "page unresponsive" warning.
- Smaller acoustic model (optional): `pip install onnx onnxruntime`, then
  `python3 scripts/convert-fp16.py models/sbv2-tsukuyomi/model.onnx models/sbv2-tsukuyomi/model-fp16.onnx` gives a
  142 MB file with almost identical output. The dropdown already lists `model-fp16.onnx`. (An int8 version was tried
  and was ~3x slower, so it is not recommended.)
- The JSR packages need the registry line in `.npmrc` (already included): `@jsr:registry=https://npm.jsr.io`.
- The models keep their own licences; read their Hugging Face pages before reusing them.

## Build and deploy the static site

```bash
npm run build:deploy     # writes deploy/ : the page, yomiage and its voice files, Sudachi split into parts
npm run serve:deploy     # test exactly what will be published at http://localhost:8090
```

`deploy/` is a self-contained static site. It contains no `node_modules` and no Style-BERT-VITS2 files; the page
detects this (`src/paths.js`) and hides that panel.

**How big files are handled.** Static hosts limit file size (GitHub blocks pushes over 100 MB, Cloudflare Pages
rejects files over 25 MiB), so the build splits every large file into parts of at most 20 MiB plus a `manifest.json`:

| File | Size | Stored as |
|---|---|---|
| Sudachi binary (dictionary inside) | 117.5 MiB | 3 gzip parts (42 MiB) |
| Voice (yomiage: model, phonemizer, ONNX Runtime) | 109 MB | yomiage's own parts (65 MB), copied as they are into `yomiage/` |

At run time `src/chunks.js` (Sudachi) and yomiage download the parts, unzip them in a stream, check the SHA-256 from
the manifest and keep them in IndexedDB, so later visits download nothing. The build **fails if any file exceeds 25 MiB**.

### GitHub Pages

This repository publishes `deploy/` from the `gh-pages` branch (Settings → Pages → Deploy from a branch → `gh-pages`,
`/ (root)`). The `main` branch holds only source; large files come from `npm run fetch-assets`.

```bash
npm run build:deploy && npm run publish:gh-pages    # clones gh-pages, replaces its files, commits, pushes
```

### Cloudflare Pages

The build already respects Cloudflare's 25 MiB per-file limit (and stays far below its 20,000-file limit), so the
`deploy/` folder can be published as-is, for example with `npx wrangler pages deploy deploy`, or by pointing a Pages
project at the `gh-pages` branch with no build command and `/` as the output directory. (Not deployed there yet.)

## iPhone / iPad notes

- The page needs iOS/Safari **16.4+** (import maps and WebAssembly SIMD). Older browsers see a "please update" banner.
- Audio (and the browser voice) can only start from a tap on iOS; the Speak buttons unlock it inside the tap.
- Safari can delete a site's stored data after about 7 days without a visit, which would remove the cached Sudachi file
  (it simply downloads again). Adding the page to the Home Screen avoids that.
- The analyzer uses roughly 400 MB of RAM and stops itself after 60 s idle (`?idle=N` changes the delay, in seconds).
- Not yet tested on real iOS hardware.

## Project layout

```
index.html, app.js, style.css     the page
src/furigana.js                   bunsetsu grouping, furigana alignment, sentence splitting (pure functions)
src/psola.js                      pitch / formant shifting (PSOLA), used by the Style-BERT-VITS2 panel (yomiage has its own copy)
src/voicefx.js                    breathiness filter (Style-BERT-VITS2 panel)
voice-lab.html, src/voice-lab.js  compares yomiage's voice presets side by side (local development only)
yomiage/                          yomiage's voice files and engine worker (`npm run yomiage:files`, git-ignored)
scripts/test-psola.mjs            checks the pitch shifting on a synthetic voice
src/chunks.js                     loads split files: parts -> gunzip -> SHA-256 check -> IndexedDB cache
src/sudachi-worker.js             Web Worker: loads Sudachi and tokenises
src/sudachi-glue.js               wasm-bindgen glue for the Sudachi binary
src/paths.js                      where libraries and models live (dev vs. deploy)
src/sbv2-*.js, build.mjs          optional Style-BERT-VITS2 worker (local only)
scripts/fetch-assets.mjs          downloads Sudachi, optionally Style-BERT-VITS2
scripts/build-deploy.mjs          builds deploy/ (splits big files)
scripts/publish-gh-pages.mjs      pushes deploy/ to the gh-pages branch
serve.py                          tiny static server: python3 serve.py [port] [directory]
packages/jp-analyzer/             work in progress: reusable Sudachi package with lower memory use (see its API.md)
```

## Credits and licences

This project's own code is licensed under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`,
see [LICENSE](LICENSE)). In short: you may use, modify and share it, including commercially, but anyone who distributes
a modified version - or lets users interact with one over a network - must offer those users the complete source under the
same licence. The hosted site links to this repository for that reason.

The AGPL covers this project's code only. The voice models, dictionaries and libraries it uses keep their own licences
and terms - see [NOTICE.md](NOTICE.md). In particular the **Tsukuyomi-chan** voice requires a credit line (shown at the
bottom of the page).
