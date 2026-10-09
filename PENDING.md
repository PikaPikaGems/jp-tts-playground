# Pending

Where the package work stands, so it can be picked up later. Packages: **wakachi** (Sudachi analyzer,
github.com/PikaPikaGems/wakachi), **yomiage** (Tsukuyomi-chan voice, github.com/PikaPikaGems/yomiage), **kakera** (shared
plumbing bundled into both, github.com/PikaPikaGems/kakera), all public. Each has its own PENDING.md; demo sites:
https://pikapikagems.github.io/wakachi/ and https://pikapikagems.github.io/yomiage/. This playground uses both
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
- [ ] More reading fixes and speed: see wakachi's PENDING.md (Sudachi is now ~1 ms per sentence, our own build).

## Clean-up

- [ ] Delete the unused local `models/` folders (css10, mera, tsukuyomi, sudachi; git-ignored). `models/sbv2-*`
      is still used by the local Style-BERT-VITS2 panel.
