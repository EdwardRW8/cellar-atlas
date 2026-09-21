/**
 * Status transitions and acquisition-level fields for a CSV import.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────
 * A row marked Consumed or Removed must not become active inventory. The
 * bottles are created by `create_acquisition_with_items`, which generates
 * every item and bottle id on the server and returns ONLY the acquisition id.
 * `acquisition_items` has no line number, sequence or client reference. So
 * after the RPC, nothing records which CSV row produced which bottle.
 *
 * ── WHAT IS DETERMINISTIC ────────────────────────────────────────────────
 *   item → bottles    exact, via the bottles.acquisition_item_id FK
 *   row  → item       the plan emits exactly ONE item per row, and an item is
 *                     described by (wine, quantity, bottle size, unit price).
 *                     wineKey ↔ wine id is a bijection within an import.
 *
 * Rows sharing that signature are indistinguishable once written. That is
 * harmless when they share a status — every bottle in the group gets the same
 * one. It is unresolvable when they differ, and guessing would cross them.
 *
 * So:
 *   • same signature, same status   → mapped as a group, all bottles moved
 *   • same signature, mixed status  → BLOCKED before any write
 *   • after the RPC, the read-back is VERIFIED against the plan (item count
 *     and bottle count per signature). A mismatch changes nothing and is
 *     reported — it never falls back to a guess.
 *
 * No ordering, no "latest bottles", no timestamps are used as identity.
 */

import type { ParsedRow } from "./parse";
import { wineKey } from "./plan";
import { groupKeyOf } from "./acquisitions";

/** Statuses the importer can apply after the bottles exist. */
export const NON_ACTIVE_STATUSES = [
  "consumed",
  "gifted",
  "sold",
  "lost",
  "removed",
] as const;
export type NonActiveStatus = (typeof NON_ACTIVE_STATUSES)[number];

