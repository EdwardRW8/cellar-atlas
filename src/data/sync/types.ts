/**
 * Sync contract.
 *
 * Two defects in V2 caused or risked data loss. Both are designed out here
 * rather than patched:
 *
 *   1. QUEUE CLOBBERING — V2 replaced the whole queue after a flush,
 *      destroying anything enqueued during it. Here the queue only ever
 *      REMOVES BY ID, so concurrent enqueues survive.
 *
 *   2. NO IDEMPOTENCY — V2 generated an entity id then inserted. A lost
 *      response meant the retry hit a PK conflict, threw, and jammed the
 *      queue permanently. Here every operation carries its own operationId,
 *      distinct from the entity id, and the server records applied ids.
 *      Replaying an operation N times has the same effect as applying it once.
 */

export type OperationStatus = "pending" | "inflight" | "failed";

export interface Operation<TPayload = unknown> {
  /** Identity of the OPERATION. Distinct from the entity id. The server
   *  deduplicates on this, which is what makes retries safe. */
  operationId: string;
  /** Which repository handles this, e.g. "bottle" | "tasting". */
  entity: string;
  /** Identity of the THING being changed. Stable across retries. */
  entityId: string;
  type: "create" | "update" | "delete";
  payload: TPayload;
  /** Set by the device, may be skewed. Server time is authoritative. */
  clientTime: string;
  deviceId: string;
  /** Retry bookkeeping. */
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  status: OperationStatus;
}

export interface OperationResult {
  operationId: string;
  outcome: "applied" | "duplicate" | "conflict" | "retryable" | "permanent";
  error?: string;
}

/**
 * How a repository executes one operation against the server.
 * MUST be idempotent: applying twice equals applying once.
 */
export interface OperationHandler {
  readonly entity: string;
  apply(op: Operation): Promise<OperationResult>;
}

export interface QueueStore {
  all(): Promise<Operation[]>;
  add(op: Operation): Promise<void>;
  /** Remove ONLY these ids. Never replaces the queue wholesale. */
  removeByIds(ids: string[]): Promise<void>;
  update(op: Operation): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export interface CacheEnvelope<T> {
  /** Bumped when the shape changes. A mismatch discards the cache rather
   *  than silently mis-reading it. */
  schemaVersion: number;
  cellarId: string;
  savedAt: string;
  data: T;
}

export type SyncStatus = "idle" | "syncing" | "offline" | "error";

export interface SyncState {
  status: SyncStatus;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** Exponential backoff with jitter, capped. */
export function backoffMs(attempts: number): number {
  const base = Math.min(1000 * Math.pow(2, attempts), 60_000);
  return base + Math.random() * 250;
}

/** Retry ceiling before an operation is parked as failed for user review.
 *  It is NEVER discarded — a parked operation is still recoverable data. */
export const MAX_ATTEMPTS = 8;
