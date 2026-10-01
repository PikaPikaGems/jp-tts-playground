// Sudachi (UniDic-style) part-of-speech tags → the engine-neutral `pos` and `tags` (see PosCategory/PosTag in
// types.ts).

const CATEGORY = {
  "名詞": "noun", "代名詞": "pronoun", "動詞": "verb", "形容詞": "adjective", "形状詞": "adjectival-noun",
  "副詞": "adverb", "連体詞": "adnominal", "接続詞": "conjunction", "感動詞": "interjection",
  "助詞": "particle", "助動詞": "auxiliary", "接頭辞": "prefix", "接尾辞": "suffix",
  "補助記号": "punctuation", "記号": "symbol", "空白": "whitespace",
};

/** @param {string[]} p  Sudachi's six part-of-speech fields */
export function sudachiPos(p) {
  const [p0, p1, p2] = p;
  let pos = CATEGORY[p0] ?? "other";
  if (p0 === "感動詞" && p1 === "フィラー") pos = "filler";
  if (p0 === "補助記号" && (p1 === "ＡＡ" || p1 === "一般")) pos = "symbol";

  const tags = [];
  if (p1 === "固有名詞") tags.push("proper");
  if (p1 === "数詞") tags.push("numeral");
  if (p2 === "助数詞可能" || p2 === "助数詞") tags.push("counter");
  if (p1 === "非自立可能") tags.push("dependent");
  if (p0 === "助詞" && p1 === "接続助詞") tags.push("conjunctive");
  if (p1 === "括弧開") tags.push("bracket-open");
  if (p1 === "括弧閉") tags.push("bracket-close");
  return { pos, tags };
}
