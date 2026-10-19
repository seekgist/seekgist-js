/** Replays answers recorded from the real API (testdata/recorded/). */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/index.js";
import { FakeFetch, PUB, TESTDATA, client } from "./fake-fetch.js";

interface Recording {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const dir = join(TESTDATA, "recorded");
const load = (name: string): Recording => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Recording;
const replay = (r: Recording) => new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });

describe("recorded answers from the local API", () => {
  it("has the recordings", () => {
    expect(readdirSync(dir).sort()).toEqual(
      expect.arrayContaining(["search_post.json", "suggest.json", "whoami.json", "products_batch_replayed.json", "error_insufficient_scope.json", "error_invalid_request.json"]),
    );
  });

  it("search: ids, hits and the usage header", async () => {
    const rec = load("search_post");
    const res = await client(new FakeFetch().reply(replay(rec)), { apiKey: PUB }).find("lamp", { lang: "en", per_page: 5 });
    expect(res.data.ids).toEqual((rec.body as { ids: string[] }).ids);
    expect(res.data.hits[0]!.product.name.en).toBeTruthy();
    expect(res.usage).toMatchObject({ billed: 1, limit: 150000 });
    expect(res.rateLimit.limit).toBe(Number(rec.headers["ratelimit-limit"]));
  });

  it("suggest and whoami", async () => {
    const sug = await client(new FakeFetch().reply(replay(load("suggest"))), { apiKey: PUB }).search.suggest({ q: "lam" });
    expect(sug.suggestions.length).toBeGreaterThan(0);
    const who = await client(new FakeFetch().reply(replay(load("whoami")))).account.whoami();
    expect(who.scopes).toContain("catalog:write");
  });

  it("an idempotent replay is flagged", async () => {
    const res = await client(new FakeFetch().reply(replay(load("products_batch_replayed")))).request("products_batch", { body: {} });
    expect(res.replayed).toBe(true);
    expect(res.data.upserted + res.data.unchanged).toBeGreaterThan(0);
  });

  it("problem answers become ApiError with the right code", async () => {
    const scope = await client(new FakeFetch().reply(replay(load("error_insufficient_scope"))), { apiKey: PUB }).catalog.productsBatch({ body: {} }).catch((e: unknown) => e);
    expect(scope).toBeInstanceOf(ApiError);
    expect((scope as ApiError).code).toBe("insufficient_scope");
    const invalid = (await client(new FakeFetch().reply(replay(load("error_invalid_request")))).catalog.productsBatch({ body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(invalid.status).toBe(422);
    expect(invalid.fieldErrors[0]!.field).toBe("upsert.0.price");
  });
});
