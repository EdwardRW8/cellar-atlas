/**
 * Conflict resolution by REBASE, never by force overwrite.
 *
 * When an operation fails with a version conflict, another device changed the
 * row first. The original plan offered "Keep Mine" as an overwrite, which
 * would have bypassed the optimistic concurrency check — a hole in the middle
 * of the safety model. This does it properly:
 *
 *   KEEP MINE   fetch the latest server state, reconstruct the user's INTENT
 *               against it, create a NEW operation with the CURRENT version,
 *               and submit through the normal version check. If it conflicts
 *               again, we surface it again.
 *
 *   USE THEIRS  discard the local operation and accept the server state.
 *
 * The version check is never bypassed. A rebased operation can itself lose a
 * race, and that is correct — it means a third change landed in between.
 */

import type { Operation } from "@/data/sync/types";

export type ConflictChoice = "keep-mine" | "use-theirs";

export interface ConflictContext<TServer = Record<string, unknown>> {
  operation: Operation;
  /** The row as the server currently has it. */
  serverState: TServer;
  /** The row as it was when the user acted. */
  baseState: TServer | null;
}

export interface RebaseResult {
  outcome: "rebased" | "already-applied" | "not-rebasable" | "discarded";
  /** A NEW operation carrying a fresh id and the current version. */
  operation: Operation | null;
  /** Plain-English description of what will now happen. */
  explanation: string;
}

/** Fields a user intended to change, derived from the operation payload. */
function intendedChanges(op: Operation): Record<string, unknown> {
  const payload = op.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return {};
  // `version` and identifiers are not user intent.
  const { version: _v, id: _id, cellar_id: _c, ...rest } = payload;
  return rest;
}

/**
 * Has the server already got what the user wanted?
 *
 * Common when the same change was made on two devices. Resolving it as a
 * conflict would be confusing; it is simply already done.
 */
function alreadySatisfied(
  intent: Record<string, unknown>,
  server: Record<string, unknown>,
): boolean {
  const keys = Object.keys(intent);
  if (keys.length === 0) return false;
  return keys.every((k) => JSON.stringify(intent[k]) === JSON.stringify(server[k]));
}

/**
 * Rebase a conflicted operation onto the current server state.
 *
 * IMPORTANT: this produces a NEW operation with a NEW operationId. Reusing
 * the original id would be reported as a duplicate by the idempotency ledger
 * and silently do nothing.
 */
export function rebaseOperation(
  ctx: ConflictContext,
  newId: () => string,
  now: () => Date = () => new Date(),
): RebaseResult {
  const { operation, serverState } = ctx;
  const server = serverState as Record<string, unknown>;
  const intent = intendedChanges(operation);

  if (Object.keys(intent).length === 0) {
    return {
      outcome: "not-rebasable",
      operation: null,
      explanation:
        "This change cannot be automatically reapplied. Review the current " +
        "state and make the change again if you still want it.",
    };
  }

  if (alreadySatisfied(intent, server)) {
    return {
      outcome: "already-applied",
      operation: null,
      explanation: "Someone else already made this exact change. Nothing further to do.",
    };
  }

  // A status change onto a bottle that has since left the cellar cannot be
  // rebased — consuming an already-gifted bottle is not a merge, it is a
  // decision the user must make.
  const serverStatus = server.status as string | undefined;
  const intendedStatus = intent.status as string | undefined;
  if (serverStatus && serverStatus !== "in_cellar" && intendedStatus) {
    return {
      outcome: "not-rebasable",
      operation: null,
      explanation:
        `This bottle has already been marked ${serverStatus} on another device. ` +
        `Your change cannot be applied on top of that.`,
    };
  }

  const currentVersion = typeof server.version === "number" ? server.version : null;
  if (currentVersion === null) {
    return {
      outcome: "not-rebasable",
      operation: null,
      explanation: "Could not determine the current version. Please retry manually.",
    };
  }

  // The rebased operation: same intent, new id, CURRENT version.
  // It still goes through the normal version check on submission.
  const rebased: Operation = {
    ...operation,
    operationId: newId(),
    payload: { ...intent, version: currentVersion },
    clientTime: now().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
  };

  return {
    outcome: "rebased",
    operation: rebased,
    explanation: describeRebase(intent, server),
  };
}

/** What the user will see: their change, restated against the new reality. */
function describeRebase(
  intent: Record<string, unknown>,
  server: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(intent)) {
    if (key === "version") continue;
    const current = server[key];
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    parts.push(`${humanise(key)}: ${format(current)} → ${format(value)}`);
  }
  return parts.length
    ? `Your change will be reapplied to the latest version — ${parts.join(", ")}.`
    : "Your change will be reapplied to the latest version.";
}

function humanise(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\bid\b/g, "")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Use Theirs — discard the local operation. Nothing is submitted. */
export function discardOperation(op: Operation): RebaseResult {
  return {
    outcome: "discarded",
    operation: null,
    explanation:
      `Your change to this ${op.entity} was discarded. ` +
      `The version from the other device is now shown.`,
  };
}

/** A conflict shaped for display. */
export interface ConflictSummary {
  operationId: string;
  entity: string;
  entityId: string;
  what: string;
  yours: { field: string; value: string }[];
  theirs: { field: string; value: string }[];
  canRebase: boolean;
}

export function summariseConflict(ctx: ConflictContext): ConflictSummary {
  const server = ctx.serverState as Record<string, unknown>;
  const intent = intendedChanges(ctx.operation);
  const fields = Object.keys(intent).filter((k) => k !== "version");

  return {
    operationId: ctx.operation.operationId,
    entity: ctx.operation.entity,
    entityId: ctx.operation.entityId,
    what: describeOperation(ctx.operation),
    yours: fields.map((f) => ({ field: humanise(f), value: format(intent[f]) })),
    theirs: fields.map((f) => ({ field: humanise(f), value: format(server[f]) })),
    canRebase:
      typeof server.version === "number" &&
      fields.length > 0 &&
      !(server.status && server.status !== "in_cellar" && intent.status),
  };
}

function describeOperation(op: Operation): string {
  const p = op.payload as Record<string, unknown> | null;
  if (p?.status) return `Mark bottle as ${String(p.status)}`;
  if (p?.storage_location_id || p?.position) return "Move bottle";
  if (op.type === "create") return `Create ${op.entity}`;
  return `Update ${op.entity}`;
}
