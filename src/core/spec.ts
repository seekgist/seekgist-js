/**
 * Shapes shared by the generated code (src/generated/) and the hand-written client.
 * The generator imports these names; keep them stable.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One API operation, as written by the generator from docs/api/openapi.yaml. */
export interface OperationSpec {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly query: readonly string[];
  readonly headers: readonly string[];
  readonly body: "json" | "multipart" | "none";
  readonly result: "json" | "text" | "binary";
  /** The operation accepts an Idempotency-Key header (safe to retry with the same key). */
  readonly idempotent: boolean;
  /** The operation needs an API key. */
  readonly auth: boolean;
}

/** A file for multipart uploads: a Blob/File, or raw data with a file name. */
export type FileInput =
  | Blob
  | { data: Blob | Uint8Array | ArrayBuffer | string; filename: string; type?: string };

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>;

/** Per-call options. Every generated method takes them as the last argument. */
export interface RequestOptions {
  /** Time limit for one attempt, in milliseconds (default: the client's timeoutMs). */
  timeoutMs?: number;
  /** Retries after the first attempt (default: the client's maxRetries). */
  maxRetries?: number;
  /** Idempotency-Key for writes. The SDK makes one when the operation accepts it and you give none. */
  idempotencyKey?: string;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
  /** Extra query parameters, e.g. `{ "filter[brand]": "Nike" }` on GET /v1/search. */
  query?: Record<string, QueryValue>;
  /** Cancel the call. */
  signal?: AbortSignal;
}

/** Parsed `X-SeekGist-Usage` header (search responses). `limit = -1` means no fixed limit. */
export interface Usage {
  searches: number;
  limit: number;
  /** 1 when this call was billed (a search with page = 1), else 0. */
  billed: number;
  period: string;
}

/** Parsed `RateLimit-*` and `Retry-After` headers. `null` when the header was not sent. */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  retryAfterS: number | null;
}

/** The full answer of one call: body plus the headers that matter. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  requestId: string | null;
  usage: Usage | null;
  rateLimit: RateLimit;
  /** True when the server replayed a stored answer for the same Idempotency-Key. */
  replayed: boolean;
  /** How many attempts the call took (1 = no retry). */
  attempts: number;
}

/** What the generated namespaces call. The client implements it. */
export interface Caller {
  call<T>(spec: OperationSpec, params: object | undefined, options?: RequestOptions): Promise<ApiResponse<T>>;
}
