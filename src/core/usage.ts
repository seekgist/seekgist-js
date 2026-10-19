import type { RateLimit, Usage } from "./spec.js";

/**
 * Parse `X-SeekGist-Usage: searches=1234, limit=150000, billed=1, period="2026-10"`
 * (an RFC 8941 dictionary). Returns null when the header is missing or has no `searches`.
 */
export function parseUsage(header: string | null | undefined): Usage | null {
  if (!header) return null;
  const values: Record<string, string> = {};
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    values[key] = value;
  }
  const searches = toInt(values.searches);
  if (searches === null) return null;
  return {
    searches,
    limit: toInt(values.limit) ?? -1,
    billed: toInt(values.billed) ?? 0,
    period: values.period ?? "",
  };
}

/** Parse `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `Retry-After`. */
export function parseRateLimit(headers: Headers): RateLimit {
  return {
    limit: toInt(headers.get("ratelimit-limit")),
    remaining: toInt(headers.get("ratelimit-remaining")),
    reset: toInt(headers.get("ratelimit-reset")),
    retryAfterS: parseRetryAfter(headers.get("retry-after")),
  };
}

/** `Retry-After` in seconds: a number, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

function toInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : null;
}
