/**
 * Suggestions while the shopper types: debounce, drop answers that are out of date, and a
 * small cache. Suggest calls are never billed, so this is about speed, not cost.
 */
import type { RequestOptions } from "../core/spec.js";
import type { SuggestResponse } from "../generated/types/index.js";

export interface SuggesterOptions {
  /** Wait this long after the last key press before calling the API (default 120 ms). */
  debounceMs?: number;
  /** Shorter text (after trim) gives `null` without a call (default 1). */
  minChars?: number;
  /** `auto` or a store locale. */
  lang?: string;
  limit?: number;
  /** How many product previews to include. */
  products?: number;
  session?: string;
  /** Time limit per call (default 1,500 ms). */
  timeoutMs?: number;
  /** How many recent answers to keep (default 50; 0 = no cache). */
  cacheSize?: number;
  /** Called with every answer that is still current. */
  onResult?: (result: SuggestResponse, text: string) => void;
  /** Called when a current call fails (stale failures are ignored). */
  onError?: (error: unknown, text: string) => void;
}

export type SuggestFn = (
  params: { q: string; lang?: string; limit?: number; products?: number; session?: string },
  options?: RequestOptions,
) => Promise<SuggestResponse>;

export class Suggester {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: AbortController | null = null;
  private pending: ((value: SuggestResponse | null) => void) | null = null;
  private seq = 0;
  private readonly cache = new Map<string, SuggestResponse>();
  private readonly opts: Required<Pick<SuggesterOptions, "debounceMs" | "minChars" | "timeoutMs" | "cacheSize">> & SuggesterOptions;

  constructor(
    private readonly suggest: SuggestFn,
    options: SuggesterOptions = {},
  ) {
    this.opts = { debounceMs: 120, minChars: 1, timeoutMs: 1500, cacheSize: 50, ...options };
  }

  /**
   * Call on every key press. Resolves with the answer for this text, or `null` when the text
   * is too short or a newer `input()` came first. Rejects only when this (current) call fails.
   */
  input(text: string): Promise<SuggestResponse | null> {
    const id = ++this.seq;
    this.clearTimer();
    this.inflight?.abort();
    this.inflight = null;
    const q = text.trim();
    if (q.length < this.opts.minChars) return Promise.resolve(null);
    const cached = this.cache.get(this.cacheKey(q));
    if (cached) {
      this.opts.onResult?.(cached, q);
      return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
      this.pending = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pending = null;
        this.fetch(id, q).then(resolve, reject);
      }, this.opts.debounceMs);
    });
  }

  /** Stop the waiting call and drop any answer still on its way. */
  cancel(): void {
    this.seq++;
    this.clearTimer();
    this.inflight?.abort();
    this.inflight = null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending?.(null);
    this.pending = null;
  }

  private cacheKey(q: string): string {
    return `${this.opts.lang ?? ""}\u0000${q.toLowerCase()}`;
  }

  private async fetch(id: number, q: string): Promise<SuggestResponse | null> {
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const { lang, limit, products, session } = this.opts;
    try {
      const res = await this.suggest(
        { q, lang, limit, products, session },
        { signal: ctrl.signal, timeoutMs: this.opts.timeoutMs, maxRetries: 0 },
      );
      if (id !== this.seq) return null;
      this.remember(q, res);
      this.opts.onResult?.(res, q);
      return res;
    } catch (err) {
      if (id !== this.seq || ctrl.signal.aborted) return null;
      this.opts.onError?.(err, q);
      throw err;
    } finally {
      if (this.inflight === ctrl) this.inflight = null;
    }
  }

  private remember(q: string, res: SuggestResponse): void {
    if (this.opts.cacheSize <= 0) return;
    this.cache.set(this.cacheKey(q), res);
    while (this.cache.size > this.opts.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
