// Turns Sudachi's raw output into Morpheme objects, safely. Kept apart from the worker so it can be tested in Node.
//
// The 2020 Sudachi build panics (a wasm trap) when one unknown word reaches 256 bytes of UTF-8: ~250 latin letters
// (long URLs), 86 full-width letters, 64 emoji or rare kanji. Two layers keep that from losing a whole text:
//   1. Long runs of non-Japanese characters get extra cut points every RUN_CUT characters (well under 256 bytes).
//   2. If a piece still traps, it is split in half and retried, down to single tiny pieces.
// Sudachi keeps working after a trap, but leaks that call's memory, so (1) is what normally prevents it.
import { splitInput } from "../split-input.js";
import { sudachiPos } from "./sudachi-pos.js";

const MODE_C = 2; // the 2020 build only returns results in mode C
const RUN_CUT = 50; // characters (code points); 50 × 4 bytes = 200 bytes < 256

// Characters Sudachi handles in any run length: kana, CJK ideographs (BMP), digits, Japanese punctuation, spaces.
const SAFE = /[　-ヿ㐀-䶿一-鿿豈-﫿０-９｡-ﾟ0-9\s]/u;

/** Cut points inside long runs of "unsafe" characters, as [text, text, ...] pieces. */
export function cutLongRuns(text) {
  const out = [];
  let buf = "", run = 0;
  for (const ch of text) {
    run = SAFE.test(ch) ? 0 : run + 1;
    if (run > RUN_CUT) { out.push(buf); buf = ""; run = 1; }
    buf += ch;
  }
  out.push(buf);
  return out.filter((s) => s.length > 0);
}

/**
 * @param {(text: string, mode: number) => string} tokenize  the wasm-bindgen export
 * @returns {(text: string, alive?: () => void) => object[]}  analyzeText
 */
export function makeAnalyzeText(tokenize) {
  let traps = 0;

  /** Raw Sudachi morphemes for `text`, never throwing on a Sudachi trap. */
  function raw(text) {
    try {
      return JSON.parse(tokenize(text, MODE_C));
    } catch (err) {
      if (!(err instanceof WebAssembly.RuntimeError)) throw err;
      traps++;
      const cps = Array.from(text);
      if (cps.length <= 8) {
        return [{ surface: text, poses: ["その他", "*", "*", "*", "*", "*"], dictionary_form: "", reading_form: text, normalized_form: text }];
      }
      const half = cps.length >> 1;
      return [...raw(cps.slice(0, half).join("")), ...raw(cps.slice(half).join(""))];
    }
  }

  /**
   * Raw morphemes whose `surface` is the original text. Sudachi rewrites some characters in its output (e.g. ":" comes
   * back as "："). Usually one character becomes one character, so surfaces are mapped back by position. When the
   * counts differ (a character expanded or merged), the text is halved until they match.
   */
  function aligned(text) {
    const ms = raw(text);
    const src = Array.from(text);
    const lens = ms.map((m) => Array.from(m.surface).length);
    if (lens.reduce((a, b) => a + b, 0) === src.length) {
      let i = 0;
      return ms.map((m, k) => ({ ...m, surface: src.slice(i, (i += lens[k])).join("") }));
    }
    if (src.length <= 1) {
      const [first] = ms;
      return [{ ...first, surface: text, dictionary_form: ms.map((m) => m.dictionary_form).join(""), reading_form: text, normalized_form: ms.map((m) => m.normalized_form).join("") }];
    }
    const half = src.length >> 1;
    return [...aligned(src.slice(0, half).join("")), ...aligned(src.slice(half).join(""))];
  }

  function analyzeText(text, alive = () => {}) {
    const out = [];
    for (const piece of splitInput(text)) {
      let cursor = piece.offset;
      for (const part of cutLongRuns(piece.text)) {
        for (const m of aligned(part)) {
          const start = cursor;
          cursor += m.surface.length;
          out.push({
            surface: m.surface,
            // The npm build swaps two JSON fields: `dictionary_form` holds the katakana reading and
            // `reading_form` holds the dictionary form.
            reading: m.dictionary_form,
            dictionaryForm: m.reading_form,
            normalizedForm: m.normalized_form,
            ...sudachiPos(m.poses),
            posDetail: m.poses,
            start,
            end: cursor,
          });
        }
      }
      alive();
    }
    return out;
  }

  analyzeText.traps = () => traps;
  return analyzeText;
}
