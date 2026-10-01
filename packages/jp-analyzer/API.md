# jp-analyzer: API (draft)

Japanese text analysis in the browser (readings, dictionary forms, parts of speech) that works on iPhone Safari.
The work happens in a Web Worker. The dictionary is downloaded once and kept in IndexedDB.

`jp-analyzer` is a placeholder name. The exact types are in [src/types.ts](src/types.ts). What exists today and
what is still design only: see [Status](#status).

| Import | What it gives you |
|---|---|
| `jp-analyzer` | `createAnalyzer`, `AnalyzerError`, types |
| `jp-analyzer/sudachi` | `sudachi({ dictUrl })`: Sudachi + SudachiDict. Best quality, ~43 MB download, ~150 MB memory |
| `jp-analyzer/ipadic` | `ipadic({ dictUrl })`: lindera + IPADIC. ~17 MB download, ~130 MB memory |
| `jp-analyzer/text` | Furigana, bunsetsu, sentence splitting. Pure functions: no worker, no dictionary |

A React wrapper (`jp-analyzer-react`) will be a separate package later.

### Choosing an engine

| | `sudachi` | `ipadic` |
|---|---|---|
| Download (first visit) | ~43 MB | ~17 MB |
| Memory while loaded | ~150 MB | ~130 MB |
| Readings, word splitting | Better | Good (older dictionary, from 2007) |
| `normalizedForm` | Yes | No |
| Underlying code | 2020 build, frozen | Maintained (lindera) |

The two use **about the same memory**, so `ipadic` is a choice for a **smaller download**, not a way to avoid
crashes. If an engine crashes a device, the answer is to show the page without analysis (see §7).

---

## 1. Setup: put the dictionary files in your site

```bash
npx jp-analyzer copy-dict sudachi public/dict
npx jp-analyzer copy-dict ipadic  public/dict      # only if you use it
```

This writes `public/dict/sudachi/`: a `manifest.json`, the program (`sudachi-code.wasm`, 1.1 MB) and the dictionary
as gzip parts (`dict.part001.gz`...). Each part is at most 20 MB *before* compression (~4–10 MB as files), so they
fit Cloudflare Pages (25 MiB per file) and GitHub Pages. Use `--part-size <MB>` if your host is stricter.

Add `public/dict/` to `.gitignore` and run the command before each build (e.g. in a `prebuild` script). The source
files are downloaded once and cached on your machine (`~/.cache/jp-analyzer`).

## 2. Create an analyzer

```js
import { createAnalyzer } from "jp-analyzer";
import { sudachi } from "jp-analyzer/sudachi";

const analyzer = createAnalyzer({
  engines: [sudachi({ dictUrl: "/dict/sudachi/manifest.json" })],
});
```

Creating an analyzer **does nothing**: no download, no worker, no memory used.

Options (all optional except `engines`):

| Option | Default | What it does |
|---|---|---|
| `engines` | required | Engines to try, in order (see §6) |
| `idleTimeout` | `60_000` | Free the memory after this many ms unused. `0` = never |
| `stopWhenHidden` | `true` | Free the memory while the page is in the background (iOS kills heavy background tabs first) |
| `crashGuard` | `{ retryAfterDays: 7 }` | Never load an engine again right after it crashed the tab (§7). `false` = off |
| `timeouts` | `{ loadStall: 60_000, analyzeStall: 20_000 }` | Give up instead of hanging (§7) |
| `persistStorage` | `true` | Ask the browser to keep the cached dictionary |

After an idle or background stop, the next `analyze()` reloads from the cache (about 0.5–2 s, no download). The
host doesn't have to do anything.

### Engines are shared across the page

Each engine uses a lot of memory, so **each dictionary is loaded at most once per page**, however many analyzers use
it. Two components creating their own analyzers with the same Sudachi `dictUrl` share one Sudachi. Analyzers are
cheap handles, so create them wherever it's convenient.

## 3. Load, when the host decides

Nothing is downloaded or loaded until `load()`. Calling `analyze()` first throws `AnalyzerError("not-loaded")`.

```js
if (!(await analyzer.isCached())) {
  const mb = Math.round((await analyzer.downloadSize()) / 1e6);
  if (!confirm(`Download the Japanese dictionary (${mb} MB)?`)) return;
}

const off = analyzer.on("progress", ({ loaded, total }) => showBar(loaded / total));
try {
  const result = await analyzer.load();
  result.engine;     // "sudachi" or "ipadic"
  result.fromCache;  // true = nothing was downloaded
} catch (err) {
  if (err.code === "unavailable") showPlainText();   // see §7
  else showError(err.message);
} finally {
  off();
}
```

- `load()` also warms the engine up, so when it finishes, the first `analyze()` is already fast.
- Calling `load()` while it's already loading returns the same promise. Calling it when ready resolves at once.
- `isCached()` and `downloadSize()` refer to the engine `load()` will try first. Pass `"ipadic"` etc. to ask about
  a specific one.

### Status

```js
analyzer.on("status", (s) => render(s));   // returns an unsubscribe function
analyzer.status;                           // current value
```

`not-loaded` → `downloading` (only when not cached) → `loading` → `ready` ⇄ `stopped`.
`unavailable` = crash guard (§7). `error` = every engine failed.

Use `analyzer.on(...)` rather than a callback option: several parts of an app can listen at the same time.

## 4. Analyze

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

Many texts in one trip to the worker (e.g. one per sentence or per line):

```js
const perLine = await analyzer.analyzeMany(text.split("\n"));   // perLine[i] belongs to line i
```

Guarantees:
- **Nothing is dropped or changed.** Joining every `surface` gives back the exact input, including spaces and line
  breaks (these come back as `pos: "whitespace"`). `input.slice(m.start, m.end) === m.surface`. Sudachi rewrites
  some characters internally (e.g. `:` → `：`); `surface` is always the original text.
- `start`/`end` are ordinary JavaScript string positions.
- `reading` is katakana, or `""` when the engine has none (unknown words, some loanwords like スマホ, symbols).
- `normalizedForm` exists only with Sudachi. Use `m.normalizedForm ?? m.dictionaryForm` to handle both engines.
- **Long text is fine.** The engine's memory never shrinks: one 50,000-character call would grow Sudachi from 150 MB
  to 234 MB for good (200,000 characters: 534 MB). The analyzer therefore sends long text to the engine in pieces of
  ≤ 2,000 characters, cut at sentence ends, and joins the results. Memory stays at ~150 MB.
- **URLs, emoji and long latin runs are fine.** The 2020 Sudachi build crashes on one unknown "word" of 256 bytes or
  more: a ~250-character URL, 64 emoji in a row, `wwww…`. The analyzer cuts such runs into shorter pieces first, and
  if Sudachi still fails on a piece, it splits that piece and retries. One odd stretch never loses the whole text.

### The same fields from every engine

`pos` and `tags` are the engine-neutral fields. The text helpers use only these, so they give the same kind of
result whichever engine loaded. `posDetail` holds the engine's original tags, which **differ between engines**
(Sudachi uses UniDic tags, IPADIC uses its own). Only use `posDetail` if you need that detail and know which
engine you have (`analyzer.engine`).

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

### Cancelling

```js
let ctrl;
textbox.oninput = async () => {
  ctrl?.abort();                        // cancel MY previous call only
  ctrl = new AbortController();
  try {
    render(await analyzer.analyze(textbox.value, { signal: ctrl.signal }));
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
};
```

The analyzer does **not** cancel older calls by itself. Engines are shared, so one component's call must never
cancel another's. The React hook will do the above for you.

## 5. Freeing memory and cache

```js
analyzer.stop();                  // free the memory now; the next analyze() reloads from cache
analyzer.dispose();               // back to "not-loaded": pending calls reject, load() needed again
await analyzer.clearCache();      // delete the stored dictionaries from this device
```

A shared engine is freed only when **no** analyzer using it still needs it (all stopped, disposed or idle).

## 6. Choosing engines, fallback and comparing

The engine list is the choice:

```js
engines: [sudachi(...)]                // Sudachi only
engines: [ipadic(...)]                 // lindera/IPADIC only
engines: [sudachi(...), ipadic(...)]   // Sudachi; lindera if Sudachi fails to load
```

`load()` tries them in order and uses the first that works. It moves to the next one on errors it can see:
download failed, storage full, the browser refused the memory (`out-of-memory`), `timeout`.

### Comparing engines side by side

Use one analyzer per engine:

```js
const s = createAnalyzer({ engines: [sudachi({ dictUrl: "/dict/sudachi/manifest.json" })] });
const l = createAnalyzer({ engines: [ipadic({ dictUrl: "/dict/ipadic/manifest.json" })] });

await Promise.all([s.load(), l.load()]);
const [a, b] = await Promise.all([s.analyze(text), l.analyze(text)]);
```

Both loaded at once is about 280 MB: fine on desktop, risky on older phones. On phones, keep one loaded at a time:

```js
s.stop();         // free Sudachi
await l.load();   // then load lindera (from cache: no download)
```

## 7. When things go wrong: failing gracefully

The goal: **the page never freezes, the user never sees the same crash twice, and the host always gets a clear
error to show.**

### The page doesn't freeze
All loading and analysis runs in a Web Worker, so scrolling and buttons keep working. The one real freeze risk is
on the host's side: inserting thousands of furigana elements at once. Render long results in batches (the React
hook will).

