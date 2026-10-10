# Pending

Next work, with full context for a fresh session: [TODO.md](TODO.md).

Where the package work stands, so it can be picked up later. Packages: **wakachi** (Sudachi analyzer,
github.com/PikaPikaGems/wakachi), **yomiage** (Tsukuyomi-chan voice, github.com/PikaPikaGems/yomiage), **kakera** (shared
plumbing bundled into both, github.com/PikaPikaGems/kakera), all public. Each has its own PENDING.md; demo sites:
https://pikapikagems.github.io/wakachi/ and https://pikapikagems.github.io/yomiage/. This playground installs both
packages from their v0.1.0 releases.

## Both packages

- [x] Publish the playground site (2026-10-09, built from the v0.1.0 releases).
- [ ] Test on an iPhone: https://pikapikagems.github.io/jp-tts-playground/ once published (or the LAN address of
      the packages' test pages on the same Wi-Fi). Watch for: no sound, a stalled loading bar, the page reloading
      (memory), slow analysis.
- [x] yomiage v0.2.0 (2026-10-09, Safari memory fixes): the playground installs it. First releases, v0.1.0 (pre-releases, 2026-10-09): github.com/PikaPikaGems/wakachi/releases/tag/v0.1.0 and
      github.com/PikaPikaGems/yomiage/releases/tag/v0.1.0. The playground installs both from them (checked: install,
      files downloaded with an empty cache, dev server and deploy build: voice, furigana, no console errors).
- [x] React (2026-10-10, not released yet): `useYomiage()` / `useYomiageEngine()` and `useWakachi(text)` /
      `useWakachiEngine()` (yomiage API.md §11, wakachi API.md §12). Nothing loads unless the app calls `load()`.
      React as an optional peer dependency.
- [x] Debug report (`debugReport()`, in kakera) for bug reports (2026-10-09).
- [x] CI (2026-10-09): Node tests and type checks run on GitHub on every push in all three packages.
- [ ] CI for the browser test pages in WebKit, and yomiage's memory check: parked, see yomiage's PENDING.md.

## wakachi

- [x] Own repo on kakera, `copy-files`, types, test page (2026-10-09).
- [x] Everyday readings: 私 わたし, 明日 あした, 日本 にほん, お母さん, 言う いう, numbers with counters.
- [ ] Your feature ideas for wakachi (not written down yet).
- [ ] More reading fixes and speed: see wakachi's PENDING.md (Sudachi is now ~1 ms per sentence, our own build).

## Clean-up

- [ ] Delete the unused local `models/` folders (css10, mera, tsukuyomi, sudachi; git-ignored). `models/sbv2-*`
      is still used by the local Style-BERT-VITS2 panel.
