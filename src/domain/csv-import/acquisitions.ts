/**
 * Acquisition grouping for a CSV import.
 *
 * ── AN ACQUISITION IS A PURCHASE, NOT AN IMPORT ─────────────────────────
 * The bulk-import workbook is a cellar built up over years. Collapsing it into
 * one acquisition would record every bottle as bought on one day, from one
 * merchant, in one currency — none of which is true. So rows are grouped by
 * the strongest purchase identity the workbook actually carries:
 *
 *     (Purchase Date, Merchant / Source, Purchase Currency)
 *
 * NOT part of the key: price (one purchase holds wines at different prices),
 * quantity, and wine identity. Two purchases from the same merchant on the same
 * day in the same currency cannot be told apart from this data, and grouping
 * them is the truthful reading of it — no order number is invented.
 *
 * ── UNKNOWNS STAY UNKNOWN ────────────────────────────────────────────────
 * A blank date or merchant is part of the key AS BLANK. Rows are grouped only
 * where their known/unknown tuple matches exactly, so a row with no date never
 * inherits another row's date. Nothing is defaulted to make grouping work:
 * no import date, no "CSV import" merchant.
 *
 * ── THE ONE THING THE SCHEMA FORCES ──────────────────────────────────────
 * `acquisitions.currency` is `char(3) NOT NULL DEFAULT 'GBP'`. A group with no
 * priced row has no known currency, but the column cannot be empty, so the RPC
 * writes GBP. That is a label on NO money: every item in such a group has
 * `unit_price` NULL, and cost is only ever read from `unit_price`, so no GBP
 * cost can arise from it. A priced row always carries its own currency (a
 * price without one is blocked), so a priced group is never mislabelled.
 */

import type { ParsedRow } from "./parse";
import type { ImportPlan, PlannedItem } from "./plan";
import { stableOperationId } from "./plan";

export interface AcquisitionIdentity {
  purchasedOn: string | null;
  merchant: string | null;
  currency: string | null;
}

export function identityOf(row: ParsedRow): AcquisitionIdentity {
  return {
    purchasedOn: row.purchaseDate ?? null,
    // Exact, trimmed. "Merchant A" and "merchant a" stay distinct: merging
    // them would mean choosing one row's spelling for the other.
    merchant: row.purchaseSource?.trim() || null,
    currency: row.purchaseCurrency ?? null,
  };
}

/** A stable, order-independent key for an acquisition identity. */
export function groupKeyOf(row: ParsedRow): string {
  const id = identityOf(row);
  return JSON.stringify([id.purchasedOn, id.merchant, id.currency]);
}

export interface CurrencyCost {
  currency: string;
  /** Sum of unit price × quantity for PRICED items only. */
  amount: number;
  pricedBottles: number;
}

export interface PlannedAcquisition {
  key: string;
  identity: AcquisitionIdentity;
  /** Derived from the attempt and this group: a retry replays, never repeats. */
  operationId: string;
  /** `import:<file fingerprint>:<group fingerprint>` — detection, not idempotency. */
  reference: string;
  items: PlannedItem[];
  lineNumbers: number[];
  /** Priced cost in this group's single currency; null when nothing is priced. */
  cost: CurrencyCost | null;
  unpricedBottles: number;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The reference for one group.
 *
 * Every acquisition from one file shares the `import:<fileFingerprint>:`
 * prefix, which is what a later upload of the same file is detected by. The
 * group part makes each reference distinct and deterministic.
 */
export async function groupReference(
  fileFingerprint: string,
  key: string,
): Promise<string> {
  return `import:${fileFingerprint}:${(await sha256Hex(key)).slice(0, 16)}`;
}

/** The prefix a previous import of this exact file would carry. */
export const importReferencePrefix = (fileFingerprint: string) =>
  `import:${fileFingerprint}:`;

/** The logical action behind each group's stable operation id. */
export const acquisitionAction = (key: string) => `acquisition:${key}`;

/**
 * Split the plan's items into truthful acquisitions.
 *
 * Every item comes from exactly one row (the plan emits one item per row),
 * so row → group → item is exact. Groups are sorted by key, so the result —
 * and every operation id derived from it — is independent of row order.
 */
export async function planAcquisitions(args: {
  plan: ImportPlan;
  rows: ParsedRow[];
  attemptId: string;
  fileFingerprint: string;
}): Promise<PlannedAcquisition[]> {
  const rowByLine = new Map(args.rows.map((r) => [r.lineNumber, r]));
  const groups = new Map<string, { identity: AcquisitionIdentity; items: PlannedItem[] }>();

  for (const item of args.plan.items) {
    const row = rowByLine.get(item.lineNumber);
    if (!row) continue; // cannot happen: every item comes from a row
    const key = groupKeyOf(row);
    const g = groups.get(key) ?? { identity: identityOf(row), items: [] };
    g.items.push(item);
    groups.set(key, g);
  }

  const out: PlannedAcquisition[] = [];
  for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const priced = g.items.filter((i) => i.unitPrice !== null);
    const unpriced = g.items.filter((i) => i.unitPrice === null);

    out.push({
      key,
      identity: g.identity,
      operationId: await stableOperationId(args.attemptId, acquisitionAction(key)),
      reference: await groupReference(args.fileFingerprint, key),
      items: g.items,
      lineNumbers: g.items.map((i) => i.lineNumber).sort((a, b) => a - b),
      cost:
        priced.length > 0 && g.identity.currency
          ? {
              currency: g.identity.currency,
              amount:
                Math.round(
                  priced.reduce((n, i) => n + (i.unitPrice ?? 0) * i.quantity, 0) * 100,
                ) / 100,
              pricedBottles: priced.reduce((n, i) => n + i.quantity, 0),
            }
          : null,
      unpricedBottles: unpriced.reduce((n, i) => n + i.quantity, 0),
    });
  }
  return out;
}

export interface AcquisitionSummary {
  acquisitions: number;
  currencies: string[];
  /** One entry per currency. NEVER summed across currencies. */
  costByCurrency: CurrencyCost[];
  rowsWithUnknownDate: number;
  rowsWithUnknownMerchant: number;
  rowsWithUnknownPrice: number;
}

export function summariseAcquisitions(
  groups: PlannedAcquisition[],
  rows: ParsedRow[],
): AcquisitionSummary {
  const byCurrency = new Map<string, CurrencyCost>();
  for (const g of groups) {
    if (!g.cost) continue;
    const c = byCurrency.get(g.cost.currency) ?? {
      currency: g.cost.currency,
      amount: 0,
      pricedBottles: 0,
    };
    c.amount = Math.round((c.amount + g.cost.amount) * 100) / 100;
    c.pricedBottles += g.cost.pricedBottles;
    byCurrency.set(g.cost.currency, c);
  }

  const importable = rows.filter((r) => r.severity !== "invalid");
  return {
    acquisitions: groups.length,
    currencies: [...byCurrency.keys()].sort(),
    costByCurrency: [...byCurrency.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    rowsWithUnknownDate: importable.filter((r) => !r.purchaseDate).length,
    rowsWithUnknownMerchant: importable.filter((r) => !r.purchaseSource?.trim()).length,
    rowsWithUnknownPrice: importable.filter((r) => r.purchasePrice === null).length,
  };
}
