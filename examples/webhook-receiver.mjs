// Receive SeekGist webhooks and check the signature.
//   SEEKGIST_WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.mjs   (listens on :3001)
import { createServer } from "node:http";
import { WebhookVerificationError, verifyWebhook } from "../dist/index.js";

const secret = process.env.SEEKGIST_WEBHOOK_SECRET ?? "";
const seen = new Set(); // drop repeated deliveries (use your database in production)

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks); // the RAW body: do not parse it first
  try {
    const event = await verifyWebhook({ secret, headers: req.headers, body });
    if (!seen.has(event.id)) {
      seen.add(event.id);
      console.log(`${event.type}`, event.data);
    }
    res.writeHead(204).end();
  } catch (err) {
    if (!(err instanceof WebhookVerificationError)) throw err;
    res.writeHead(400).end(err.message);
  }
}).listen(3001, () => console.log("listening on http://localhost:3001"));
