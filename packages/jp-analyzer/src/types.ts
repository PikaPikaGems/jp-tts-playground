// Public types for jp-analyzer. This file is the source of truth for the API; API.md explains it in prose.
// Implemented in src/index.js (plain JavaScript for now). Not built yet: the text helpers and the ipadic engine.

// ------------------------------------------------------------------------------------------------ results

/** Part-of-speech category shared by every engine. Engines translate their own tag sets into these. */
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
 * Extra engine-neutral tags. The text helpers (bunsetsu grouping) rely on these instead of engine-specific tags.
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
  /** The text exactly as it appears in the input (even where the engine rewrites characters, e.g. ":" → "："). */
  surface: string;
  /** Reading in katakana. Empty string when the engine has none (unknown words, some loanwords, symbols). */
  reading: string;
  /** Dictionary form: 食べ → 食べる. Same as `surface` for words that don't inflect. */
  dictionaryForm: string;
  /** Spelling-normalized form: 附属 → 付属, かっこいい → 格好いい. Only engines that support it (Sudachi). */
  normalizedForm?: string;
  pos: PosCategory;
  tags: PosTag[];
  /** The engine's original part-of-speech tags, e.g. ["名詞","普通名詞","一般","*","*","*"]. */
  posDetail: string[];
  /**
   * Position in the input string, as JavaScript string indices (UTF-16 units), so
   * `input.slice(m.start, m.end) === m.surface` always holds.
   */
  start: number;
  end: number;
}

// ------------------------------------------------------------------------------------------------ engines

/** "sudachi" = Sudachi + SudachiDict. "ipadic" = lindera + IPADIC (named after the dictionary, not the library). */
export type EngineName = "sudachi" | "ipadic";

/** Created by `sudachi({...})` from "jp-analyzer/sudachi" or `ipadic({...})` from "jp-analyzer/ipadic". */
export interface EngineConfig {
  readonly name: EngineName;
  /** URL of the manifest.json written by `npx jp-analyzer copy-dict`. */
  readonly dictUrl: string;
}

export interface EngineOptions {
  /** URL of the manifest.json written by `npx jp-analyzer copy-dict`. Relative URLs resolve against the page. */
  dictUrl: string;
}

// ------------------------------------------------------------------------------------------------ analyzer

export interface AnalyzerOptions {
  /**
   * Engines to try, in order. The first one that loads is used; later ones are fallbacks.
   * Engines are shared page-wide: each dictionary is loaded at most once, however many analyzers list it.
   */
  engines: EngineConfig[];
  /**
   * Stop the engine (freeing all its memory) after this many ms without a call. The next analyze() reloads it
   * from the cache without downloading anything. 0 = never stop. Default 60_000.
   */
  idleTimeout?: number;
  /**
   * Stop the engine while the page is hidden (another tab or app in front). iOS kills memory-heavy background tabs
   * first. The next analyze() after the page is visible again reloads from the cache. Default true.
   */
  stopWhenHidden?: boolean;
  /**
   * Remember an engine that crashed the tab (iOS kills the page when memory runs out) and don't load it again for a
   * while, so the user never sees a second crash. When no engine is left, load() rejects with "unavailable".
   * `false` turns this off. Default { retryAfterDays: 7 }.
   */
  crashGuard?: false | { retryAfterDays: number };
  /**
   * Give up (and stop the worker) when things hang, instead of leaving the UI waiting forever. Both measure time
   * WITHOUT PROGRESS, so a slow download or a long text that is still moving never times out.
   */
  timeouts?: {
    /** load(): ms without download or startup progress. Default 60_000. */
    loadStall?: number;
    /** analyze()/analyzeMany(): ms without finishing the next piece of text (~2,000 characters). Default 20_000. */
    analyzeStall?: number;
  };
  /** Ask the browser to keep the cached dictionary (navigator.storage.persist()) after a download. Default true. */
  persistStorage?: boolean;
}

export type AnalyzerStatus =
  | "not-loaded"   // load() has not been called (or dispose() was)
  | "downloading"  // fetching dictionary parts (first time, or the cache was deleted)
  | "loading"      // reading from cache and starting the engine
  | "ready"
  | "stopped"      // freed (idle, page hidden, or stop()); the next analyze() reloads from cache automatically
  | "unavailable"  // every engine crashed this tab before (crash guard): show the page without analysis
  | "error";       // load() failed for every engine

