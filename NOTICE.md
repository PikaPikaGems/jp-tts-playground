# Third-party components and credits

This project bundles or loads the following third-party software and data. Each keeps its own licence; the summaries
below are provided for convenience and are **not legal advice** - check the linked sources before reusing anything.

## Voice models (loaded by the "piper-plus" panel)

| Model | Source | Licence / terms |
|---|---|---|
| つくよみちゃん (Tsukuyomi-chan) | [ayousanz/piper-plus-tsukuyomi-chan](https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan) | Follows the [つくよみちゃんコーパス terms](https://tyc.rei-yumesaki.net/material/corpus/): free use incl. commercial, **credit required** (below), some prohibited uses (e.g. attacking people, promoting specific political/religious positions). |
| CSS10 Japanese | [ayousanz/piper-plus-css10-ja-6lang](https://huggingface.co/ayousanz/piper-plus-css10-ja-6lang) | Trained on the [CSS10](https://github.com/Kyubyong/css10) dataset (public domain, LibriVox recordings). |
| Mera-chan | [kizuna-intelligence/piper-plus-mera-multilingual](https://huggingface.co/kizuna-intelligence/piper-plus-mera-multilingual) | Apache-2.0. The Mera-chan character itself belongs to Kizuna Intelligence; the model licence does not necessarily cover branding. |

**Required credit for the つくよみちゃん voice:**

> 音声合成には、フリー素材キャラクター「つくよみちゃん」（© Rei Yumesaki）が無料公開している音声データを使用しています。
> ■つくよみちゃんコーパス（CV.夢前黎）https://tyc.rei-yumesaki.net/material/corpus/

## Software

| Component | Use | Licence |
|---|---|---|
| [piper-plus](https://github.com/ayutaz/piper-plus) (`piper-plus`, `@piper-plus/g2p`) | text-to-speech engine, phonemizer | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | runs the voice models in the browser | MIT |
| [Sudachi](https://github.com/WorksApplications/sudachi.rs) + SudachiDict, WASM build from [hata6502/sudachi-wasm](https://github.com/hata6502/sudachi-wasm) (npm `sudachi@0.1.5`) | Japanese morphological analysis: readings, dictionary forms, part of speech | Apache-2.0. SudachiDict incorporates UniDic (BSD-3-Clause) and NEologd data - see the [upstream notices](https://github.com/hata6502/sudachi-wasm#disclaimer). |
| [Rubber Band](https://breakfastquay.com/rubberband/) via [`rubberband-wasm`](https://github.com/daninet/rubberband-wasm) | independent pitch / formant shifting | **GPL** (v2 or later upstream; the npm package metadata says GPLv2). A site that ships it must be distributable under GPL-compatible terms, or use a commercial Rubber Band licence. |
| [@jsr/hdae__sbv2-web](https://jsr.io/@hdae/sbv2-web), [@hdae/yomi](https://jsr.io/@hdae/yomi) | optional local-only Style-BERT-VITS2 panel | MIT (code); the models it needs have their own terms, see README |

The compiled Sudachi binary contains the dictionary; its Apache-2.0 licence text is included next to it in
`models/sudachi/`.
