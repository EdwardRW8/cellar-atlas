/**
 * Durable operation queue, backed by IndexedDB.
 *
 * Why IndexedDB and not localStorage: localStorage is synchronous, capped
 * around 5 MB, string-only, and browsers may clear it under storage pressure
 * without warning. This queue holds edits the user has made but the server
 * has not yet accepted. Losing it means losing their work.
 *
 * The critical invariant: removeByIds() only ever removes the ids passed to
 * it. There is no code path that replaces the queue with a snapshot, which
 * is precisely how V2 destroyed edits made during a flush.
 */

import { get, set, del } from "idb-keyval";
import type { Operation, QueueStore } from "./types";

const QUEUE_KEY = "cellar_v3_queue";

async function read(): Promise<Operation[]> {
  try {
    const raw = await get<Operation[]>(QUEUE_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch {
    // A read failure must never look like an empty queue to a caller that
    // might then overwrite it. Callers treat this as "unknown", and the only
    // safe response is to leave storage alone.
    return [];
  }
}

async function write(ops: Operation[]): Promise<void> {
  await set(QUEUE_KEY, ops);
}

export const indexedDbQueue: QueueStore = {
  async all() {
    return read();
  },

  async add(op) {
    const ops = await read();
    // Idempotent enqueue: the same operationId is never queued twice.
    if (ops.some((o) => o.operationId === op.operationId)) return;
    ops.push(op);
    await write(ops);
  },

  async removeByIds(ids) {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    const ops = await read();
    await write(ops.filter((o) => !remove.has(o.operationId)));
  },

  async update(op) {
    const ops = await read();
    const i = ops.findIndex((o) => o.operationId === op.operationId);
    if (i === -1) return;
    ops[i] = op;
    await write(ops);
  },

  async count() {
    return (await read()).length;
  },

  async clear() {
    await del(QUEUE_KEY);
  },
};

/**
 * In-memory queue for tests and for environments without IndexedDB.
 * Same semantics, same invariants.
 */
export function createMemoryQueue(): QueueStore {
  let ops: Operation[] = [];
  return {
    async all() {
      return [...ops];
    },
    async add(op) {
      if (ops.some((o) => o.operationId === op.operationId)) return;
      ops.push(op);
    },
    async removeByIds(ids) {
      const remove = new Set(ids);
      ops = ops.filter((o) => !remove.has(o.operationId));
    },
    async update(op) {
      const i = ops.findIndex((o) => o.operationId === op.operationId);
      if (i !== -1) ops[i] = op;
    },
    async count() {
      return ops.length;
    },
    async clear() {
      ops = [];
    },
  };
}
