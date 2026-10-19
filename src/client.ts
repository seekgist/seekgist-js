/**
 * The SeekGist client: the generated namespaces (client.search, client.catalog, ...) plus
 * hand-written helpers (find, suggester, upsertProducts, waitForJob, pages).
 */
import { SeekGistError } from "./core/errors.js";
import { execute, type FetchLike, type TransportConfig } from "./core/transport.js";
import type { ApiResponse, OperationSpec, RequestOptions } from "./core/spec.js";
import {
  GeneratedClient,
  OPERATIONS,
  type OperationId,
  type OperationParams,
  type OperationResults,
} from "./generated/api/index.js";
import type { Job, ProductIn, SearchRequest, SearchResponse } from "./generated/types/index.js";
import { Suggester, type SuggesterOptions } from "./helpers/suggest.js";
import { upsertProducts, type UpsertOptions, type UpsertSummary } from "./helpers/upsert.js";

export const SDK_VERSION = "1.0.0";
export const DEFAULT_BASE_URL = "https://api.seekgist.com";

export interface ClientOptions {
  /** `sg_pub_...` (browser, search only) or `sg_sec_...` (your server only). */
  apiKey?: string;
  /** Default https://api.seekgist.com. Dev: http://localhost:58000. */
  baseUrl?: string;
  /** Time limit per attempt in ms (default 10,000). Store search pages: use 300 and fall back. */
  timeoutMs?: number;
  /** Retries for safe calls (default 2). */
  maxRetries?: number;
  /** Headers sent on every call. */
  headers?: Record<string, string>;
  /** Send a PUBLIC key as `?key=` on GET calls (saves the CORS preflight in browsers). */
  keyInQuery?: boolean;
  /** Your own fetch (default globalThis.fetch). */
  fetch?: FetchLike;
  /** Allow a secret key in a browser. Only for trusted tools (never a public web page). */
  dangerouslyAllowSecretKeyInBrowser?: boolean;
}

/** Options of `find()`: the SearchRequest fields except `q`, plus per-call options. */
export type FindOptions = Omit<SearchRequest, "q"> & { request?: RequestOptions };

export interface WaitForJobOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DONE = new Set(["succeeded", "failed", "canceled"]);

function inBrowser(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== "undefined";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SeekGist extends GeneratedClient {
  private readonly cfg: TransportConfig;

  constructor(options: ClientOptions = {}) {
    super();
    const apiKey = options.apiKey ?? readEnv("SEEKGIST_API_KEY");
    if (apiKey && !/^sg_(pub|sec)_[A-Za-z0-9]{20,}$/.test(apiKey)) {
      throw new SeekGistError("apiKey must look like sg_pub_... or sg_sec_...");
    }
    if (apiKey?.startsWith("sg_sec_") && inBrowser() && !options.dangerouslyAllowSecretKeyInBrowser) {
      throw new SeekGistError("A secret key (sg_sec_) must not be used in a browser. Use a public key (sg_pub_).");
    }
    if (options.keyInQuery && apiKey?.startsWith("sg_sec_")) {
      throw new SeekGistError("keyInQuery works only with a public key: the API refuses secret keys in URLs.");
    }
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new SeekGistError("No fetch() found. Use Node 20+ or pass `fetch` in the options.");
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (!inBrowser()) headers["User-Agent"] ??= `seekgist-js/${SDK_VERSION}`;
    this.cfg = {
      baseUrl: options.baseUrl ?? readEnv("SEEKGIST_BASE_URL") ?? DEFAULT_BASE_URL,
      apiKey,
      keyInQuery: options.keyInQuery ?? false,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 2,
      headers,
      fetch: (input, init) => f(input, init),
      sleep,
      random: Math.random,
    };
  }

  /** Used by the generated namespaces. Returns the body plus usage, rate limit and request id. */
  call<T>(spec: OperationSpec, params: object | undefined, options?: RequestOptions): Promise<ApiResponse<T>> {
    return execute<T>(this.cfg, spec, params, options);
  }

  /**
   * Any operation by its OpenAPI operationId, with the full response (headers included):
   * `const r = await client.request("search_post", { body: { q: "dress" } }); r.usage`.
   */
  request<K extends OperationId>(
    id: K,
    ...args: OperationParams[K] extends undefined ? [params?: undefined, options?: RequestOptions] : [params: OperationParams[K], options?: RequestOptions]
  ): Promise<ApiResponse<OperationResults[K]>> {
    const [params, options] = args;
    return this.call<OperationResults[K]>(OPERATIONS[id], params as object | undefined, options);
  }

  /**
   * Search products (POST /v1/search). `query` is the shopper's text, or a full SearchRequest.
   * The answer has `usage` (X-SeekGist-Usage): searches used this period and your limit.
   */
  find(query: string | SearchRequest, options: FindOptions = {}): Promise<ApiResponse<SearchResponse>> {
    const { request, ...rest } = options;
    const body: SearchRequest = typeof query === "string" ? { ...rest, q: query } : { ...query, ...rest };
    return this.request("search_post", { body }, request);
  }

  /** A debounced suggest helper for a search box (see Suggester). */
  suggester(options: SuggesterOptions = {}): Suggester {
    return new Suggester((params, opts) => this.search.suggest(params, opts), options);
  }

  /** Upsert (and delete) products in batches with idempotency keys and retries. Needs catalog:write. */
  upsertProducts(products: readonly ProductIn[], options: UpsertOptions = {}): Promise<UpsertSummary> {
    return upsertProducts((body, opts) => this.request("products_batch", { body }, opts), products, options);
  }

  /** Poll GET /v1/jobs/{id} until the job is succeeded, failed or canceled. */
  async waitForJob(jobId: string, options: WaitForJobOptions = {}): Promise<Job> {
    const interval = options.intervalMs ?? 1000;
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const job = await this.jobs.get({ job_id: jobId }, { signal: options.signal });
      if (DONE.has(job.status)) return job;
      if (Date.now() + interval > deadline) throw new SeekGistError(`job ${jobId} is still ${job.status} after the time limit`);
      await this.cfg.sleep(interval);
    }
  }

  /**
   * Walk every page of a cursor list: `for await (const s of client.pages((cursor) =>
   * client.synonyms.list({ cursor }))) { ... }`.
   */
  async *pages<T>(fetchPage: (cursor: string | undefined) => Promise<{ data: T[]; next_cursor?: string | null }>): AsyncGenerator<T> {
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor);
      yield* page.data;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}
