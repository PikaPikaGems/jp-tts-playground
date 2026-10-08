// Public types for wakachi. This file is the source of truth for the API; API.md explains it in prose.
// The code in this folder does not match it everywhere yet (see API.md, "Status").

// ------------------------------------------------------------------------------------------------ results

/** Part-of-speech category, simplified from Sudachi's tags (the full tags are in `posDetail`). */
export type PosCategory =
  | "noun" | "pronoun" | "verb" | "adjective"   // adjective = い-adjective
  | "adjectival-noun"                           // な-adjective stem (Sudachi 形状詞, IPADIC 名詞,形容動詞語幹)
  | "adverb" | "adnominal"                      // adnominal = 連体詞 (この, 大きな)
  | "conjunction" | "interjection" | "filler"
  | "particle" | "auxiliary"                    // auxiliary = 助動詞 (です, ます, た)
  | "prefix" | "suffix"
  | "punctuation"                               // 。、「」 etc.
  | "symbol" | "whitespace" | "other";

/**
 * Extra tags, simplified from Sudachi's. The text helpers (bunsetsu grouping) rely on these.
 * A morpheme carries zero or more of them.
 */
export type PosTag =
  | "proper"           // proper noun (東京, 田中)
  | "numeral"          // 五, 5, 十
  | "counter"          // can follow a number (分, 本, 人)
  | "dependent"        // used as a helper after another word (て + いる, 食べ + 始める)
  | "conjunctive"      // conjunctive particle (て, けど, から)
  | "bracket-open"     // 「 ( 『
  | "bracket-close";   // 」 ) 』

export interface Morpheme {
  /** The text exactly as it appears in the input (even where Sudachi rewrites characters, e.g. ":" → "："). */
  surface: string;
  /** Reading in katakana. Empty string when there is none (unknown words, some loanwords, symbols). */
  reading: string;
  /** Dictionary form: 食べ → 食べる. Same as `surface` for words that don't inflect. */
  dictionaryForm: string;
  /** Spelling-normalized form: 附属 → 付属, かっこいい → 格好いい. */
  normalizedForm: string;
  pos: PosCategory;
  tags: PosTag[];
  /** Sudachi's original part-of-speech tags, e.g. ["名詞","普通名詞","一般","*","*","*"]. */
  posDetail: string[];
  /**
   * Position in the input string, as JavaScript string indices (UTF-16 units), so
   * `input.slice(m.start, m.end) === m.surface` always holds.
   */
  start: number;
  end: number;
}

// ------------------------------------------------------------------------------------------------ analyzer

export interface AnalyzerOptions {
  /** Where `wakachi copy-files` put the files. Relative URLs resolve against the page. Default "/wakachi/". */
  filesUrl?: string;
  /** Your own reading fixes, applied after the built-in ones: { "私": "わたくし" }. Readings in hiragana or katakana. */
  readings?: Record<string, string>;
  /** Built-in everyday readings (私→わたし, 明日→あした, 日本→にほん, numbers with counters...). Default true. */
  everydayReadings?: boolean;
  /**
   * Stop Sudachi (freeing its memory) after this many ms without a call. The next call reloads it from the device
   * without downloading anything. 0 = never stop. Default 60_000.
   */
  idleTimeout?: number;
  /**
   * Stop Sudachi while the page is hidden (another tab or app in front). iOS kills memory-heavy background tabs
   * first. The next call after the page is visible again reloads from the device. Default true.
   */
  stopWhenHidden?: boolean;
  /**
   * If loading crashed the tab (iOS kills the page when memory runs out), don't load again for a while: load()
   * rejects with "unavailable" instead, so the user never sees the same crash twice. `false` turns this off.
   * Default { retryAfterDays: 7 }.
   */
  crashGuard?: false | { retryAfterDays: number };
  /**
   * Give up (and stop the worker) when things hang, instead of leaving the UI waiting forever. Both measure time
   * WITHOUT PROGRESS, so a slow download or a long text that is still moving never times out.
   */
  timeouts?: {
    /** load(): ms without download or startup progress. Default 60_000. */
    loadStall?: number;
    /** analyze()/furigana(): ms without finishing the next piece of text (~2,000 characters). Default 20_000. */
    analyzeStall?: number;
  };
  /** Ask the browser to keep the downloaded dictionary (navigator.storage.persist()). Default true. */
  persistStorage?: boolean;
}

