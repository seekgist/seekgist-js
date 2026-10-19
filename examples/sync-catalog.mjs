// Push your products with a SECRET key (server only). Batches of 500, one Idempotency-Key per
// batch, retries on network errors. Run it again with the same KEY_PREFIX to resume.
//   SEEKGIST_API_KEY=sg_sec_... node examples/sync-catalog.mjs
import { SeekGist } from "../dist/index.js";

const client = new SeekGist();
const products = Array.from({ length: 1200 }, (_, i) => ({
  id: `demo-${i}`,
  name: { en: `Demo product ${i}`, ar: `منتج تجريبي ${i}` },
  price: (5 + (i % 50)).toFixed(3),
  currency: "USD",
  in_stock: i % 7 !== 0,
}));

const summary = await client.upsertProducts(products, {
  batchSize: 500,
  keyPrefix: process.env.KEY_PREFIX, // same prefix = resume a stopped run safely
  onBatch: (b) => console.log(`batch ${b.index + 1}: ${b.count} items${b.replayed ? " (already done)" : ""}`),
});
console.log(summary);
