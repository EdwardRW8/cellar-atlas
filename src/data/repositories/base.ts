/**
 * Repository base.
 *
 * TWO RULES, both enforced by tests:
 *
 *   1. Reads are direct RLS-protected SELECTs.
 *   2. Writes go through RPC functions ONLY. No feature code ever calls
 *      .insert(), .update() or .delete() on a domain table.
 *
 * MUTATION KIND (amendment 3) decides how the UI presents an in-flight
 * change:
 *
 *   simple  — move, consume, gift, sell, lost. One bottle, one row.
 *             Applied optimistically; the user sees it immediately.
 *
 *   large   — creating a wine, an acquisition, multiple positions.
 *             Shown explicitly as PENDING until the server confirms, because
 *             presenting a twelve-bottle case as committed before validation
 *             would be a lie if the server then rejects a position.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/data/supabase-client";
import { getDeviceId, newId } from "@/data/device";
import type { Operation, OperationResult } from "@/data/sync/types";
import { classifyError } from "./repository";

export type MutationKind = "simple" | "large";

export interface MutationContext {
  cellarId: string;
  userId: string;
}

/** A mutation as the UI sees it. */
export interface PendingMutation {
  operationId: string;
  kind: MutationKind;
  entity: string;
  entityId: string;
  description: string;
  queuedAt: string;
}

export abstract class BaseRepository {
  protected readonly sb: SupabaseClient;

  constructor(
    protected readonly ctx: MutationContext,
    client?: SupabaseClient,
  ) {
    this.sb = client ?? getSupabase();
  }

  protected get cellarId(): string {
    return this.ctx.cellarId;
  }

  /** Build an operation for the sync queue. */
  protected operation(
    entity: string,
    entityId: string,
    type: Operation["type"],
    payload: unknown,
  ): Omit<Operation, "attempts" | "lastAttemptAt" | "lastError" | "status"> {
    return {
      operationId: newId(),
      entity,
      entityId,
      type,
      payload,
      clientTime: new Date().toISOString(),
      deviceId: getDeviceId(),
    };
  }

  /**
   * Call an RPC and classify the outcome for the sync engine.
   * Every domain write in the application passes through here.
   */
  protected async callRpc<T>(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: T | null; result: OperationResult["outcome"]; error?: string }> {
    const { data, error } = await this.sb.rpc(fn, args);

    if (error) {
      return {
        data: null,
        result: classifyError(error),
        error: error.message,
      };
    }
    return { data: data as T, result: "applied" };
  }

  /** Read helper. THROWS on failure — never returns [] to mean "could not load". */
  protected async read<T>(
    build: (sb: SupabaseClient) => PromiseLike<{ data: T | null; error: unknown }>,
  ): Promise<T> {
    const { data, error } = await build(this.sb);
    if (error) {
      const e = error as { message?: string };
      throw new Error(e.message ?? "Read failed");
    }
    if (data === null) {
      throw new Error("Read returned no data");
    }
    return data;
  }
}

/** Does this mutation warrant a PENDING indicator rather than optimism? */
export function mutationKind(
  entity: string,
  type: Operation["type"],
  payload?: unknown,
): MutationKind {
  if (entity === "acquisition") return "large";
  if (entity === "wine_definition" && type === "create") return "large";
  if (entity === "storage_layout" || entity === "storage_location") return "large";

  const p = payload as Record<string, unknown> | undefined;
  if (p && Array.isArray(p.positions) && p.positions.length > 1) return "large";

  return "simple";
}
