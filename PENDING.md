# Pending

Where the package work stands, so it can be picked up later. Packages: **wakachi** (Sudachi analyzer,
github.com/PikaPikaGems/wakachi, private), **yomiage** (Tsukuyomi-chan voice, github.com/PikaPikaGems/yomiage, public),
**kakera** (shared plumbing bundled into both, github.com/PikaPikaGems/kakera, public). This playground uses both
packages from the folders next to it (`file:../yomiage`, `file:../wakachi`).

## Both packages

- [ ] Publish the playground site: `npm run build:deploy && npm run publish:gh-pages` (main is pushed; the reading
      view now runs on wakachi).
- [ ] Test on an iPhone: https://pikapikagems.github.io/jp-tts-playground/ once published (or the LAN address of
      the packages' test pages on the same Wi-Fi). Watch for: no sound, a stalled loading bar, the page reloading
      (memory), slow analysis.
- [ ] First GitHub releases (v0.1.0) with the files: `copy-files` downloads from the release by default, so no other
      project can use a package before this. wakachi's repo is private, so it needs to be public first.
- [ ] Playground: install both from their releases instead of `file:../`, so a fresh clone runs.
- [ ] React: `yomiage/react` (`useVoice`) and `wakachi/react` (`useAnalysis`, `<Furigana>`), React as an optional peer
      dependency.
- [ ] CI for the tests (Node tests and the browser test pages; today they run only by hand).

## wakachi

- [x] Own repo on kakera, `copy-files`, types, test page (2026-10-09).
- [x] Everyday readings: 私 わたし, 明日 あした, 日本 にほん, お母さん, 言う いう, numbers with counters.
- [ ] Your feature ideas for wakachi (not written down yet).
- [ ] More reading fixes: 428 of the top 7,142 kanji words still differ from jp-word-ranks-data, mostly single kanji
      out of context (年, 月, 方) where Sudachi's choice is fine in a sentence. Worth a look: 今日は (こんにちは),
      良い (いい), 研究所 (けんきゅうじょ).
- [ ] Each Sudachi call costs ~100 ms in this build (fixed cost); `analyzeMany` batches texts to hide it. A newer
      Sudachi build could remove it.

## Clean-up

- [ ] Delete the unused local `models/` folders (css10, mera, tsukuyomi, sudachi; git-ignored). `models/sbv2-*`
      is still used by the local Style-BERT-VITS2 panel.
