// AnalyzerError: every failure the package reports has a `code` (see AnalyzerErrorCode in types.ts).

export class AnalyzerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ engine?: string, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "AnalyzerError";
    this.code = code;
    if (options.engine) this.engine = options.engine;
  }
}

/** A plain Error with a code, for code that also runs inside workers (codes survive postMessage as data). */
export const codedError = (code, message) => Object.assign(new Error(message), { code });
