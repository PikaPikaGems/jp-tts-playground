// Pure helpers (no DOM, no wasm): morphemes -> bunsetsu groups, and furigana alignment.
// Morpheme shape: { surface, reading (katakana or ""), dict (dictionary form), norm, pos: string[6] }

const KANJI = /[㐀-鿿豈-﫿々〆ヵヶ]/;
const DIGIT = /[0-9０-９]/;
const isRubyChar = (c) => KANJI.test(c) || DIGIT.test(c);

export const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/**
 * Split a surface form into [{t, r?}] where `r` (hiragana) is furigana for the kanji/digit run `t`.
 * Okurigana (kana attached to kanji) is left un-annotated: 食べ + タベ -> [{t:"食",r:"た"},{t:"べ"}].
 * Falls back to one ruby over the whole surface when kana runs can't be aligned with the reading.
 */
export function rubySegments(surface, readingKata) {
  if (!readingKata || ![...surface].some(isRubyChar)) return [{ t: surface }];
  const hira = kataToHira(readingKata);

  // Alternating runs of "kanji/digits" (K) and "everything else" (O).
  const runs = [];
  for (const ch of surface) {
    const k = isRubyChar(ch);
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.t += ch;
    else runs.push({ k, t: ch });
  }

  const out = [];
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.k) {
      const h = kataToHira(run.t);
      if (!hira.startsWith(h, pos)) return whole(surface, hira);
      out.push({ t: run.t });
      pos += h.length;
    } else {
      const next = runs[i + 1]; // an O run, or undefined
      let end;
      if (!next) end = hira.length;
      else {
        end = hira.indexOf(kataToHira(next.t), pos + 1);
        if (end < 0) return whole(surface, hira);
      }
      if (end <= pos) return whole(surface, hira);
      out.push({ t: run.t, r: hira.slice(pos, end) });
      pos = end;
    }
  }
  return pos === hira.length ? out : whole(surface, hira);
}
const whole = (surface, hira) => [{ t: surface, r: hira }];

const DEPENDENT = new Set(["助詞", "助動詞", "接尾辞"]);
const PUNCT = new Set(["補助記号", "記号"]);
const NON_HEAD = new Set(["助詞", "助動詞", "接尾辞", "補助記号", "記号", "接頭辞"]);

/**
 * Group morphemes into bunsetsu with part-of-speech heuristics (Sudachi itself does not segment bunsetsu):
 * a bunsetsu = one independent word (noun, verb, adjective, adverb, ...) + the particles, auxiliaries and suffixes
 * that follow it. Approximate: compound nouns and some verb chains will occasionally split or merge oddly.
 * @returns {{morphs: object[], head: object[], headDict: string}[]}
 */
export function groupBunsetsu(morphs) {
  const groups = [];
  let cur = null;
  let forceAttach = false;
  const startGroup = (m) => { cur = { morphs: [m] }; groups.push(cur); };

  for (const m of morphs) {
    if (!m.surface.trim()) { cur = null; forceAttach = false; continue; } // whitespace = boundary
    const [p0, p1, p2] = m.pos;
    const prev = cur?.morphs[cur.morphs.length - 1];

    if (p0 === "補助記号" && p1 === "括弧開") { startGroup(m); forceAttach = true; continue; }
    if (PUNCT.has(p0)) { cur ? cur.morphs.push(m) : startGroup(m); forceAttach = false; continue; }
    if (p0 === "接頭辞") { startGroup(m); forceAttach = true; continue; }
    if (forceAttach && cur) { cur.morphs.push(m); forceAttach = false; continue; }
    forceAttach = false;
    if (DEPENDENT.has(p0)) { cur ? cur.morphs.push(m) : startGroup(m); continue; }

    if (cur && prev) {
      const [q0, q1] = prev.pos;
      // "...て + いる", "食べ + 始める": a dependent verb/adjective continues a predicate chain
      const dependentPredicate = p1 === "非自立可能" && (p0 === "動詞" || p0 === "形容詞") &&
        (q0 === "動詞" || q0 === "助動詞" || q0 === "形容詞" || (q0 === "助詞" && q1 === "接続助詞"));
      // "5 + 分", "十 + 五"
      const counter = (p0 === "名詞" && (p1 === "数詞" || p2 === "助数詞可能")) && q0 === "名詞" && q1 === "数詞";
      // "日本 + 語", "東京 + 都": a lone kanji noun right after a proper noun is a suffix-like element
      const nameSuffix = p0 === "名詞" && [...m.surface].length === 1 && KANJI.test(m.surface) && q0 === "名詞" && q1 === "固有名詞";
      if (dependentPredicate || counter || nameSuffix) { cur.morphs.push(m); continue; }
    }
    startGroup(m);
  }

  for (const g of groups) {
    // head = leading prefix(es) + first content word; fall back to the first morpheme
    const i = g.morphs.findIndex((m) => !NON_HEAD.has(m.pos[0]));
    g.head = i < 0 ? [g.morphs[0]] : g.morphs.slice(0, i + 1);
    g.headDict = g.head.map((m) => m.dict || m.surface).join("");
  }
  return groups;
}

