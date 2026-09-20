/**
 * Every domain mutation the application can perform.
 *
 * All ten user actions plus wine creation and correction, each mapping to
 * exactly one RPC. There is no path here that writes to a table directly —
 * a lint rule and a test both enforce that for `src/features/`.
 *
 * Each method returns the operation it queued, so the UI can show PENDING
 * for large transactions and resolve conflicts against the right operation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { BaseRepository, mutationKind, type MutationKind } from "./base";
import type { MutationContext } from "./base";
import type { Operation } from "@/data/sync/types";
import { getDeviceId, newId } from "@/data/device";
import type { CommitPayload } from "@/domain/wine-draft";

export interface MutationOutcome {
  ok: boolean;
  kind: MutationKind;
  operationId: string;
  entityId: string | null;
  /** Set when the server rejected it outright. */
  error?: string;
  /** True when another device changed the row first. */
  conflict?: boolean;
}

export class MutationRepository extends BaseRepository {
  constructor(ctx: MutationContext, client?: SupabaseClient) {
    super(ctx, client);
  }

  // ── ADD WINE ────────────────────────────────────────────────────────────

  /**
   * Commit a WineDraft.
   *
   * Creates the wine definition if needed, then the acquisition, its items,
   * every bottle and every event — under ONE operation id, in ONE
   * transaction. A retry after a dropped connection produces the same
   * bottles, not twice as many.
   *
   * Always a LARGE mutation: shown as PENDING until the server confirms,
   * because a rejected position must not appear as a committed case.
   */
  async commitDraft(payload: CommitPayload): Promise<MutationOutcome> {
    const opId = newId();

    let wineId = payload.wineDefinitionId;

    if (payload.wine) {
      const wineOp = newId();
      const created = await this.callRpc<string>("create_wine_definition", {
        p_operation_id: wineOp,
        p_cellar_id: this.cellarId,
        p_wine: payload.wine,
        p_device_id: this.deviceId(),
      });
      if (created.result !== "applied" && created.result !== "duplicate") {
        return {
          ok: false,
          kind: "large",
          operationId: wineOp,
          entityId: null,
          error: created.error,
          conflict: created.result === "conflict",
        };
      }
      wineId = created.data;
    }

    if (!wineId) {
      return {
        ok: false,
        kind: "large",
        operationId: opId,
        entityId: null,
        error: "No wine to attach bottles to",
      };
    }

    const items = payload.items.map((i) => ({ ...i, wine_definition_id: wineId }));

    const res = await this.callRpc<string>("create_acquisition_with_items", {
      p_operation_id: opId,
      p_cellar_id: this.cellarId,
      p_acquisition: payload.acquisition,
      p_items: items,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "large",
      operationId: opId,
      entityId: res.data ?? null,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  // ── BOTTLE ACTIONS ──────────────────────────────────────────────────────

  /** Move a bottle. `delivered` when coming from external storage to home. */
  async moveBottle(args: {
    bottleId: string;
    version: number;
    locationId: string;
    position: Record<string, number> | null;
    isDelivery?: boolean;
    notes?: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("move_bottle", {
      p_operation_id: opId,
      p_bottle_id: args.bottleId,
      p_expected_version: args.version,
      p_location_id: args.locationId,
      p_position: args.position,
      p_event_type: args.isDelivery ? "delivered" : "moved",
      p_notes: args.notes ?? null,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.bottleId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /** Consume, gift, sell, mark lost, or remove an erroneous record. */
  async changeStatus(args: {
    bottleId: string;
    version: number;
    status: "consumed" | "gifted" | "sold" | "lost" | "removed";
    occurredAt?: string;
    reason?: string;
    notes?: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("change_bottle_status", {
      p_operation_id: opId,
      p_bottle_id: args.bottleId,
      p_expected_version: args.version,
      p_status: args.status,
      p_occurred_at: args.occurredAt ?? new Date().toISOString(),
      p_reason: args.reason ?? null,
      p_notes: args.notes ?? null,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.bottleId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /**
   * Correct a mistaken record.
   *
   * Passes the SAME invariants as any other mutation — geometry validated,
   * slot uniqueness enforced, statuses checked. It records why, it does not
   * bypass validation.
   */
  async correctBottle(args: {
    bottleId: string;
    version: number;
    reason: string;
    patch: Record<string, unknown>;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("correct_bottle", {
      p_operation_id: opId,
      p_bottle_id: args.bottleId,
      p_expected_version: args.version,
      p_reason: args.reason,
      p_patch: args.patch,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: mutationKind("bottle", "update", args.patch),
      operationId: opId,
      entityId: args.bottleId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  // ── WINE ────────────────────────────────────────────────────────────────

  async updateWine(args: {
    wineId: string;
    version: number;
    patch: Record<string, unknown>;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("update_wine_definition", {
      p_operation_id: opId,
      p_wine_id: args.wineId,
      p_expected_version: args.version,
      p_patch: args.patch,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.wineId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  // ── TASTING & VALUATION ─────────────────────────────────────────────────

  async recordTasting(args: {
    wineId: string;
    bottleId?: string;
    bottleEventId?: string;
    rating?: number;
    notes?: string;
    tastedOn?: string;
    context?: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<string>("record_tasting", {
      p_operation_id: opId,
      p_cellar_id: this.cellarId,
      p_tasting: {
        wine_definition_id: args.wineId,
        bottle_id: args.bottleId ?? null,
        bottle_event_id: args.bottleEventId ?? null,
        rating: args.rating ?? null,
        notes: args.notes ?? null,
        tasted_on: args.tastedOn ?? null,
        context: args.context ?? null,
      },
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: res.data ?? null,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  async recordValuation(args: {
    wineId?: string;
    bottleId?: string;
    amount: number;
    currency?: string;
    basis:
      | "market_estimate"
      | "merchant_retail"
      | "auction_estimate"
      | "realised_sale"
      | "manual_estimate";
    source?: "manual" | "merchant" | "auction_house" | "api" | "import";
    valuedOn?: string;
    notes?: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<string>("record_valuation", {
      p_operation_id: opId,
      p_cellar_id: this.cellarId,
      p_valuation: {
        wine_definition_id: args.wineId ?? null,
        bottle_id: args.bottleId ?? null,
        amount: args.amount,
        currency: args.currency ?? "GBP",
        valuation_basis: args.basis,
        source: args.source ?? "manual",
        valued_on: args.valuedOn ?? null,
        notes: args.notes ?? null,
      },
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: res.data ?? null,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  // ── STORAGE ─────────────────────────────────────────────────────────────

  /**
   * Create a storage layout of ANY type. Nothing here favours a staircase —
   * the caller supplies the type and its config, and the database derives
   * capacity from that config.
   */
  async createLayout(args: {
    name: string;
    type: "staircase" | "grid" | "shelving" | "fridge" | "unpositioned" | "external";
    config: Record<string, unknown>;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<string>("create_storage_layout", {
      p_operation_id: opId,
      p_cellar_id: this.cellarId,
      p_name: args.name,
      p_type: args.type,
      p_config: args.config,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "large",
      operationId: opId,
      entityId: res.data ?? null,
      error: res.error,
    };
  }

  async createLocation(args: {
    name: string;
    kind: "home" | "merchant" | "fridge" | "other";
    layoutId?: string | null;
    isExternal?: boolean;
    merchantReference?: string | null;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<string>("create_storage_location", {
      p_operation_id: opId,
      p_cellar_id: this.cellarId,
      p_name: args.name,
      p_kind: args.kind,
      p_layout_id: args.layoutId ?? null,
      p_is_external: args.isExternal ?? false,
      p_merchant_ref: args.merchantReference ?? null,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "large",
      operationId: opId,
      entityId: res.data ?? null,
      error: res.error,
    };
  }

  /**
   * Rename or reorder a storage location. Geometry lives on the layout, so
   * this never affects positions.
   */
  async updateLocation(args: {
    locationId: string;
    version: number;
    patch: Record<string, unknown>;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("update_storage_location", {
      p_operation_id: opId,
      p_location_id: args.locationId,
      p_expected_version: args.version,
      p_patch: args.patch,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.locationId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /**
   * Rename a layout, or change its geometry.
   *
   * The server re-validates EVERY occupied position against the proposed
   * config and refuses if any would become invalid — capacity comparison
   * alone would miss a same-size reshape that orphans bottles.
   */
  async updateLayout(args: {
    layoutId: string;
    version: number;
    patch: { name?: string; type?: string; config?: Record<string, unknown> };
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("update_storage_layout", {
      p_operation_id: opId,
      p_layout_id: args.layoutId,
      p_expected_version: args.version,
      p_patch: args.patch,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "large",
      operationId: opId,
      entityId: args.layoutId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /**
   * Soft delete a storage location.
   *
   * Refused while any live bottle is assigned to it. The row is never
   * physically removed, so history survives.
   */
  async deleteLocation(args: {
    locationId: string;
    version: number;
    reason: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("soft_delete_storage_location", {
      p_operation_id: opId,
      p_location_id: args.locationId,
      p_expected_version: args.version,
      p_reason: args.reason,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.locationId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /** Soft delete a layout. Refused while any live location uses it. */
  async deleteLayout(args: {
    layoutId: string;
    version: number;
    reason: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("soft_delete_storage_layout", {
      p_operation_id: opId,
      p_layout_id: args.layoutId,
      p_expected_version: args.version,
      p_reason: args.reason,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.layoutId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /**
   * Save the cellar's behavioural profile.
   *
   * Uses the EXISTING `upsert_cellar_profile` RPC, unchanged since Phase 2.
   * No new mutation, no new write architecture, no RLS change — the RPC is
   * SECURITY INVOKER, so owner-only write policy applies as it always has.
   *
   * NOTE: `favourite_regions` and `currency` are columns on the table that
   * the RPC does not write. They are deliberately not exposed rather than
   * offered and silently dropped.
   */
  async upsertProfile(profile: Record<string, unknown>): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<string>("upsert_cellar_profile", {
      p_operation_id: opId,
      p_cellar_id: this.cellarId,
      p_profile: profile,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: res.data ?? null,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /**
   * Correct a tasting note.
   *
   * Only the subjective fields are writable — rating, notes, date, context.
   * The wine and bottle are fixed: silently reattaching a memory to a
   * different wine would be worse than requiring a delete and re-record.
   *
   * The `tasting_recorded` bottle_event is NOT touched. That you tasted the
   * bottle remains true regardless of later edits to the note.
   */
  async updateTasting(args: {
    tastingId: string;
    version: number;
    patch: {
      rating?: number | null;
      notes?: string | null;
      tasted_on?: string;
      context?: string | null;
    };
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("update_tasting_record", {
      p_operation_id: opId,
      p_tasting_id: args.tastingId,
      p_expected_version: args.version,
      p_patch: args.patch,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.tastingId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /** Soft delete a tasting. The row survives, so history keeps a valid target. */
  async deleteTasting(args: {
    tastingId: string;
    version: number;
    reason: string;
  }): Promise<MutationOutcome> {
    const opId = newId();
    const res = await this.callRpc<null>("soft_delete_tasting_record", {
      p_operation_id: opId,
      p_tasting_id: args.tastingId,
      p_expected_version: args.version,
      p_reason: args.reason,
      p_device_id: this.deviceId(),
    });

    return {
      ok: res.result === "applied" || res.result === "duplicate",
      kind: "simple",
      operationId: opId,
      entityId: args.tastingId,
      error: res.error,
      conflict: res.result === "conflict",
    };
  }

  /**
   * Deliver several bottles at once.
   *
   * A merchant order arriving is ONE real-world event but N bottle moves.
   * Each is an independent `move_bottle` call with its own operation id, so a
   * partial failure leaves the successful moves applied and the rest
   * retryable — never a silent half-success.
   *
   * No new RPC: this composes the existing one.
   */
  async deliverBottles(
    bottles: { id: string; version: number }[],
    destinationId: string,
    positions?: (Record<string, number> | null)[],
  ): Promise<{
    delivered: string[];
    failed: { bottleId: string; error: string }[];
    outcomes: MutationOutcome[];
  }> {
    const delivered: string[] = [];
    const failed: { bottleId: string; error: string }[] = [];
    const outcomes: MutationOutcome[] = [];

    for (const [i, b] of bottles.entries()) {
      const outcome = await this.moveBottle({
        bottleId: b.id,
        version: b.version,
        locationId: destinationId,
        position: positions?.[i] ?? null,
        isDelivery: true,
      });

      outcomes.push(outcome);
      if (outcome.ok) {
        delivered.push(b.id);
      } else {
        failed.push({
          bottleId: b.id,
          error: outcome.error ?? "Could not deliver this bottle",
        });
      }
    }

    return { delivered, failed, outcomes };
  }

  // ── CONFLICT RESOLUTION ─────────────────────────────────────────────────

  /**
   * Submit a rebased operation.
   *
   * It carries a NEW operation id and the CURRENT server version, and still
   * goes through the normal version check. If a third change landed in the
   * meantime it conflicts again — which is correct, not a failure.
   */
  async submitRebased(op: Operation): Promise<MutationOutcome> {
    const p = op.payload as Record<string, unknown>;
    const version = p.version as number;

    if (p.status) {
      return this.changeStatus({
        bottleId: op.entityId,
        version,
        status: p.status as "consumed",
        reason: p.reason as string | undefined,
      });
    }

    if (p.storage_location_id !== undefined || p.position !== undefined) {
      return this.moveBottle({
        bottleId: op.entityId,
        version,
        locationId: p.storage_location_id as string,
        position: (p.position as Record<string, number> | null) ?? null,
      });
    }

    return this.updateWine({ wineId: op.entityId, version, patch: p });
  }

  private deviceId(): string {
    return getDeviceId();
  }
}
