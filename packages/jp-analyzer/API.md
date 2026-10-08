# wakachi: API (draft)

Japanese text analysis in the browser — readings, furigana, dictionary forms, parts of speech — that works on iPhone
Safari. It runs [Sudachi](https://github.com/WorksApplications/sudachi.rs) in a Web Worker; the dictionary is
downloaded once (in parts, so any static host works) and kept on the device.

*wakachi* comes from 分かち書き (*wakachi-gaki*): writing Japanese with spaces between the words.

This page describes the API we are building towards. The code still lives in `packages/jp-analyzer` of
jp-tts-playground and does not match it everywhere yet: see [Status](#status). Exact types: [src/types.ts](src/types.ts).

| Import | What it gives you |
|---|---|
| `wakachi` | `createAnalyzer`, `AnalyzerError`, types |
| `wakachi/text` | Furigana, bunsetsu, sentence splitting: pure functions, no worker, no dictionary |
| `wakachi-react` (later) | `<WakachiProvider>`, `useAnalysis(text)`, `<Furigana text>` |

The quickest possible use:

```js
import { createAnalyzer } from "wakachi";

const analyzer = createAnalyzer();
await analyzer.load();
const ruby = await analyzer.furigana("今日は晴れ");
// → [{ text: "今日", reading: "きょう" }, { text: "は" }, { text: "晴", reading: "は" }, { text: "れ" }]
```

---

## 1. Setup (once per project)

```bash
npm install <wakachi release URL>
```

Add the dictionary files to the project with one command, and run it automatically before the dev server and builds:

```json
"scripts": {
  "predev": "wakachi copy-files public/wakachi",
  "prebuild": "wakachi copy-files public/wakachi"
}
```

- The files (~43 MB) are downloaded once from the wakachi release and cached on your computer; after that the
  command only copies them.
- They are split into parts of at most 20 MB, so they work on GitHub Pages and Cloudflare Pages (25 MiB per file).
  `--part-size <MB>` for stricter hosts.
- Add `public/wakachi/` to `.gitignore`.
- Vite, Next.js and Create React App serve `public/` at the site root, so the files end up at `/wakachi/`: the
  default the analyzer looks in. Nothing to configure.

## 2. Create an analyzer

```js
const analyzer = createAnalyzer();
```

Creating it **does nothing**: no download, no worker, no memory. Options, all optional:

| Option | Default | What it does |
|---|---|---|
| `filesUrl` | `"/wakachi/"` | Where `copy-files` put the files, if not the default |
| `readings` | `{}` | Your own reading fixes, e.g. `{ "私": "わたくし" }` (§6) |
| `everydayReadings` | `true` | Built-in everyday readings: 私→わたし, 明日→あした, 日本→にほん (§6) |
| `idleTimeout` | `60_000` | Free the memory after this many ms unused. `0` = never |
| `stopWhenHidden` | `true` | Free the memory while the page is in the background (iOS kills heavy background tabs first) |
| `crashGuard` | `{ retryAfterDays: 7 }` | Don't load again right after a load crashed the tab (§8). `false` = off |
| `timeouts` | `{ loadStall: 60_000, analyzeStall: 20_000 }` | Give up instead of hanging (§8) |
| `persistStorage` | `true` | Ask the browser to keep the downloaded dictionary |

After an idle or background stop, the next call reloads from the device (about 0.5–2 s, no download). Nothing to do.

**One Sudachi per page.** It uses ~150 MB, so every analyzer on the page shares the same one. Create analyzers
wherever convenient (e.g. one per component); it's loaded once.

## 3. Load, when you decide

Nothing is downloaded or loaded until `load()`. Calling `analyze()` first throws `AnalyzerError("not-loaded")`.

```js
const { cached, downloadMB } = await analyzer.info();
if (!cached && !confirm(`Download the Japanese dictionary (${downloadMB} MB)?`)) return;

const off = analyzer.on("progress", ({ loaded, total }) => showBar(loaded / total));
try {
  const { fromCache } = await analyzer.load();    // fromCache: nothing was downloaded
} catch (err) {
  if (err.code === "unavailable") showPlainText(); // it crashed this device before: see §8
  else showError(err.message);
} finally {
  off();
}
```

- `load()` also warms Sudachi up, so the first `analyze()` afterwards is fast.
- Calling `load()` while it's loading returns the same promise; when ready it resolves at once.

### Status

```js
analyzer.on("status", (s) => render(s));   // returns an unsubscribe function
analyzer.status;                           // current value
```

`not-loaded` → `downloading` (only when not on the device yet) → `loading` → `ready` ⇄ `stopped` (memory freed;
reloads by itself). `unavailable`: crash guard (§8). `error`: loading failed.

## 4. Furigana

```js
const ruby = await analyzer.furigana("食べた後で");
// → [{ text: "食", reading: "た" }, { text: "べた" }, { text: "後", reading: "あと" }, { text: "で" }]
```

- Readings (hiragana) sit on the kanji and numbers only; kana next to them (okurigana) is left alone.
- Joining every `text` gives back the exact input.
- Uses the everyday readings (§6).

For richer displays (word spacing, colours by part of speech, dictionary forms on tap), use `analyze()` and the
helpers in `wakachi/text` (§9) instead.

## 5. Analyze

```js
const words = await analyzer.analyze("猫が好き。");
```

```js
[
  { surface: "猫", reading: "ネコ", dictionaryForm: "猫", normalizedForm: "猫",
    pos: "noun", tags: [], posDetail: ["名詞","普通名詞","一般","*","*","*"], start: 0, end: 1 },
  { surface: "が", reading: "ガ", dictionaryForm: "が", normalizedForm: "が",
    pos: "particle", tags: [], posDetail: ["助詞","格助詞","*","*","*","*"], start: 1, end: 2 },
  { surface: "好き", reading: "スキ", dictionaryForm: "好き", normalizedForm: "好き",
    pos: "adjectival-noun", tags: [], posDetail: ["形状詞","一般","*","*","*","*"], start: 2, end: 4 },
  { surface: "。", reading: "", dictionaryForm: "。", normalizedForm: "。",
    pos: "punctuation", tags: [], posDetail: ["補助記号","句点","*","*","*","*"], start: 4, end: 5 },
]
```

Many texts in one trip to the worker (e.g. one per line):

```js
const perLine = await analyzer.analyzeMany(text.split("\n"));   // perLine[i] belongs to line i
```

Guarantees:
- **Nothing is dropped or changed.** Joining every `surface` gives back the exact input, spaces and line breaks
  included (`pos: "whitespace"`). `input.slice(m.start, m.end) === m.surface`. Sudachi rewrites some characters
  internally (`:` → `：`); `surface` is always your original text.
- `start`/`end` are ordinary JavaScript string positions.
- `reading` is katakana, or `""` when there is none (unknown words, some loanwords like スマホ, symbols).
- **Long text is fine.** Sudachi's memory never shrinks — one 50,000-character call would grow it from 150 MB to
  234 MB for good — so long text is analyzed in pieces of ≤ 2,000 characters, cut at sentence ends. Memory stays at
  ~150 MB.
- **URLs, emoji and long latin runs are fine.** This Sudachi build crashes on one unknown "word" of 256+ bytes (a
  ~250-character URL, 64 emoji in a row, `wwww…`). Such runs are cut first, and a piece that still fails is split
  and retried. One odd stretch never loses the whole text.

| `pos` | Meaning |
|---|---|
| `noun`, `pronoun`, `verb` | |
| `adjective` | い-adjective |
| `adjectival-noun` | な-adjective stem (好き, 静か) |
| `adverb`, `conjunction`, `interjection`, `filler` | |
| `adnominal` | 連体詞 (この, 大きな) |
| `particle` | は, が, を, ね |
| `auxiliary` | 助動詞 (です, ます, た) |
| `prefix`, `suffix` | お-, -さん |
| `punctuation` | 。、「」 |
| `symbol`, `whitespace`, `other` | |

| `tags` | Meaning |
|---|---|
| `proper` | proper noun (東京, 田中) |
| `numeral` | 五, 5 |
| `counter` | can follow a number (分, 本, 人) |
| `dependent` | helper use after another word (て**いる**, 食べ**始める**) |
| `conjunctive` | conjunctive particle (て, けど) |
| `bracket-open`, `bracket-close` | 「 」 ( ) |

`posDetail` is Sudachi's own UniDic-style tag list, for anyone who needs more detail than `pos` and `tags`.

### Cancelling

```js
let ctrl;
textbox.oninput = async () => {
  ctrl?.abort();                        // cancel MY previous call only
  ctrl = new AbortController();
  try {
    render(await analyzer.furigana(textbox.value, { signal: ctrl.signal }));
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
};
```

Older calls are **not** cancelled automatically: Sudachi is shared, so one component's call must never cancel
another's. The React hook does the above for you.

## 6. Readings

Sudachi's dictionary prefers formal readings for some very common words. wakachi corrects the most noticeable ones
(`everydayReadings`, on by default), measured against a 10,000-word frequency list:

| Word | Sudachi | wakachi |
|---|---|---|
| 私 | わたくし | わたし |
| 明日 | あす | あした |
| 日本, 日本語, 日本人 | にっぽん… | にほん, にほんご, にほんじん |
| お母さん, お父さん, お兄ちゃん… | おははさん, おちちさん… | おかあさん, おとうさん, おにいちゃん… |
| と言う | とゆう | という |
| 10月, 30分, 4日, 一回 | いちれいがつ, さんれいふん, よんか, いちかい | じゅうがつ, さんじゅっぷん, よっか, いっかい |

Add or change your own:

```js
createAnalyzer({ readings: { "私": "わたくし", "大分": "おおいた" } });
```

## 7. Freeing memory and storage

```js
analyzer.unload();                // free the memory now; the next call reloads from the device
analyzer.dispose();               // back to "not-loaded": pending calls reject, load() needed again
await analyzer.clearCache();      // delete the dictionary from this device
```

Sudachi is freed only when no analyzer on the page still needs it.

## 8. When things go wrong

The aim: **the page never freezes, the user never sees the same crash twice, and you always get a clear error.**

- **No freezing.** Everything heavy runs in a Web Worker. The one freeze risk is on your side: inserting thousands of
  furigana elements at once. Render long results in batches (the React hook does).
- **Never the same crash twice.** When iOS runs out of memory it kills the tab and reloads it; no code gets to react.
  So wakachi leaves a note before loading and removes it once loaded. If the page comes back with the note still
  there, the load crashed the tab: for the next `retryAfterDays` (default 7), `load()` rejects with `unavailable`
  at once (status `unavailable`) instead of crashing again. Show the page without furigana.
  `analyzer.resetCrashGuard()` (e.g. behind a "Try again" button) clears it.
- **Out of memory, checked before downloading.** Sudachi's memory is reserved before the dictionary is downloaded. If
  the browser refuses, `load()` fails at once with `out-of-memory`, without a wasted 43 MB download.
- **Timeouts measure time without progress**, so slow-but-working never times out. `loadStall` (60 s): no download or
  startup progress. `analyzeStall` (20 s): no piece of text (~2,000 characters, normally well under a second)
  finished. Either way the worker is stopped and the call rejects with `timeout`; the next call starts fresh.

Every failure is an `AnalyzerError` with a `code`:

| `code` | When |
|---|---|
| `not-loaded` | `analyze()` / `furigana()` before `load()` |
| `disposed` | the analyzer was disposed while the call was pending |
| `unavailable` | `load()`: loading crashed this tab recently (crash guard) |
| `unsupported-browser` | missing WebAssembly, DecompressionStream (Safari 16.4+) or IndexedDB |
| `download-failed` | network/HTTP error, including files not found at `filesUrl` |
| `checksum-mismatch` | a downloaded part was corrupt |
| `out-of-memory` | the browser refused the memory (checked before downloading) |
| `timeout` | `load()` or a call made no progress for too long |
| `engine-failed` | Sudachi failed unexpectedly (e.g. its worker file could not be loaded) |
| `worker-crashed` | the worker died after loading |

## 9. Text helpers: `wakachi/text`

Pure functions on the results of `analyze()`:

```js
import { furigana, groupBunsetsu, splitSentences, toHiragana, posLabel } from "wakachi/text";

furigana(word);          // 食べ (タベ) → [{ text: "食", reading: "た" }, { text: "べ" }]
groupBunsetsu(words);    // → [{ morphemes, head, headDictionaryForm, start, end }, ...]
splitSentences(text);    // keeps 「行こう！」と彼は言った。 as one sentence
toHiragana("ネコ");       // "ねこ"
posLabel(word, "en");    // "Verb, general" ("ja" → "動詞・一般")
```

`groupBunsetsu` is approximate (part-of-speech rules): compound nouns and some verb chains occasionally split or
merge oddly.

## 10. Memory on iPhone Safari

- Sudachi uses about **150 MB** while loaded, plus about one dictionary part (≤ 20 MB) while loading.
- iOS has no fixed per-tab limit. Reported crash points are around 1.5 GB (iPhone 12 Pro) to 3 GB (iPhone 15 Pro) for
  the **whole page**, lower on older phones and when other apps use memory.
- The risk is everything on the page together. With a voice (e.g. yomiage) on the same page, load one, then the
  other, not both at the same moment.
- Every tab of your site loads its own copy.
- The dictionary takes ~43 MB of storage. Safari may delete it after 7 days without a visit (not for Home Screen
  apps) or when the phone is low on space; `load()` then downloads it again (`info()` tells you beforehand).

## 11. Bundlers

The worker is created with `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, which Vite,
webpack 5, esbuild and Parcel handle automatically. No setup needed.

---

## Status

The code is plain JavaScript in `packages/jp-analyzer` (TypeScript and a build step come with the move to its own
repository). The shared plumbing — download in parts, cache, worker host, crash guard — will move into **kakera**,
which is bundled into wakachi at build time (app developers never install it).

**Built and tested:** loading in parts with the memory fix, the worker, input splitting, the URL/emoji protection,
original surfaces, crash guard, timeouts, idle/hidden stop, cancelling, error codes.

**Where the code still differs from this page:**

| This page | Code today |
|---|---|
| `createAnalyzer()`, `filesUrl` (default `/wakachi/`) | `createAnalyzer({ engines: [sudachi({ dictUrl })] })`, with engine fallback |
| `wakachi copy-files <dir>` (downloads from the release) | `jp-analyzer copy-dict sudachi <dir> [--source]` (builds from the npm Sudachi) |
| `info()`, `furigana()` | `isCached()` + `downloadSize()`; no `furigana()` yet |
| `load()` resolves `{ fromCache }` | resolves `{ engine, fromCache, skipped }` |
| `readings`, `everydayReadings` (§6) | not built |
| `wakachi/text` (§9) | still in the playground's `src/furigana.js` |
| `all-engines-failed` removed | still there for the engine list |
| `unload()` frees the memory (same name as in yomiage, where `stop()` stops sound) | `stop()` |

| Test | What it checks |
|---|---|
| [test/analyze.test.mjs](test/analyze.test.mjs) | Node: input splitting, offsets, pos/tags, URL/emoji protection, rewritten characters, flat memory |
| [test/verify-split.mjs](test/verify-split.mjs) | Node: the split Sudachi gives output identical to the original |
| [test/analyzer.html](test/analyzer.html) | Browser: shared Sudachi, timeouts, idle/hidden stop, crash guard (incl. a simulated crash) |
| [test/memory.html](test/memory.html) | Browser/iPhone: old vs new loading, with Web Inspector steps |

All pass in Chrome; first load 0.7 s, from the device 0.5 s. **Not yet tested on a real iPhone.**

```bash
node packages/jp-analyzer/bin/jp-analyzer.mjs copy-dict sudachi packages/jp-analyzer/test/dict --source models/sudachi/sudachi.wasm
node --test packages/jp-analyzer/test/analyze.test.mjs
python3 serve.py 8080     # then open /packages/jp-analyzer/test/analyzer.html
```
