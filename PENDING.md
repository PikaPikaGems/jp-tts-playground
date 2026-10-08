# Pending

Where the package work stands, so it can be picked up later. Packages: **wakachi** (Sudachi analyzer, drafted in
`packages/jp-analyzer`), **yomiage** (Tsukuyomi-chan voice, github.com/PikaPikaGems/yomiage), **kakera** (shared
plumbing bundled into both, github.com/PikaPikaGems/kakera). yomiage and kakera are private for now.

## yomiage

- [ ] Publish the playground site: `npm run build:deploy && npm run publish:gh-pages` (main is already pushed).
- [ ] Test on an iPhone: https://pikapikagems.github.io/jp-tts-playground/ once published (or the LAN address of
      `test/voice.html` on the same Wi-Fi). Watch for: no sound, a stalled loading bar, the page reloading (memory).
- [ ] Make the yomiage repo public, then the first GitHub release (v0.1.0) with the voice files.
      `yomiage copy-files` downloads from the release by default, so no other project can use yomiage before this.
- [ ] Playground: install yomiage from the release instead of `file:../yomiage`, so a fresh clone runs.
- [ ] React: `useVoice` hook.

## wakachi

- [ ] Own repo, built on kakera like yomiage (worker file next to the parts, `copy-files`, zero dependencies for apps).
- [ ] Everyday readings: 私→わたし rather than わたくし, 明日→あした rather than あす. Readings are wakachi's job;
      yomiage keeps piper's own phonemizer.
- [ ] Your other feature ideas for wakachi (not written down yet).
- [ ] React: hook and `<Furigana>`.

## Both

- [ ] CI for the browser tests (kakera, yomiage; today they run only by hand).

## Clean-up

- [ ] Delete the unused local `models/css10`, `models/mera` and `models/tsukuyomi` folders (git-ignored).
