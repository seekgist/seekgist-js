import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, ConnectionError, OPERATIONS, TimeoutError, parseUsage } from "../src/index.js";
import { FakeFetch, PUB, SEC, client, json, problem, waits } from "./fake-fetch.js";

beforeEach(() => {
  waits.length = 0;
});

describe("request building", () => {
  it("puts path params, query params and the bearer key in the right places", async () => {
    const fake = new FakeFetch().reply(json(200, { data: [], next_cursor: null }));
    await client(fake).synonyms.list({ cursor: "c/1", limit: 5 });
    const req = fake.sent[0]!;
    expect(req.url.pathname).toBe("/v1/synonyms");
    expect(req.url.searchParams.get("cursor")).toBe("c/1");
    expect(req.url.searchParams.get("limit")).toBe("5");
    expect(req.headers.authorization).toBe(`Bearer ${SEC}`);
    expect(req.headers["user-agent"]).toMatch(/^seekgist-js\//);
  });

  it("encodes path params and joins arrays with commas", async () => {
    const fake = new FakeFetch().reply(json(200, { id: "a b" }), json(200, { search_id: "s" }));
    const c = client(fake);
    await c.catalog.productsGet({ product_id: "a b/c" });
    expect(fake.sent[0]!.url.pathname).toBe("/v1/products/a%20b%2Fc");
    await c.search.searchGet({ q: "لابتوب", facets: "brand,price" }, { query: { "filter[brand]": ["Lenovo", "HP"] } });
    const url = fake.sent[1]!.url;
    expect(url.searchParams.get("q")).toBe("لابتوب");
    expect(url.searchParams.get("filter[brand]")).toBe("Lenovo,HP");
  });

  it("sends a public key as ?key= on GET when keyInQuery is set (no Authorization header)", async () => {
    const fake = new FakeFetch().reply(json(200, { suggestions: [] }), json(202, { accepted: 1 }));
    const c = client(fake, { apiKey: PUB, keyInQuery: true });
    await c.search.suggest({ q: "lap" });
    expect(fake.sent[0]!.url.searchParams.get("key")).toBe(PUB);
    expect(fake.sent[0]!.headers.authorization).toBeUndefined();
    await c.events.event({ body: { type: "view", product_id: "1" } as never });
    expect(fake.sent[1]!.url.searchParams.get("key")).toBeNull();
    expect(fake.sent[1]!.headers.authorization).toBe(`Bearer ${PUB}`);
  });

  it("refuses a missing path parameter before any network call", async () => {
    const fake = new FakeFetch();
    await expect(client(fake).jobs.get({ job_id: "" })).rejects.toThrow(/missing path parameter "job_id"/);
    expect(fake.sent).toHaveLength(0);
  });

  it("does not send a key to operations that need none", async () => {
    const fake = new FakeFetch().reply(json(200, []));
    await client(fake).billing.plans();
    expect(fake.sent[0]!.headers.authorization).toBeUndefined();
  });

  it("sends multipart uploads as FormData with the file name", async () => {
    const fake = new FakeFetch().reply(json(202, { id: "imp_1" }));
    await client(fake).imports.upload({
      body: { file: { data: "id,name\n1,Lamp\n", filename: "p.csv", type: "text/csv" }, source: "csv", dry_run: true },
    });
    const form = fake.sent[0]!.rawBody as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("p.csv");
    expect(form.get("dry_run")).toBe("true");
    expect(fake.sent[0]!.headers["idempotency-key"]).toMatch(/^sg-/);
  });
});

describe("retries and idempotency", () => {
  it("adds one Idempotency-Key to idempotent writes and keeps it across retries", async () => {
    const fake = new FakeFetch().reply(problem(503, "service_unavailable"), new TypeError("socket hang up"), json(200, { upserted: 1, unchanged: 0, deleted: 0 }));
    const res = await client(fake).request("products_batch", { body: { upsert: [] } });
    expect(res.attempts).toBe(3);
    const keys = fake.sent.map((s) => s.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^sg-[0-9a-f-]{36}$/);
    expect(waits).toEqual([500, 1000]);
  });

  it("uses the caller's Idempotency-Key", async () => {
    const fake = new FakeFetch().reply(json(200, { upserted: 0, unchanged: 0, deleted: 0 }, { "Idempotent-Replayed": "true" }));
    const res = await client(fake).request("products_batch", { body: {} }, { idempotencyKey: "my-key-0001" });
    expect(fake.sent[0]!.headers["idempotency-key"]).toBe("my-key-0001");
    expect(res.replayed).toBe(true);
  });

  it("never retries a non-idempotent write after a 5xx or a network error", async () => {
    const fake = new FakeFetch().reply(problem(502, "bad_gateway"));
    await expect(client(fake).events.event({ body: { type: "view" } as never })).rejects.toMatchObject({ status: 502 });
    expect(fake.sent).toHaveLength(1);
    const fake2 = new FakeFetch().reply(new TypeError("fetch failed"));
    await expect(client(fake2).events.click({ body: { search_id: "s", product_id: "1", position: 1 } as never })).rejects.toBeInstanceOf(ConnectionError);
    expect(fake2.sent).toHaveLength(1);
  });

  it("retries any call after 429 and waits Retry-After seconds", async () => {
    const fake = new FakeFetch().reply(problem(429, "rate_limited", { "Retry-After": "2" }), json(202, { accepted: 1 }));
    await client(fake).events.event({ body: { type: "view" } as never });
    expect(fake.sent).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it("retries 409 only for idempotency_in_progress", async () => {
    const fake = new FakeFetch().reply(problem(409, "conflict"));
    await expect(client(fake).request("products_batch", { body: {} })).rejects.toMatchObject({ code: "conflict" });
    expect(fake.sent).toHaveLength(1);
    const fake2 = new FakeFetch().reply(problem(409, "idempotency_in_progress"), json(200, { upserted: 0, unchanged: 0, deleted: 0 }));
    await client(fake2).request("products_batch", { body: {} });
    expect(fake2.sent).toHaveLength(2);
  });

  it("retries a search POST (it only reads) and stops after maxRetries", async () => {
    const fake = new FakeFetch().reply(problem(500, "internal_error"), problem(500, "internal_error"));
    await expect(client(fake, { maxRetries: 1 }).find("lamp")).rejects.toBeInstanceOf(ApiError);
    expect(fake.sent).toHaveLength(2);
  });
});

describe("answers and errors", () => {
  it("reads usage, rate limit and request id", async () => {
    const fake = new FakeFetch().reply(
      json(200, { search_id: "s1", ids: [], hits: [], total: 0 }, {
        "X-SeekGist-Usage": 'searches=1234, limit=150000, billed=1, period="2026-10"',
        "RateLimit-Limit": "10",
        "RateLimit-Remaining": "9",
        "X-Request-Id": "req_abc",
      }),
    );
    const res = await client(fake).find("laptop", { lang: "en", per_page: 5 });
    expect(fake.sent[0]!.body).toEqual({ q: "laptop", lang: "en", per_page: 5 });
    expect(res.usage).toEqual({ searches: 1234, limit: 150000, billed: 1, period: "2026-10" });
    expect(res.rateLimit).toMatchObject({ limit: 10, remaining: 9 });
    expect(res.requestId).toBe("req_abc");
  });

  it("turns problem+json into ApiError with code and field errors", async () => {
    const body = {
      type: "x", title: "Invalid request", status: 422, code: "invalid_request", detail: "Some fields are not valid.",
      request_id: "req_1", errors: [{ field: "upsert.0.price", code: "greater_than_equal", message: "Input should be >= 0" }],
    };
    const fake = new FakeFetch().reply(json(422, body));
    const err = (await client(fake).catalog.productsBatch({ body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("invalid_request");
    expect(err.requestId).toBe("req_test");
    expect(err.fieldErrors[0]!.field).toBe("upsert.0.price");
    expect(err.message).toContain("422 invalid_request");
  });

  it("gives http_<status> when the error body is not a problem", async () => {
    const fake = new FakeFetch().reply(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(client(fake, { maxRetries: 0 }).health.check()).rejects.toMatchObject({ code: "http_502" });
  });

  it("returns text and binary results as text and ArrayBuffer", async () => {
    const fake = new FakeFetch().reply(new Response("a,b\n", { status: 200 }), new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const c = client(fake);
    expect(OPERATIONS.synonyms_export.result).toBe("text");
    expect(await c.synonyms.export({ format: "csv" })).toBe("a,b\n");
    const bin = await c.files.download({ k: "x", e: 1, n: "a.csv", s: "y" });
    expect(new Uint8Array(bin)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws TimeoutError when an attempt is too slow", async () => {
    const fake = new FakeFetch().reply(() => new Promise<Response>((resolve) => setTimeout(() => resolve(json(200, {})), 200)));
    await expect(client(fake, { maxRetries: 0 }).health.check({}, { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("parseUsage", () => {
  it("handles spacing, order and missing parts", () => {
    expect(parseUsage('period="2026-11",billed=0,searches=5,limit=-1')).toEqual({ searches: 5, limit: -1, billed: 0, period: "2026-11" });
    expect(parseUsage("")).toBeNull();
    expect(parseUsage("limit=5")).toBeNull();
  });
});