export type AnalyzerStatus =
  | "not-loaded"   // load() has not been called (or dispose() was)
  | "downloading"  // fetching dictionary parts (first time, or the browser deleted them)
  | "loading"      // reading from the device and starting Sudachi
  | "ready"
  | "stopped"      // freed (idle, page hidden, or unload()); the next call reloads from the device by itself
  | "unavailable"  // loading crashed this tab recently (crash guard): show the page without analysis
  | "error";       // load() failed

export interface Progress {
  /** Compressed bytes downloaded so far / in total. */
  loaded: number;
  total: number;
}

export interface FilesInfo {
  /** The dictionary is stored on this device: load() won't download anything. */
  cached: boolean;
  /** Size of the download when not cached (compressed). */
  downloadBytes: number;
  /** downloadBytes in MB, rounded, for messages like "Download the dictionary (43 MB)?" */
  downloadMB: number;
}

export interface LoadResult {
  /** true when nothing was downloaded. */
  fromCache: boolean;
}

export interface CallOptions {
  /** Abort this call; its promise rejects with a DOMException named "AbortError". */
  signal?: AbortSignal;
}

export interface Analyzer {
  readonly status: AnalyzerStatus;

  /** Is the dictionary on this device, and how big is the download if not? Reads the small manifest file. */
  info(): Promise<FilesInfo>;

  /**
   * Download (first time) or read from the device, start Sudachi and warm it up. Resolves when calls are fast.
   * Calling it again while loading returns the same promise; calling it when ready resolves immediately.
   * Rejects with AnalyzerError ("unavailable" after a recent crash, "download-failed", ...).
   */
  load(): Promise<LoadResult>;

  /** Furigana for a whole text: joined, the `text` fields are exactly the input. */
  furigana(text: string, options?: CallOptions): Promise<RubySegment[]>;

  /**
   * Words of one text. Long texts are analyzed in pieces internally (Sudachi's memory never shrinks, so one huge
   * call would keep it large); the result is the same. Rejects with AnalyzerError("not-loaded") before load().
   */
  analyze(text: string, options?: CallOptions): Promise<Morpheme[]>;
  /** Several texts in one trip to the worker. Result i belongs to texts[i]. */
  analyzeMany(texts: string[], options?: CallOptions): Promise<Morpheme[][]>;

  /** Delete the dictionary from this device. Does not stop a running Sudachi. */
  clearCache(): Promise<void>;
  /** Forget a recorded crash so the next load() tries again (e.g. behind a "Try again" button). */
  resetCrashGuard(): void;

  /** Free the memory now (if no other analyzer on the page needs it). The next call reloads from the device. */
  unload(): void;
  /** Stop and forget everything; the analyzer goes back to "not-loaded". Pending calls reject. */
  dispose(): void;

  /** Subscribe to changes. Returns an unsubscribe function. */
  on(event: "status", listener: (status: AnalyzerStatus) => void): () => void;
  on(event: "progress", listener: (progress: Progress) => void): () => void;
}

export declare function createAnalyzer(options?: AnalyzerOptions): Analyzer;

// ------------------------------------------------------------------------------------------------ errors

export type AnalyzerErrorCode =
  | "not-loaded"            // a call before load()
  | "disposed"              // the analyzer was disposed while the call was pending
  | "unavailable"           // load(): loading crashed this tab recently (crash guard); see resetCrashGuard()
  | "unsupported-browser"   // no WebAssembly / DecompressionStream / IndexedDB
  | "download-failed"       // network or HTTP error (includes files missing at filesUrl)
  | "checksum-mismatch"     // a downloaded part was corrupt
  | "out-of-memory"         // the browser refused Sudachi's memory (checked before downloading)
  | "timeout"               // load() or a call made no progress for too long; the worker was stopped
  | "engine-failed"         // Sudachi failed in an unexpected way (e.g. its worker file could not load)
  | "worker-crashed";       // the worker died after loading

export declare class AnalyzerError extends Error {
  readonly code: AnalyzerErrorCode;
  constructor(code: AnalyzerErrorCode, message: string, options?: { cause?: unknown });
}

// ------------------------------------------------------------------------------------------------ "wakachi/text"

/** One piece of a word for furigana: `reading` (hiragana) is set on kanji/digit runs only. */
export interface RubySegment {
  text: string;
  reading?: string;
}

export interface Bunsetsu {
  morphemes: Morpheme[];
  /** Leading prefix(es) + the first content word, e.g. [食べ] in 食べ|させ|られ|た. */
  head: Morpheme[];
  /** Dictionary form of the head, e.g. 食べる. */
  headDictionaryForm: string;
  start: number;
  end: number;
}
