import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeekGist, SeekGistError, Suggester, WebhookVerificationError, signWebhook, verifyWebhook } from "../src/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeFetch, PUB, SEC, TESTDATA, client, json, waits } from "./fake-fetch.js";

const vectors: unknown = JSON.parse(readFileSync(join(TESTDATA, "webhooks.json"), "utf8"));

beforeEach(() => {
  waits.length = 0;
});

describe("Suggester", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the typing to stop and calls once with the last text", async () => {
    const calls: string[] = [];
    const s = new Suggester(async (p) => {
      calls.push(p.q);
      return { query: p.q, suggestions: [] } as never;
    }, { debounceMs: 100 });
    const a = s.input("l");
    const b = s.input("la");
    const c = s.input("lap ");
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(await c).toMatchObject({ query: "lap" });
    expect(calls).toEqual(["lap"]);
  });

  it("drops an answer that a newer input made out of date, and aborts its request", async () => {
    let signal: AbortSignal | undefined;
    const s = new Suggester((p, o) => {
      signal ??= o?.signal;
      return new Promise((resolve) => setTimeout(() => resolve({ query: p.q } as never), 500));
    }, { debounceMs: 10 });
    const first = s.input("sam");
    await vi.advanceTimersByTimeAsync(20);
    const second = s.input("samsung");
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(await first).toBeNull();
    expect(await second).toMatchObject({ query: "samsung" });
  });

  it("answers repeated text from the cache, skips short text, and reports errors", async () => {
    const fn = vi.fn(async (p: { q: string }) => ({ query: p.q }) as never);
    const onError = vi.fn();
    const s = new Suggester(fn, { debounceMs: 0, minChars: 2, onError });
    expect(await s.input("a")).toBeNull();
    const p1 = s.input("آيفون");
    await vi.advanceTimersByTimeAsync(1);
    await p1;
    expect(await s.input("آيفون")).toMatchObject({ query: "آيفون" });
    expect(fn).toHaveBeenCalledTimes(1);
    const failing = new Suggester(async () => {
      throw new Error("down");
    }, { debounceMs: 0, onError });
    const p2 = failing.input("tv");
    const caught = p2.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toBe("down");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("is wired to GET /v1/suggest with a short timeout and no retries", async () => {
    vi.useRealTimers();
    const fake = new FakeFetch().reply(json(200, { query: "lap", suggestions: [] }));
    const s = client(fake, { apiKey: PUB, keyInQuery: true }).suggester({ debounceMs: 0, lang: "ar", products: 3 });
    await s.input("lap");
    const url = fake.sent[0]!.url;
    expect(url.pathname).toBe("/v1/suggest");
    expect(url.searchParams.get("lang")).toBe("ar");
    expect(url.searchParams.get("products")).toBe("3");
    expect(url.searchParams.get("key")).toBe(PUB);
  });
});

describe("upsertProducts", () => {
  const product = (i: number) => ({ id: String(i), name: { en: `Item ${i}` }, price: "1.000", currency: "JOD" }) as never;
  const ok = (n: number) => json(200, { upserted: n, unchanged: 0, deleted: 0 });

  it("splits into batches with one stable Idempotency-Key per batch", async () => {
    const fake = new FakeFetch().reply(ok(2), json(503, { code: "service_unavailable", status: 503, title: "x", type: "x", request_id: "r" }), ok(2), json(200, { upserted: 1, unchanged: 0, deleted: 1, errors: [{ index: 0, id: "5", code: "invalid", message: "bad price" }] }), json(200, { upserted: 0, unchanged: 0, deleted: 1 }));
    const seen: number[] = [];
    const sum = await client(fake).upsertProducts([1, 2, 3, 4, 5].map(product), {
      batchSize: 2, deleteIds: ["x", "y"], keyPrefix: "run-42", onBatch: (b) => seen.push(b.count),
    });
    const keys = fake.sent.map((s) => s.headers["idempotency-key"]);
    expect(keys).toEqual(["run-42-0", "run-42-1", "run-42-1", "run-42-2", "run-42-3"]);
    expect(fake.sent[3]!.body).toEqual({ upsert: [product(5)], delete: ["x"] });
    expect(fake.sent[4]!.body).toEqual({ delete: ["y"] });
    expect(seen).toEqual([2, 2, 2, 1]);
    expect(sum).toMatchObject({ batches: 4, upserted: 5, deleted: 2, keyPrefix: "run-42", syncId: null });
    expect(sum.errors).toEqual([{ index: 0, id: "5", code: "invalid", message: "bad price", batch: 2 }]);
  });

  it("marks only the last batch of a full sync as complete", async () => {
    const fake = new FakeFetch().reply(ok(2), ok(1));
    const sum = await client(fake).upsertProducts([1, 2, 3].map(product), { batchSize: 2, replaceAll: true, syncId: "sync-1" });
    expect(fake.sent[0]!.body).toMatchObject({ sync_id: "sync-1" });
    expect(fake.sent[0]!.body).not.toHaveProperty("sync_complete");
    expect(fake.sent[1]!.body).toMatchObject({ sync_id: "sync-1", sync_complete: true, replace_all: true });
    expect(sum.syncId).toBe("sync-1");
  });

  it("sends one empty completing batch for a full sync of nothing, and nothing otherwise", async () => {
    const fake = new FakeFetch().reply(json(200, { upserted: 0, unchanged: 0, deleted: 9 }));
    expect((await client(fake).upsertProducts([], { replaceAll: true })).deleted).toBe(9);
    expect(fake.sent[0]!.body).toMatchObject({ sync_complete: true, replace_all: true });
    const none = new FakeFetch();
    expect((await client(none).upsertProducts([])).batches).toBe(0);
  });

  it("refuses a batch size over 1,000", async () => {
    await expect(client(new FakeFetch()).upsertProducts([product(1)], { batchSize: 1001 })).rejects.toBeInstanceOf(SeekGistError);
  });
});

