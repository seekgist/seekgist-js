import { ApiError, ConnectionError, SeekGistError, TimeoutError } from "./errors.js";
import type { ApiResponse, FileInput, OperationSpec, QueryValue, RequestOptions } from "./spec.js";
import { parseRateLimit, parseUsage, parseRetryAfter } from "./usage.js";
import type { Problem } from "../generated/types/index.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportConfig {
  baseUrl: string;
  apiKey?: string;
  /** Send a public key as `?key=` on GET calls (no CORS preflight in the browser). */
  keyInQuery: boolean;
  timeoutMs: number;
  maxRetries: number;
  headers: Record<string, string>;
  fetch: FetchLike;
  /** Wait before retry number `attempt` (1-based); tests replace it. */
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

/** Statuses worth a retry: timeouts, "still running", rate limits and server errors. */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
/** POST operations that only read, so a retry cannot do anything twice. */
const READ_ONLY_POSTS = new Set(["search_post"]);
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_S = 60;

/** Make a fresh Idempotency-Key (8-255 characters, per docs/api.md). */
export function newIdempotencyKey(prefix = "sg"): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function buildUrl(cfg: TransportConfig, spec: OperationSpec, params: Record<string, unknown>, options?: RequestOptions): string {
  let path = spec.path;
  for (const name of spec.pathParams) {
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw new SeekGistError(`${spec.id}: missing path parameter "${name}"`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const qs = new URLSearchParams();
  for (const name of spec.query) addQuery(qs, name, params[name] as QueryValue);
  for (const [name, value] of Object.entries(options?.query ?? {})) addQuery(qs, name, value);
  if (cfg.keyInQuery && cfg.apiKey?.startsWith("sg_pub_") && spec.method === "GET" && spec.auth) {
    qs.set("key", cfg.apiKey);
  }
  const query = qs.toString();
  return cfg.baseUrl.replace(/\/+$/, "") + path + (query ? `?${query}` : "");
}

function addQuery(qs: URLSearchParams, name: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (value.length) qs.set(name, value.map(String).join(","));
    return;
  }
  qs.set(name, String(value));
}

function toBlob(file: FileInput): { blob: Blob; filename?: string } {
  if (typeof Blob !== "undefined" && file instanceof Blob) {
    return { blob: file, filename: (file as Blob & { name?: string }).name };
  }
  const f = file as Exclude<FileInput, Blob>;
  const part = f.data instanceof Uint8Array ? new Uint8Array(f.data) : f.data;
  return { blob: new Blob([part as BlobPart], { type: f.type ?? "application/octet-stream" }), filename: f.filename };
}

function multipart(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    const isFile = (typeof Blob !== "undefined" && value instanceof Blob) || (typeof value === "object" && "filename" in (value as object));
    if (isFile) {
      const { blob, filename } = toBlob(value as FileInput);
      form.append(name, blob, filename ?? "upload");
    } else {
      form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  return form;
}

export interface BuiltRequest {
  url: string;
  init: RequestInit;
  retryable: boolean;
}

export function buildRequest(cfg: TransportConfig, spec: OperationSpec, params: object | undefined, options?: RequestOptions): BuiltRequest {
  const p = (params ?? {}) as Record<string, unknown>;
  const headers: Record<string, string> = { Accept: spec.result === "json" ? "application/json" : "*/*", ...cfg.headers };
  if (cfg.apiKey && spec.auth && !(cfg.keyInQuery && cfg.apiKey.startsWith("sg_pub_") && spec.method === "GET")) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  for (const name of spec.headers) {
    const v = p[name];
    if (v !== undefined && v !== null) headers[name] = String(v);
  }
  let body: BodyInit | undefined;
  if (spec.body === "json" && p.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(p.body);
  } else if (spec.body === "multipart" && p.body !== undefined) {
    body = multipart(p.body as Record<string, unknown>);
  }
  let idempotent = spec.method === "GET" || READ_ONLY_POSTS.has(spec.id);
  if (spec.idempotent && spec.method !== "GET") {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? newIdempotencyKey();
    idempotent = true;
  }
  Object.assign(headers, options?.headers ?? {});
  return { url: buildUrl(cfg, spec, p, options), init: { method: spec.method, headers, body }, retryable: idempotent };
}

/** Backoff before retry `attempt` (1-based): 0.5 s, 1 s, 2 s ... up to 8 s, with jitter; Retry-After wins. */
export function backoffMs(attempt: number, retryAfterS: number | null, random: () => number): number {
  if (retryAfterS !== null) return Math.min(retryAfterS, MAX_RETRY_AFTER_S) * 1000;
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

async function readBody(spec: OperationSpec, res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  if (spec.result === "text") return res.text();
  if (spec.result === "binary") return res.arrayBuffer();
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SeekGistError(`${spec.id}: the API sent a body that is not JSON (status ${res.status})`, { cause: err });
  }
}

async function readProblem(res: Response): Promise<Problem | null> {
  try {
    const parsed = JSON.parse(await res.text()) as Problem;
    return parsed && typeof parsed === "object" && typeof parsed.code === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function attempt(cfg: TransportConfig, req: BuiltRequest, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await cfg.fetch(req.url, { ...req.init, signal: ctrl.signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timedOut) throw new TimeoutError(`no answer within ${timeoutMs} ms`, { cause: err });
    throw new ConnectionError(`could not reach the SeekGist API: ${(err as Error)?.message ?? err}`, { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Send one operation with timeouts and safe retries. Throws ApiError, TimeoutError or ConnectionError. */
export async function execute<T>(cfg: TransportConfig, spec: OperationSpec, params: object | undefined, options?: RequestOptions): Promise<ApiResponse<T>> {
  const req = buildRequest(cfg, spec, params, options);
  const maxRetries = options?.maxRetries ?? cfg.maxRetries;
  const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs;
  for (let n = 1; ; n++) {
    let res: Response;
    try {
      res = await attempt(cfg, req, timeoutMs, options?.signal);
    } catch (err) {
      const canRetry = req.retryable && (err instanceof ConnectionError || err instanceof TimeoutError);
      if (!canRetry || n > maxRetries) throw err;
      await cfg.sleep(backoffMs(n, null, cfg.random));
      continue;
    }
    const requestId = res.headers.get("x-request-id");
    if (res.ok) {
      return {
        data: (await readBody(spec, res)) as T,
        status: res.status,
        headers: res.headers,
        requestId,
        usage: parseUsage(res.headers.get("x-seekgist-usage")),
        rateLimit: parseRateLimit(res.headers),
        replayed: res.headers.get("idempotent-replayed") === "true",
        attempts: n,
      };
    }
    const problem = await readProblem(res);
    const retryAfterS = parseRetryAfter(res.headers.get("retry-after"));
    const err = new ApiError(res.status, problem, requestId, retryAfterS);
    // 429 means "not done", so any call may try again. Other statuses need a safe call.
    // 409 is only worth a retry while the first call with the same key still runs.
    const retryStatus =
      res.status === 429 ||
      (req.retryable && RETRY_STATUS.has(res.status) && (res.status !== 409 || err.code === "idempotency_in_progress"));
    if (!retryStatus || n > maxRetries) throw err;
    await cfg.sleep(backoffMs(n, retryAfterS, cfg.random));
  }
}
