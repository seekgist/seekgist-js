/** A fetch stand-in for unit tests: answers from a queue and records every request. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SeekGist, type ClientOptions } from "../src/index.js";

/** Test data: test/testdata/ in the public SDK repository, packages/sdk-codegen/testdata/ in the monorepo. */
export const TESTDATA = existsSync(join(import.meta.dirname, "testdata"))
  ? join(import.meta.dirname, "testdata")
  : join(import.meta.dirname, "..", "..", "sdk-codegen", "testdata");

export interface Sent {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: BodyInit | null | undefined;
}

export type Reply = Response | Error | ((req: Sent) => Response | Error | Promise<Response | Error>);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const type = status >= 400 ? "application/problem+json" : "application/json";
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": type, "X-Request-Id": "req_test", ...headers },
  });
}

export function problem(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(status, { type: `https://seekgist.com/docs/errors/${code}`, title: code, status, code, request_id: "req_test" }, headers);
}

export class FakeFetch {
  readonly sent: Sent[] = [];
  private readonly queue: Reply[] = [];

  reply(...replies: Reply[]): this {
    this.queue.push(...replies);
    return this;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown = init.body;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    const req: Sent = { url: new URL(input), method: init.method ?? "GET", headers, body, rawBody: init.body };
    this.sent.push(req);
    const next = this.queue.shift();
    if (!next) throw new Error(`no reply queued for ${req.method} ${input}`);
    const out = typeof next === "function" ? await next(req) : next;
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (out instanceof Error) throw out;
    return out;
  };
}

export const PUB = "sg_pub_" + "a".repeat(44);
export const SEC = "sg_sec_" + "b".repeat(44);

export function client(fake: FakeFetch, options: ClientOptions = {}): SeekGist {
  const c = new SeekGist({ apiKey: SEC, baseUrl: "http://api.test", fetch: fake.fetch, ...options });
  // No real waiting in unit tests: record the waits instead.
  const cfg = (c as unknown as { cfg: { sleep: (ms: number) => Promise<void>; random: () => number } }).cfg;
  cfg.sleep = async (ms) => {
    waits.push(ms);
  };
  cfg.random = () => 0.5;
  return c;
}

export const waits: number[] = [];
