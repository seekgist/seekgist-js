/**
 * Webhook signature check (Standard Webhooks, https://www.standardwebhooks.com), the same
 * scheme as seekgist_providers/webhooks.py. Works in Node 20+, browsers, Deno, Bun and edge
 * runtimes (Web Crypto only, no Node modules).
 */
import { WebhookVerificationError } from "../core/errors.js";

export const WEBHOOK_TOLERANCE_S = 300;
const PREFIX = "whsec_";

/** The JSON body SeekGist sends. `data` depends on `type` (see the docs, "Webhooks"). */
export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  created_at: string;
  tenant_id: string;
  data: T;
}

/** Fetch `Headers`, a plain object, or Node's `IncomingHttpHeaders`. */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;
export type RawBody = string | Uint8Array | ArrayBuffer;

export interface VerifyWebhookOptions {
  /** The endpoint secret, `whsec_...` (from webhooks.create or webhooks.rotateSecret). */
  secret: string;
  headers: HeadersLike;
  /** The RAW request body, exactly as received. Do not parse and re-serialize it first. */
  body: RawBody;
  /** Allowed clock difference in seconds (default 300). */
  toleranceS?: number;
  /** Current time in unix seconds (tests). */
  now?: number;
}

function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const h = headers as Record<string, string | string[] | undefined>;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(" ") : v;
  }
  return undefined;
}

function bytes(body: RawBody): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin);
}

function secretKey(secret: string): Uint8Array {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  try {
    return fromBase64(raw);
  } catch {
    throw new WebhookVerificationError("the webhook secret is not valid base64 (expected whsec_...)");
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new WebhookVerificationError("Web Crypto (crypto.subtle) is not available in this runtime");
  return s;
}

/** `v1,<base64 HMAC-SHA256>` for one message. Useful to test your own receiver. */
export async function signWebhook(secret: string, msgId: string, timestamp: number, body: RawBody): Promise<string> {
  const key = await subtle().importKey("raw", secretKey(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${msgId}.${timestamp}.`);
  const payload = bytes(body);
  const msg = new Uint8Array(prefix.length + payload.length);
  msg.set(prefix);
  msg.set(payload, prefix.length);
  const mac = new Uint8Array(await subtle().sign("HMAC", key, msg as BufferSource));
  return `v1,${toBase64(mac)}`;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a webhook and return its parsed body. Throws WebhookVerificationError when the
 * headers are missing, the timestamp is more than `toleranceS` away, or no signature
 * matches (during a secret rotation the header holds two; any match is enough).
 * Also drop repeated `id`s on your side: a delivery can come more than once.
 */
export async function verifyWebhook<T = Record<string, unknown>>(opts: VerifyWebhookOptions): Promise<WebhookEvent<T>> {
  const msgId = header(opts.headers, "webhook-id");
  const tsRaw = header(opts.headers, "webhook-timestamp");
  const sigs = header(opts.headers, "webhook-signature");
  if (!msgId || !tsRaw || !sigs) throw new WebhookVerificationError("missing webhook headers");
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts)) throw new WebhookVerificationError("bad webhook timestamp");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceS ?? WEBHOOK_TOLERANCE_S)) {
    throw new WebhookVerificationError("webhook timestamp is too old or too new");
  }
  const expected = await signWebhook(opts.secret, msgId, ts, opts.body);
  if (!sigs.split(" ").some((s) => sameText(s.trim(), expected))) {
    throw new WebhookVerificationError("no matching webhook signature");
  }
  const text = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(bytes(opts.body));
  try {
    return JSON.parse(text) as WebhookEvent<T>;
  } catch {
    throw new WebhookVerificationError("the webhook body is not JSON");
  }
}