### Crashes: never twice
When iOS runs out of memory it kills the tab and reloads the page. No error is thrown, and no code gets to react.
So before starting an engine, the analyzer writes a note in `localStorage`, and removes it once the engine is
ready. If the page comes back and the note is still there, that engine crashed the tab:

- `load()` skips it for `retryAfterDays` (default 7), and `result.skipped` says `"crashed-before"`.
- If no engine is left, `load()` rejects with **`unavailable`** and the status becomes `unavailable`. Show the page
  without analysis, e.g. plain text or "Furigana isn't available on this device".

```js
createAnalyzer({ engines: [...], crashGuard: { retryAfterDays: 7 } });   // or crashGuard: false
analyzer.resetCrashGuard();   // e.g. behind a "Try again" button
```

### Out of memory, checked before downloading
Before downloading, the worker reserves the memory the engine needs. If the browser refuses, `load()` fails at once
with `out-of-memory`, and no 43 MB download is wasted. This catches only the refusals the browser reports; an iOS
kill is handled by the crash guard above.

### Timeouts
Both measure time **without progress**, so slow-but-working never times out:
- `timeouts.loadStall` (default 60 s): `load()` gives up when nothing happens for that long (no download progress,
  no startup progress). A slow connection that is still downloading doesn't time out.
- `timeouts.analyzeStall` (default 20 s): a call gives up when the engine doesn't finish the next piece of text
  (~2,000 characters, normally well under a second) for that long. A very long text on a slow phone is fine.