export interface Progress {
  engine: EngineName;
  /** Compressed bytes downloaded so far / in total. */
  loaded: number;
  total: number;
}

export interface LoadResult {
  /** The engine that is now in use. */
  engine: EngineName;
  /** true when nothing was downloaded. */
  fromCache: boolean;
  /** Engines that were tried before `engine` and why they were skipped or failed. Empty when the first one worked. */
  skipped: { engine: EngineName; reason: "crashed-before" | AnalyzerErrorCode; message: string }[];
}

export interface AnalyzeOptions {
  /** Abort this call; its promise rejects with a DOMException named "AbortError". */
  signal?: AbortSignal;
}

export interface Analyzer {
  readonly status: AnalyzerStatus;
  /** The engine in use, or null before load() succeeds. */
  readonly engine: EngineName | null;

  /**
   * Download (first time) or read from cache, start the engine and warm it up. Resolves when analyze() is fast.
   * Calling it again while loading returns the same promise; calling it when ready resolves immediately.
   * Rejects with AnalyzerError: "unavailable" (crash guard), or "all-engines-failed" (see `cause`).
   */
  load(): Promise<LoadResult>;

  /**
   * Analyze one text. Long texts are analyzed in pieces internally (the engine's memory never shrinks, so one huge
   * call would keep it large); the result is the same as one call. Rejects with AnalyzerError("not-loaded") if
   * load() was never called.
   */
  analyze(text: string, options?: AnalyzeOptions): Promise<Morpheme[]>;
  /** Analyze several texts in one trip to the worker. Result i belongs to texts[i]. */
  analyzeMany(texts: string[], options?: AnalyzeOptions): Promise<Morpheme[][]>;

  /** Is the dictionary of `engine` stored on this device? Default: the engine load() would try first. */
  isCached(engine?: EngineName): Promise<boolean>;
  /** Download size in bytes (compressed) of `engine`'s dictionary. Same default as isCached(). */
  downloadSize(engine?: EngineName): Promise<number>;
  /** Delete stored dictionaries (one engine, or all). Does not stop a running engine. */
  clearCache(engine?: EngineName): Promise<void>;
  /** Forget crash-guard records so the next load() tries every engine again. */
  resetCrashGuard(): void;

  /** Free the memory now. The next analyze() reloads from cache (status goes "stopped" → "loading" → "ready"). */
  stop(): void;
  /** Stop and forget everything; the analyzer goes back to "not-loaded". Pending calls reject. */
  dispose(): void;

  /** Subscribe to changes. Returns an unsubscribe function. */
  on(event: "status", listener: (status: AnalyzerStatus) => void): () => void;
  on(event: "progress", listener: (progress: Progress) => void): () => void;
}

// ------------------------------------------------------------------------------------------------ errors

export type AnalyzerErrorCode =
  | "not-loaded"            // analyze() before load()
  | "disposed"              // the analyzer was disposed while the call was pending
  | "unavailable"           // load(): every engine crashed this tab before (crash guard); see resetCrashGuard()
  | "all-engines-failed"    // load(): see `cause` (an array of the individual errors)
  | "unsupported-browser"   // no WebAssembly / DecompressionStream / IndexedDB
  | "download-failed"       // network or HTTP error (includes a missing manifest: check dictUrl)
  | "checksum-mismatch"     // a downloaded part was corrupt
  | "out-of-memory"         // the browser refused the engine's memory (checked before downloading)
  | "timeout"               // load() or analyze() made no progress for too long; the worker was stopped
  | "engine-failed"         // the engine failed in an unexpected way (e.g. its worker file could not load)
  | "worker-crashed";       // the worker died after loading

export declare class AnalyzerError extends Error {
  readonly code: AnalyzerErrorCode;
  readonly engine?: EngineName;
  constructor(code: AnalyzerErrorCode, message: string, options?: { engine?: EngineName; cause?: unknown });
}

// ------------------------------------------------------------------------------------------------ "jp-analyzer/text"

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
