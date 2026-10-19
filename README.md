# @seekgist/sdk: SeekGist for JavaScript and TypeScript

The official JavaScript client for the [SeekGist](https://seekgist.com) API: Arabic-first
e-commerce search, suggest, catalog sync and webhooks. Works in browsers, Node 20+, Deno, Bun
and edge runtimes (only `fetch` and Web Crypto, no Node modules). ESM only, typed.

```bash
npm install @seekgist/sdk
```

Documentation: https://seekgist.com/docs. Support: support@seekgist.com.

## Quick start

```ts
import { SeekGist } from "@seekgist/sdk";

const client = new SeekGist({ apiKey: process.env.SEEKGIST_API_KEY }); // secret key, on your server

const products = [{ id: "42", name: { en: "Desk lamp", ar: "مصباح مكتب" }, price: "12.500", currency: "JOD" }];
const sum = await client.upsertProducts(products); // batches, retries, one Idempotency-Key per batch
console.log(sum.upserted, sum.errors);

const res = await client.find("مصباح", { lang: "ar", per_page: 12 });
console.log(res.data.ids);              // product ids in rank order; res.data.hits has the product cards
console.log(res.usage, res.requestId);  // searches used this period; quote the request id to support
```

Keys: a **public** key (`sg_pub_...`) is safe in the browser and can search, suggest,
recommend and send events. A **secret** key (`sg_sec_...`) is for your server only; the
client refuses it in a browser. Options: `baseUrl` (default `https://api.seekgist.com`),
`timeoutMs` (10,000 per attempt), `maxRetries` (2), `headers`, `fetch`, `keyInQuery` (public
key as `?key=` on GET calls, so the browser skips the CORS preflight).

## All API methods

One namespace per API area, one method per operation:
`client.search`, `client.events`, `client.catalog`, `client.imports`, `client.connectors`,
`client.jobs`, `client.synonyms`, `client.rules`, `client.experiments`, `client.translation`,
`client.analytics`, `client.webhooks`, `client.account`, `client.billing`, `client.health`,
`client.files`.

Catalog translation works: `translation.backfill`, `status`, `review*`, `glossary*`, `export`,
`approved` and `ack`. Not available on this platform: the chat methods. They answer
`404 feature_unavailable`.

```ts
await client.synonyms.create({ body: { kind: "equivalent", terms: ["sneakers", "trainers", "سنيكرز"] } });
await client.catalog.productsGet({ product_id: "42" });
await client.search.searchGet({ q: "sneakers" }, { query: { "filter[brand]": ["Nike", "Adidas"] } });

// Any operation by its OpenAPI operationId, with headers (usage, rate limit, request id):
const r = await client.request("search_post", { body: { q: "dress" } });
```

Every method takes `options` last: `{ timeoutMs, maxRetries, idempotencyKey, headers, query, signal }`.
Dashboard sign-in, admin and store-app callback endpoints are not in the SDK on purpose.

## Helpers

| Helper | What it does |
|---|---|
| `client.find(q, fields)` | POST /v1/search; returns the full response with `usage` |
| `client.suggester({ debounceMs, minChars, lang, products })` | `await s.input(text)` on every key press: waits for typing to stop (120 ms), cancels out-of-date calls, caches recent answers; `null` for short or stale text. Suggest is never billed |
| `client.upsertProducts(products, { batchSize, deleteIds, replaceAll, keyPrefix, onBatch })` | Batches of up to 1,000 with one `Idempotency-Key` per batch (`<keyPrefix>-<n>`) and 5 retries; same `keyPrefix` again = safe resume; `replaceAll` = full sync |
| `client.waitForJob(id)` | Polls `GET /v1/jobs/{id}` until done (reindex, imports) |
| `client.pages(cursor => client.synonyms.list({ cursor }))` | `for await` over every item of a cursor list |
| `verifyWebhook({ secret, headers, body })` | Standard Webhooks signature + 5-minute time check; returns the event |
| `parseUsage(header)` | Reads `X-SeekGist-Usage` |

```ts
// Search box in the browser (public key):
const s = client.suggester({ lang: "auto", products: 3 });
input.addEventListener("input", async () => render(await s.input(input.value)));

// Catalog sync on your server (secret key):
const sum = await client.upsertProducts(products, { replaceAll: true, keyPrefix: `nightly-${date}` });
// sum: { batches, upserted, unchanged, deleted, errors: [{ batch, index, id, code, message }] }

// Webhook receiver: pass the RAW body, not a re-encoded one.
const event = await verifyWebhook({ secret: process.env.SEEKGIST_WEBHOOK_SECRET!, headers: req.headers, body: rawBody });
```

## Errors, retries and idempotency

- `ApiError`: the API answered with an error (`status`, `code`, `requestId`, `fieldErrors`,
  `retryAfterS`). Use `code` in your program (`insufficient_scope`, `rate_limited`, ...).
- `TimeoutError`, `ConnectionError`: no answer. `WebhookVerificationError`: bad webhook.
- Retries (default 2, backoff 0.5 s, 1 s, 2 s ... with jitter; `Retry-After` wins): GET calls,
  search, and writes that take an `Idempotency-Key` (the SDK adds one and keeps it for every
  retry). Other writes (click, event) are never retried after a network error
  or a 5xx, so nothing is counted twice; a 429 is retried for every call (nothing was done).
- Store search pages: use `timeoutMs: 300, maxRetries: 0` and fall back to the store's own
  search on any error.

## Examples

`examples/search.mjs` (Node search + suggest), `examples/browser-suggest.html` (search box),
`examples/sync-catalog.mjs` (batch upsert), `examples/webhook-receiver.mjs` (node:http).
In a clone of the repository, run `npm run build` first.

## Development

From a clone of https://github.com/seekgist/seekgist-js:

```bash
npm install
npm test            # unit tests: fake fetch + answers recorded from the real API
npm run typecheck
npm run build
```

Bugs and questions: https://github.com/seekgist/seekgist-js/issues or support@seekgist.com.

## License

MIT. See `LICENSE`.