describe("webhooks", () => {
  const v = vectors as { secret: string; other_secret: string; timestamp: number; body: string; headers: Record<string, string>; rotation_headers: Record<string, string>; signature: string };

  it("matches the server's signer byte for byte", async () => {
    expect(await signWebhook(v.secret, v.headers["webhook-id"]!, v.timestamp, v.body)).toBe(v.signature);
  });

  it("accepts a good message (string, bytes, Headers, Node header objects)", async () => {
    const ev = await verifyWebhook({ secret: v.secret, headers: v.headers, body: v.body, now: v.timestamp + 10 });
    expect(ev.type).toBe("catalog.import_finished");
    expect(ev.data).toMatchObject({ note: "تم الاستيراد" });
    const bytes = new TextEncoder().encode(v.body);
    await verifyWebhook({ secret: v.secret, headers: new Headers(v.headers), body: bytes, now: v.timestamp });
    const node = { "Webhook-Id": v.headers["webhook-id"], "webhook-timestamp": [v.headers["webhook-timestamp"]!], "webhook-signature": v.headers["webhook-signature"] };
    await verifyWebhook({ secret: v.secret, headers: node, body: bytes.buffer, now: v.timestamp });
  });

  it("accepts either secret during a rotation", async () => {
    await verifyWebhook({ secret: v.other_secret, headers: v.rotation_headers, body: v.body, now: v.timestamp });
    await verifyWebhook({ secret: v.secret, headers: v.rotation_headers, body: v.body, now: v.timestamp });
  });

  it("refuses a changed body, a wrong secret, an old timestamp and missing headers", async () => {
    const base = { secret: v.secret, headers: v.headers, body: v.body, now: v.timestamp };
    await expect(verifyWebhook({ ...base, body: v.body.replace("succeeded", "failed") })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook({ ...base, secret: v.other_secret })).rejects.toThrow(/no matching/);
    await expect(verifyWebhook({ ...base, now: v.timestamp + 301 })).rejects.toThrow(/too old/);
    await expect(verifyWebhook({ ...base, headers: {} })).rejects.toThrow(/missing/);
  });
});

describe("client", () => {
  it("checks the key shape and refuses a secret key in a browser or in the URL", () => {
    expect(() => new SeekGist({ apiKey: "nope", fetch: async () => json(200, {}) })).toThrow(/sg_pub_/);
    expect(() => new SeekGist({ apiKey: SEC, keyInQuery: true, fetch: async () => json(200, {}) })).toThrow(/public key/);
    (globalThis as { document?: unknown }).document = {};
    try {
      expect(() => new SeekGist({ apiKey: SEC, fetch: async () => json(200, {}) })).toThrow(/browser/);
      expect(() => new SeekGist({ apiKey: PUB, fetch: async () => json(200, {}) })).not.toThrow();
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("waits for a job until it is done", async () => {
    const job = (status: string) => json(200, { id: "j1", kind: "reindex", status, created_at: "2026-10-13T00:00:00Z" });
    const fake = new FakeFetch().reply(job("queued"), job("running"), job("succeeded"));
    const done = await client(fake).waitForJob("j1", { intervalMs: 5 });
    expect(done.status).toBe("succeeded");
    expect(fake.sent).toHaveLength(3);
    expect(waits).toEqual([5, 5]);
  });

  it("walks every page of a cursor list", async () => {
    const fake = new FakeFetch().reply(json(200, { data: [{ id: "1" }, { id: "2" }], next_cursor: "n2" }), json(200, { data: [{ id: "3" }], next_cursor: null }));
    const c = client(fake);
    const ids: string[] = [];
    for await (const s of c.pages((cursor) => c.synonyms.list({ cursor }))) ids.push(s.id);
    expect(ids).toEqual(["1", "2", "3"]);
    expect(fake.sent[1]!.url.searchParams.get("cursor")).toBe("n2");
  });
});
