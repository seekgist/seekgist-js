import type { Problem } from "../generated/types/index.js";

/** Base class of every error the SDK throws. */
export class SeekGistError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API answered with an error status (RFC 9457 problem). Use `code` in your program. */
export class ApiError extends SeekGistError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly problem: Problem | null;
  readonly retryAfterS: number | null;

  constructor(status: number, problem: Problem | null, requestId: string | null, retryAfterS: number | null) {
    const code = problem?.code ?? `http_${status}`;
    const detail = problem?.detail ?? problem?.title ?? "request failed";
    super(`${status} ${code}: ${detail}${requestId ? ` (request ${requestId})` : ""}`);
    this.status = status;
    this.code = code;
    this.requestId = requestId ?? problem?.request_id ?? null;
    this.problem = problem;
    this.retryAfterS = retryAfterS;
  }

  /** Field errors of a 422 answer (empty when there are none). */
  get fieldErrors(): NonNullable<Problem["errors"]> {
    return this.problem?.errors ?? [];
  }
}

/** The request never got an answer (DNS, refused connection, reset). */
export class ConnectionError extends SeekGistError {}

/** One attempt took longer than `timeoutMs`. */
export class TimeoutError extends SeekGistError {}

/** A webhook failed the signature or time check. Answer it with HTTP 400. */
export class WebhookVerificationError extends SeekGistError {}
