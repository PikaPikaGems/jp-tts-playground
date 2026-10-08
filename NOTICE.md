# Third-party components and credits

This project's own code is licensed under AGPL-3.0-or-later (see [LICENSE](LICENSE)). The components below keep their own
licences and terms.

This project bundles or loads the following third-party software and data. Each keeps its own licence; the summaries
below are provided for convenience and are **not legal advice** - check the linked sources before reusing anything.

## Voice model (loaded by the "piper-plus" panel, through yomiage)

| Model | Source | Licence / terms |
|---|---|---|
| つくよみちゃん (Tsukuyomi-chan) | [ayousanz/piper-plus-tsukuyomi-chan](https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan) | Follows the [つくよみちゃんコーパス terms](https://tyc.rei-yumesaki.net/material/corpus/): free use incl. commercial, **credit required** (below), some prohibited uses (e.g. attacking people, promoting specific political/religious positions). |

**Required credit for the つくよみちゃん voice:**

> 音声合成には、フリー素材キャラクター「つくよみちゃん」（© Rei Yumesaki）が無料公開している音声データを使用しています。
> ■つくよみちゃんコーパス（CV.夢前黎）https://tyc.rei-yumesaki.net/material/corpus/

## Software

| Component | Use | Licence |
|---|---|---|
| [yomiage](https://github.com/PikaPikaGems/yomiage) | runs piper-plus with the Tsukuyomi-chan voice, voice presets | MIT (same author) |
| [piper-plus](https://github.com/ayutaz/piper-plus) (`piper-plus`, `@piper-plus/g2p`), bundled in yomiage | text-to-speech engine, phonemizer | MIT; the licences of its bundled parts (Open JTalk, MeCab, NAIST-jdic, ONNX Runtime) are in `yomiage/THIRD-PARTY-LICENSES.md` on the site |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | runs the voice models in the browser | MIT |
| [Sudachi](https://github.com/WorksApplications/sudachi.rs) + SudachiDict, WASM build from [hata6502/sudachi-wasm](https://github.com/hata6502/sudachi-wasm) (npm `sudachi@0.1.5`) | Japanese morphological analysis: readings, dictionary forms, part of speech | Apache-2.0. SudachiDict incorporates UniDic (BSD-3-Clause) and NEologd data - see the [upstream notices](https://github.com/hata6502/sudachi-wasm#disclaimer). |
| [@jsr/hdae__sbv2-web](https://jsr.io/@hdae/sbv2-web), [@hdae/yomi](https://jsr.io/@hdae/yomi) | optional local-only Style-BERT-VITS2 panel | MIT (code); the models it needs have their own terms, see README |

The compiled Sudachi binary contains the dictionary; its Apache-2.0 licence text is included next to it in
`models/sudachi/`.
