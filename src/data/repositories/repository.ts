/**
 * The contract every domain repository implements from Phase 2 onward
 * (wines, bottles, storage, tastings, events, valuations).
 *
 * Defining it now means the sync infrastructure is proven before any wine
 * data depends on it, and every future repository inherits the same safety
 * properties rather than reinventing them.
 */

import type { Operation, OperationHandler, OperationResult } from "../sync/types";

export interface Identified {
  id: string;
}

/** Rows carry a version for optimistic concurrency. An update asserts the
 *  version it read; a mismatch is a conflict, not a silent overwrite. */
export interface Versioned {
  version: number;
}

export interface RepositoryContext {
  cellarId: string;
  userId: string;
  deviceId: string;
  /** Injectable so tests are deterministic. */
  newId: () => string;
  now: () => Date;
}

export interface Repository<T extends Identified> extends OperationHandler {
  readonly entity: string;

  /** Read all live rows for the cellar. Throws if unreachable — never
   *  returns an empty array to mean "could not load". */
  list(): Promise<T[]>;
  getById(id: string): Promise<T | null>;

  /** Local-first mutations. Each applies optimistically and enqueues an
   *  idempotent operation. */
  create(input: Omit<T, "id">): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<void>;
  /** Soft delete. Nothing is ever physically removed. */
  remove(id: string, reason: string): Promise<void>;

  /** Idempotent server application. Required by OperationHandler. */
  apply(op: Operation): Promise<OperationResult>;
}

/** Classify a Supabase/Postgres error into a sync outcome. */
export function classifyError(err: unknown): OperationResult["outcome"] {
  const e = err as { code?: string; message?: string; status?: number } | null;
  if (!e) return "retryable";

  // Unique violation — the row already exists, so a prior attempt landed.
  if (e.code === "23505") return "duplicate";
  // Foreign key / check / not-null violations are permanent: retrying an
  // invalid payload will never succeed.
  if (e.code === "23503" || e.code === "23502" || e.code === "23514") return "permanent";
  // RLS denial.
  if (e.code === "42501") return "permanent";
  // Optimistic concurrency failure raised by our own guard.
  if (e.code === "P0001" && /version/i.test(e.message ?? "")) return "conflict";

  const status = e.status ?? 0;
  if (status === 401 || status === 403) return "permanent";
  if (status === 400 || status === 422) return "permanent";

  // Network, timeout, 5xx — worth another go.
  return "retryable";
}

export function makeOperation(
  ctx: RepositoryContext,
  entity: string,
  entityId: string,
  type: Operation["type"],
  payload: unknown,
): Omit<Operation, "attempts" | "lastAttemptAt" | "lastError" | "status"> {
  return {
    operationId: ctx.newId(),
    entity,
    entityId,
    type,
    payload,
    clientTime: ctx.now().toISOString(),
    deviceId: ctx.deviceId,
  };
}
