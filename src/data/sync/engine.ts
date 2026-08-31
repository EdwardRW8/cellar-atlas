/**
 * Sync engine.
 *
 * Drains the operation queue against registered handlers. The rules it
 * enforces are the ones that keep user edits safe:
 *
 *   • Acknowledgement is BY ID. Anything enqueued mid-flush is untouched.
 *   • Operations are idempotent, so a retry after a lost response is safe.
 *   • A permanently failing operation is PARKED, never discarded. It still
 *     represents work the user did.
 *   • Only one flush runs at a time.
 */

import type { Operation, OperationHandler, QueueStore, SyncState } from "./types";
import { backoffMs, MAX_ATTEMPTS } from "./types";

export interface SyncEngineOptions {
  queue: QueueStore;
  isOnline: () => boolean;
  onStateChange?: (state: SyncState) => void;
  now?: () => Date;
}

export function createSyncEngine(opts: SyncEngineOptions) {
  const { queue, isOnline, onStateChange } = opts;
  const now = opts.now ?? (() => new Date());

  const handlers = new Map<string, OperationHandler>();
  let flushing = false;

  let state: SyncState = {
    status: "idle",
    pending: 0,
    lastSyncAt: null,
    lastError: null,
  };

  function emit(patch: Partial<SyncState>) {
    state = { ...state, ...patch };
    onStateChange?.(state);
  }

  function register(handler: OperationHandler) {
    handlers.set(handler.entity, handler);
  }

  async function enqueue(
    op: Omit<Operation, "attempts" | "lastAttemptAt" | "lastError" | "status">,
  ): Promise<void> {
    await queue.add({
      ...op,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      status: "pending",
    });
    emit({ pending: await queue.count() });
  }

  /** Should this operation be attempted yet, given its backoff? */
  function isDue(op: Operation): boolean {
    if (op.attempts === 0 || !op.lastAttemptAt) return true;
    const waited = now().getTime() - new Date(op.lastAttemptAt).getTime();
    return waited >= backoffMs(op.attempts);
  }

  async function flush(): Promise<SyncState> {
    if (flushing) return state;
    if (!isOnline()) {
      emit({ status: "offline", pending: await queue.count() });
      return state;
    }

    flushing = true;
    emit({ status: "syncing" });

    try {
      const ops = await queue.all();
      const due = ops.filter((o) => o.status !== "failed" && isDue(o));

      if (due.length === 0) {
        emit({
          status: "idle",
          pending: await queue.count(),
          lastSyncAt: now().toISOString(),
        });
        return state;
      }

      // Ids we may safely forget. Populated only on definite success.
      const acknowledged: string[] = [];
      let lastError: string | null = null;

      for (const op of due) {
        const handler = handlers.get(op.entity);

        if (!handler) {
          // Unknown entity — park it rather than lose it. A later build
          // that registers this handler will pick it up.
          await queue.update({
            ...op,
            status: "failed",
            lastError: `No handler registered for entity "${op.entity}"`,
            lastAttemptAt: now().toISOString(),
          });
          continue;
        }

        try {
          const result = await handler.apply(op);

          if (result.outcome === "applied" || result.outcome === "duplicate") {
            // "duplicate" means the server had already applied it. That is
            // success — it is exactly what idempotency is for.
            acknowledged.push(op.operationId);
          } else if (result.outcome === "permanent" || result.outcome === "conflict") {
            await queue.update({
              ...op,
              status: "failed",
              attempts: op.attempts + 1,
              lastAttemptAt: now().toISOString(),
              lastError: result.error ?? result.outcome,
            });
            lastError = result.error ?? result.outcome;
          } else {
            const attempts = op.attempts + 1;
            await queue.update({
              ...op,
              attempts,
              lastAttemptAt: now().toISOString(),
              lastError: result.error ?? "retryable",
              status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
            });
            lastError = result.error ?? "retryable";
          }
        } catch (err) {
          const attempts = op.attempts + 1;
          const message = err instanceof Error ? err.message : String(err);
          await queue.update({
            ...op,
            attempts,
            lastAttemptAt: now().toISOString(),
            lastError: message,
            status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          });
          lastError = message;
        }
      }

      // THE CRITICAL LINE. Remove only what succeeded. Anything the user
      // enqueued while the loop above was awaiting the network is still here.
      await queue.removeByIds(acknowledged);

      const pending = await queue.count();
      emit({
        status: lastError ? "error" : "idle",
        pending,
        lastError,
        lastSyncAt: now().toISOString(),
      });
      return state;
    } finally {
      flushing = false;
    }
  }

  /** Re-arm parked operations so the user can retry them deliberately. */
  async function retryFailed(): Promise<void> {
    const ops = await queue.all();
    for (const op of ops.filter((o) => o.status === "failed")) {
      await queue.update({ ...op, status: "pending", attempts: 0, lastError: null });
    }
    emit({ pending: await queue.count() });
  }

  async function refreshPending(): Promise<void> {
    emit({ pending: await queue.count() });
  }

  return {
    register,
    enqueue,
    flush,
    retryFailed,
    refreshPending,
    getState: () => state,
    isFlushing: () => flushing,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