Either way the worker is stopped (freeing its memory) and the promise rejects with `timeout`. The next call starts
fresh.

### Errors

Everything rejects with `AnalyzerError`, which has a `code`:

| `code` | When |
|---|---|
| `not-loaded` | `analyze()` before `load()` |
| `disposed` | the analyzer was disposed while the call was pending |
| `unavailable` | `load()`: every engine crashed this tab before (crash guard) |
| `all-engines-failed` | `load()`: `error.cause` is the list of each engine's error |
| `unsupported-browser` | missing WebAssembly, DecompressionStream (Safari 16.4+) or IndexedDB |
| `download-failed` | network/HTTP error, including a wrong `dictUrl` |
| `checksum-mismatch` | a downloaded part was corrupt |
| `out-of-memory` | the browser refused the memory (checked before downloading) |
| `timeout` | `load()` or `analyze()` made no progress for too long |
| `engine-failed` | the engine failed unexpectedly (e.g. its worker file could not be loaded) |
| `worker-crashed` | the worker died after loading |

## 8. Text helpers: `jp-analyzer/text`

Pure functions that take `Morpheme`s from any engine.

```js
import { furigana, groupBunsetsu, splitSentences, toHiragana, posLabel } from "jp-analyzer/text";

furigana(m);             // 食べ (タベ) → [{ text: "食", reading: "た" }, { text: "べ" }]
groupBunsetsu(words);    // → [{ morphemes, head, headDictionaryForm, start, end }, ...]
splitSentences(text);    // keeps 「行こう！」と彼は言った。 as one sentence
toHiragana("ネコ");       // "ねこ"
posLabel(m, "en");       // "Verb, general" ("ja" → "動詞・一般")
```

