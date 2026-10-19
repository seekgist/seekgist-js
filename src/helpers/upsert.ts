/**
 * Send many products in batches (POST /v1/products/batch, max 1,000 items per call).
 * Every batch has its own Idempotency-Key, so a retry after a network error never applies a
 * batch twice. Give the same `keyPrefix` again to resume a run that stopped half way: batches
 * the server already did are answered from its 24 h store (Idempotent-Replayed).
 */
import { SeekGistError } from "../core/errors.js";
import { newIdempotencyKey } from "../core/transport.js";
import type { ApiResponse, RequestOptions } from "../core/spec.js";
import type { ItemError, ProductBatchRequest, ProductBatchResult, ProductIn } from "../generated/types/index.js";

export const MAX_BATCH = 1000;

export interface UpsertOptions {
  /** Items per call (default 500, max 1,000). Deletes count as items. */
  batchSize?: number;
  /** Product ids to delete in the same run. */
  deleteIds?: string[];
  /**
   * Full sync: products you did not send are deleted after the last batch. All batches get
   * one `sync_id`; the last one sends `sync_complete` + `replace_all`.
   */
  replaceAll?: boolean;
  /** Sync id for `replaceAll` (default: a new one). */
  syncId?: string;
  /** Idempotency keys are `<keyPrefix>-<batch number>` (default: a new random prefix). */
  keyPrefix?: string;
  /** Retries per batch (default 5). */
  maxRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called after each batch. */
  onBatch?: (info: BatchInfo) => void;
}

export interface BatchInfo {
  index: number;
  count: number;
  result: ProductBatchResult;
  replayed: boolean;
  idempotencyKey: string;
}

export interface BatchItemError extends ItemError {
  /** Which batch (0-based) the error came from. */
  batch: number;
}

export interface UpsertSummary {
  batches: number;
  upserted: number;
  unchanged: number;
  deleted: number;
  /** Products the API refused (the rest of each batch was saved). */
  errors: BatchItemError[];
  keyPrefix: string;
  syncId: string | null;
}

export type BatchFn = (body: ProductBatchRequest, options: RequestOptions) => Promise<ApiResponse<ProductBatchResult>>;

/** Split products and deletes into batches and send them one after another. */
export async function upsertProducts(send: BatchFn, products: readonly ProductIn[], opts: UpsertOptions = {}): Promise<UpsertSummary> {
  const size = opts.batchSize ?? 500;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) {
    throw new SeekGistError(`batchSize must be 1-${MAX_BATCH} (got ${size})`);
  }
  const deletes = opts.deleteIds ?? [];
  const items: Array<{ upsert?: ProductIn; del?: string }> = [
    ...products.map((p) => ({ upsert: p })),
    ...deletes.map((id) => ({ del: id })),
  ];
  const keyPrefix = opts.keyPrefix ?? newIdempotencyKey("sg-upsert");
  const syncId = opts.replaceAll ? (opts.syncId ?? newIdempotencyKey("sync")) : null;
  const total = Math.max(1, Math.ceil(items.length / size));
  const summary: UpsertSummary = { batches: 0, upserted: 0, unchanged: 0, deleted: 0, errors: [], keyPrefix, syncId };
  if (items.length === 0 && !opts.replaceAll) return summary;
  for (let index = 0; index < total; index++) {
    const slice = items.slice(index * size, (index + 1) * size);
    const body: ProductBatchRequest = {};
    const upsert = slice.flatMap((i) => (i.upsert ? [i.upsert] : []));
    const del = slice.flatMap((i) => (i.del !== undefined ? [i.del] : []));
    if (upsert.length) body.upsert = upsert;
    if (del.length) body.delete = del;
    if (syncId) {
      body.sync_id = syncId;
      if (index === total - 1) {
        body.sync_complete = true;
        body.replace_all = true;
      }
    }
    const idempotencyKey = `${keyPrefix}-${index}`;
    const res = await send(body, {
      idempotencyKey,
      maxRetries: opts.maxRetries ?? 5,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const r = res.data;
    summary.batches++;
    summary.upserted += r.upserted;
    summary.unchanged += r.unchanged;
    summary.deleted += r.deleted;
    for (const e of r.errors ?? []) summary.errors.push({ ...e, batch: index });
    opts.onBatch?.({ index, count: slice.length, result: r, replayed: res.replayed, idempotencyKey });
  }
  return summary;
}