/** "動詞・一般" style label for the popover. */
export const posLabel = (pos) => [pos[0], pos[1]].filter((x) => x && x !== "*").join("・");

// English glosses for Sudachi/UniDic part-of-speech tags (major and minor classes).
const POS_EN = {
  // major
  "名詞": "Noun", "代名詞": "Pronoun", "動詞": "Verb", "形容詞": "Adjective (い-adj)", "形状詞": "Adjectival noun (な-adj stem)",
  "副詞": "Adverb", "連体詞": "Pre-noun adjectival", "接続詞": "Conjunction", "感動詞": "Interjection",
  "助詞": "Particle", "助動詞": "Auxiliary verb", "接頭辞": "Prefix", "接尾辞": "Suffix",
  "補助記号": "Punctuation / symbol", "記号": "Symbol", "空白": "Whitespace", "フィラー": "Filler (um, uh)", "その他": "Other",
  // minor
  "普通名詞": "common noun", "固有名詞": "proper noun", "数詞": "numeral", "一般": "general",
  "副詞可能": "can act as adverb", "助数詞可能": "can act as counter", "サ変可能": "suru-verb capable",
  "サ変形状詞可能": "suru-verb / na-adj capable", "形状詞可能": "na-adjective capable",
  "非自立可能": "can be non-independent (auxiliary use)", "タリ": "tari-type", "助動詞語幹": "auxiliary stem",
  "係助詞": "binding particle (は, も)", "格助詞": "case particle (が, を, に)", "接続助詞": "conjunctive particle (て, けど)",
  "終助詞": "sentence-final particle (ね, よ)", "副助詞": "adverbial particle (だけ, まで)", "準体助詞": "nominalizing particle (の, ん)",
  "間投助詞": "interjectory particle", "並立助詞": "parallel particle (と, や)",
  "句点": "period", "読点": "comma", "括弧開": "opening bracket", "括弧閉": "closing bracket", "ＡＡ": "ASCII art", "顔文字": "emoticon",
  "地名": "place name", "人名": "person name", "国": "country", "名": "given name", "姓": "family name", "組織名": "organization",
  "敬語": "honorific", "文字": "character", "普通名詞-一般": "common noun",
};
/** "Verb, general" - English gloss for the same tag pair shown by posLabel (falls back to the Japanese tag). */
export const posLabelEn = (pos) => {
  const parts = [pos[0], pos[1]].filter((x) => x && x !== "*").map((t) => POS_EN[t] ?? t);
  return parts.join(", ");
};

/** CSS class suffix for colouring a head word by part of speech (null = no colour). */
export const posColorKey = (pos0) => ({
  "名詞": "noun", "代名詞": "pronoun", "動詞": "verb", "形容詞": "adj", "形状詞": "adjnoun",
  "副詞": "adverb", "連体詞": "adnominal", "接続詞": "conj", "感動詞": "interj",
}[pos0] ?? null);

/**
 * Split text into sentences for study mode: breaks after 。！？!? … (and ASCII "." when followed by whitespace or the
 * end, so "3.14" is safe) plus any closing quotes/brackets, and at every newline. Enders inside 「」『』（）() [] do not
 * split, so 「行こう！」と彼は言った。 stays one sentence.
 */
export function splitStudySentences(text) {
  const out = [];
  let buf = "";
  let depth = 0;
  const flush = () => { const t = buf.trim(); if (t && /[\p{L}\p{N}]/u.test(t)) out.push(t); buf = ""; depth = 0; };
  const chars = [...text];
  const ENDERS = "。！？!?…";
  const OPEN = "「『（(［[【";
  const CLOSE = "」』）)］]】";
  const QUOTES = "\"”’'";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\n") { flush(); continue; }
    buf += c;
    if (OPEN.includes(c)) { depth++; continue; }
    if (CLOSE.includes(c)) { depth = Math.max(0, depth - 1); continue; }
    const next = chars[i + 1];
    const ender = ENDERS.includes(c) || (c === "." && (next === undefined || /\s/.test(next)));
    if (!ender || depth > 0) continue;
    while (i + 1 < chars.length && (ENDERS.includes(chars[i + 1]) || CLOSE.includes(chars[i + 1]) || QUOTES.includes(chars[i + 1]) || chars[i + 1] === ".")) buf += chars[++i];
    flush();
  }
  flush();
  return out;
}