export function isNonActive(status: string): status is NonActiveStatus {
  return (NON_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * `change_bottle_status` refuses `removed` without a reason. The workbook has
 * no reason column, so the reason states provenance honestly rather than
 * inventing a cause.
 */
export const IMPORT_REMOVAL_REASON =
  "Recorded as removed in a CSV import; the file gave no reason.";

/** Money as integer pennies, so 42.5 and "42.50" compare equal. */
function pennies(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** What distinguishes one acquisition item from another once written. */
export function itemSignature(
  wine: string,
  quantity: number,
  bottleSize: string,
  unitPrice: number | string | null,
): string {
  return JSON.stringify([wine, quantity, bottleSize, pennies(unitPrice)]);
}

/**
 * What makes a row's bottles distinguishable once written: the acquisition
 * they land in, then the item signature within it. Rows in different
 * acquisitions never collide — each acquisition is read back on its own.
 */
function rowSignature(r: ParsedRow): string {
  return JSON.stringify([
    groupKeyOf(r),
    itemSignature(
      wineKey(r.producer, r.wineName, r.vintage),
      r.quantity,
      r.bottleSize,
      r.purchasePrice,
    ),
  ]);
}

function withIssue(r: ParsedRow, column: string, message: string): ParsedRow {
  if (r.issues.some((i) => i.message === message)) return r; // idempotent
  return {
    ...r,
    severity: "invalid",
    issues: [...r.issues, { column, severity: "invalid", message }],
  };
}

/**
 * Block rows whose bottles could not be told apart once written.
 *
 * Idempotent, and pure: returns new rows, never mutates.
 */
export function markStatusConflicts(rows: ParsedRow[]): ParsedRow[] {
  const groups = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    if (r.severity === "invalid") continue;
    const key = rowSignature(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const conflicted = new Set<number>();
  for (const group of groups.values()) {
    if (new Set(group.map((r) => r.status)).size > 1) {
      for (const r of group) conflicted.add(r.lineNumber);
    }
  }

  return rows.map((r) => {
    if (!conflicted.has(r.lineNumber)) return r;
    const others = [...groups.get(rowSignature(r))!]
      .filter((o) => o.lineNumber !== r.lineNumber)
      .map((o) => o.lineNumber);
    return withIssue(
      r,
      "Status",
      `Rows ${[r.lineNumber, ...others].sort((a, b) => a - b).join(", ")} describe ` +
        `identical bottles with different statuses. Once imported they cannot ` +
        `be told apart, so one could be marked in the wrong state. Import ` +
        `these rows in separate files.`,
    );
  });
}

/**
 * Every pre-write check this module owns.
 *
 * The former whole-file currency block is GONE: with one acquisition per
 * purchase identity, GBP and EUR purchases become separate acquisitions and a
 * mixed-currency file is valid. Currency is still required for any priced row
 * — that check lives in the parser.
 */
export function applyImportIntegrityChecks(rows: ParsedRow[]): ParsedRow[] {
  return markStatusConflicts(rows);
}

// ── AFTER THE RPC: VERIFIED RESOLUTION ────────────────────────────────────

export interface PlannedStatusItem {
  lineNumber: number;
  wineId: string;
  quantity: number;
  bottleSize: string;
  unitPrice: number | null;
  status: string;
}

export interface CreatedItem {
  id: string;
  wineDefinitionId: string;
  quantity: number;
  bottleSize: string;
  unitPrice: number | string | null;
}

export interface CreatedBottle {
  id: string;
  version: number;
  status: string;
  acquisitionItemId: string;
}

export interface StatusTarget {
  bottleId: string;
  version: number;
  status: NonActiveStatus;
  lineNumbers: number[];
  reason?: string;
}

export interface StatusResolution {
  targets: StatusTarget[];
  failures: { lineNumbers: number[]; message: string }[];
}

/**
 * Work out exactly which bottles to move, from what the database says was
 * created.
 *
 * Verifies, per signature, that the database holds the same number of items
 * and bottles the plan intended. Any mismatch moves NOTHING for that group
 * and is reported — the bottles stay as created and the user is told.
 */
export function resolveStatusTargets(args: {
  planned: PlannedStatusItem[];
  created: CreatedItem[];
  bottles: CreatedBottle[];
}): StatusResolution {
  const targets: StatusTarget[] = [];
  const failures: StatusResolution["failures"] = [];

  const plannedBySig = new Map<string, PlannedStatusItem[]>();
  for (const p of args.planned) {
    const key = itemSignature(p.wineId, p.quantity, p.bottleSize, p.unitPrice);
    plannedBySig.set(key, [...(plannedBySig.get(key) ?? []), p]);
  }

  const createdBySig = new Map<string, CreatedItem[]>();
  for (const c of args.created) {
    const key = itemSignature(c.wineDefinitionId, c.quantity, c.bottleSize, c.unitPrice);
    createdBySig.set(key, [...(createdBySig.get(key) ?? []), c]);
  }

  const bottlesByItem = new Map<string, CreatedBottle[]>();
  for (const b of args.bottles) {
    bottlesByItem.set(b.acquisitionItemId, [
      ...(bottlesByItem.get(b.acquisitionItemId) ?? []),
      b,
    ]);
  }

  for (const [sig, group] of plannedBySig) {
    const statuses = new Set(group.map((p) => p.status));
    const lineNumbers = group.map((p) => p.lineNumber).sort((a, b) => a - b);

    if (statuses.size > 1) {
      // Should have been blocked before writing. Refuse rather than guess.
      failures.push({
        lineNumbers,
        message: "Identical bottles with different statuses — nothing was changed.",
      });
      continue;
    }

    const status = [...statuses][0]!;
    if (!isNonActive(status)) continue; // in_cellar: the bottles stay as created

    const items = createdBySig.get(sig) ?? [];
    const bottles = items.flatMap((i) => bottlesByItem.get(i.id) ?? []);
    const expectedBottles = group.reduce((n, p) => n + p.quantity, 0);

    if (items.length !== group.length || bottles.length !== expectedBottles) {
      failures.push({
        lineNumbers,
        message:
          `Expected ${expectedBottles} bottle${expectedBottles === 1 ? "" : "s"} ` +
          `from ${group.length} row${group.length === 1 ? "" : "s"}, found ` +
          `${bottles.length}. Their status was not changed, so they are in the ` +
          `cellar as active bottles.`,
      });
      continue;
    }

    for (const b of bottles) {
      targets.push({
        bottleId: b.id,
        version: b.version,
        status,
        lineNumbers,
        ...(status === "removed" ? { reason: IMPORT_REMOVAL_REASON } : {}),
      });
    }
  }

  // Deterministic order for stable operation ids and stable reporting.
  targets.sort((a, b) => a.bottleId.localeCompare(b.bottleId));
  return { targets, failures };
}

/** The logical action behind each status change's stable operation id. */
export function statusAction(bottleId: string): string {
  return `status:${bottleId}`;
}
