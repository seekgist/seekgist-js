// Search and suggest from Node with a PUBLIC key.
//   SEEKGIST_API_KEY=sg_pub_... SEEKGIST_BASE_URL=http://localhost:58000 node examples/search.mjs "فستان"
// (run `npm run build` first; in your project: import { SeekGist } from "@seekgist/sdk")
import { ApiError, SeekGist } from "../dist/index.js";

const query = process.argv[2] ?? "dress";
const client = new SeekGist(); // reads SEEKGIST_API_KEY and SEEKGIST_BASE_URL

try {
  const res = await client.find(query, { per_page: 5 });
  console.log(`${res.data.total} results for "${query}" (${res.data.took_ms} ms)`);
  for (const hit of res.data.hits) console.log(`- ${hit.product.name.ar ?? hit.product.name.en} | ${hit.product.price} ${hit.product.currency}`);
  if (res.usage) console.log(`usage: ${res.usage.searches} of ${res.usage.limit === -1 ? "no limit" : res.usage.limit} searches in ${res.usage.period}`);
  const sug = await client.search.suggest({ q: query.slice(0, 3) });
  console.log("suggestions:", sug.suggestions.map((s) => s.text).join(", "));
} catch (err) {
  if (err instanceof ApiError) console.error(`API error ${err.status} ${err.code} (request ${err.requestId})`);
  else throw err;
  process.exitCode = 1;
}