`groupBunsetsu` is approximate (part-of-speech rules). Compound nouns and some verb chains occasionally split
or merge oddly.

## 9. Memory on iPhone Safari

- Sudachi uses about **150 MB** while loaded; lindera/IPADIC about **130 MB**. While loading, add about one
  dictionary part (≤ 20 MB).
- iOS has no fixed per-tab limit. Reported crash points are around 1.5 GB (iPhone 12 Pro) to 3 GB (iPhone 15 Pro)
  for the **whole page**, lower on older phones and when other apps use memory.
- So the risk is everything on the page together. Don't load the dictionary at the same moment as other big things
  (e.g. a TTS voice model); load one, then the other.
- Every tab of your site loads its own copy.
- The cached dictionary takes ~43 MB of storage (compressed parts). Safari may delete it after 7 days without a
  visit (not for Home Screen apps) or when the phone is low on space; `load()` then downloads it again.

## 10. Bundlers

The worker is created with `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, which
Vite, webpack 5, esbuild and Parcel handle automatically. No setup needed.

---

## Status

**Built and tested** (plain JavaScript for now; to be converted to TypeScript when the package gets a build step):
`createAnalyzer` with everything in §2–§7, the Sudachi engine, and `copy-dict sudachi`.

| File | What it does |
|---|---|
| [src/index.js](src/index.js) | `createAnalyzer`: shared engines, crash guard, timeouts, idle/hidden stop, fallback |
| [src/engines/sudachi.js](src/engines/sudachi.js) | `sudachi({ dictUrl })` |
| [src/engines/sudachi-worker.js](src/engines/sudachi-worker.js) | Sudachi worker: program first, then the dictionary written into its memory |
| [src/engines/sudachi-analyze.js](src/engines/sudachi-analyze.js) | Sudachi output → `Morpheme`s; protection against its crashes and rewritten characters |
| [src/engines/sudachi-pos.js](src/engines/sudachi-pos.js) | Sudachi tags → engine-neutral `pos` and `tags` |
| [src/split-input.js](src/split-input.js) | Splits long input into ≤ 2,000-character pieces at sentence ends |
| [src/dict-store.js](src/dict-store.js) | Download, checksum, IndexedDB cache of compressed parts, streaming into engine memory |
| [bin/jp-analyzer.mjs](bin/jp-analyzer.mjs), [bin/split-wasm.mjs](bin/split-wasm.mjs) | `copy-dict sudachi <dir>`: program + gzip parts + manifest |

Tests:

| File | What it checks |
|---|---|
| [test/analyze.test.mjs](test/analyze.test.mjs) | Node: input splitting, offsets, pos/tags, URL/emoji crash protection, rewritten characters, flat memory on long text |
| [test/verify-split.mjs](test/verify-split.mjs) | Node: the split Sudachi gives output identical to the original |
| [test/analyzer.html](test/analyzer.html) | Browser: the whole `createAnalyzer` API, incl. shared engines, timeouts, idle/hidden stop, fallback, crash guard |
| [test/memory.html](test/memory.html) | Browser/iPhone: compares the old and new loading methods, with Web Inspector steps |

Results so far: all tests pass in Chrome; first load 0.7 s, from cache 0.5 s. **Still to do:** run on a real iPhone.

To try it (from the repository root):

```bash
node packages/jp-analyzer/bin/jp-analyzer.mjs copy-dict sudachi packages/jp-analyzer/test/dict --source models/sudachi/sudachi.wasm
node --test packages/jp-analyzer/test/analyze.test.mjs
python3 serve.py 8080     # then open /packages/jp-analyzer/test/analyzer.html and /packages/jp-analyzer/test/memory.html
```

**Not built yet:** the text helpers (§8, today in `src/furigana.js` of the playground), the `ipadic` engine, the React
wrapper, and switching the playground over to the package.
