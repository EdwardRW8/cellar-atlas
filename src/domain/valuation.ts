/**
 * Valuation currency mapping.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 * `bottles.current_value` is a denormalised cache with NO currency column.
 * Currency lives only on `valuation_records`. So to know what currency a
 * bottle's cached value is in, the cache has to be traced back to the ledger
 * row that wrote it.
 *
 * That is not simply "the latest record with this bottle_id". `record_valuation`
 * can target a WINE, in which case it updates every `in_cellar` bottle of that
 * wine and writes ONE ledger row carrying no bottle_id at all. Matching on
 * bottle_id alone would find nothing for those bottles and silently lose the
 * currency.
 *
 * ── THE MAPPING ──────────────────────────────────────────────────────────
 * `record_valuation` runs as a single transaction, and Postgres `now()` is
 * transaction-stable, so the bottle update and the ledger insert receive the
 * identical timestamp:
 *
 *     bottles.current_value_at  ===  valuation_records.created_at
 *
 * Verified empirically against a real Postgres engine, including the case of a
 * wine-level valuation with one bottle later overridden individually.
 *
 * ── PRECEDENCE AND HONESTY ───────────────────────────────────────────────
 * A bottle-level record beats a wine-level one at the same instant. If two
 * records still tie at the same precedence, the currency is UNKNOWN — the
 * bottle is excluded from monetary totals rather than being attributed to a
 * guess. No valuation at all is likewise unknown, never zero.
 */

/**
 * A timestamp as it arrives from a driver: an ISO string, a Date, or absent.
 *
 * The Supabase client returns ISO strings; node-postgres and PGlite return
 * `Date` objects. Neither can be compared with `===` safely — two Dates are
 * never strictly equal, and ISO strings differ cosmetically ("+00:00" versus
 * "Z", trimmed fractional digits) while denoting the same instant.
 */
export type TimestampLike = string | Date | null | undefined;

/**
 * A timestamp reduced to a comparable instant, in epoch milliseconds.
 *
 * ── ON PRECISION ─────────────────────────────────────────────────────────
 * Postgres `timestamptz` holds microseconds; this truncates to milliseconds.
 * Two distinct valuations could only collide if they landed in the same
 * millisecond, which separate user-initiated transactions cannot do. And if
 * one ever did, the mapping reports AMBIGUOUS and excludes the bottle rather
 * than guessing — so the failure mode is honest either way.
 */
export function toInstant(value: TimestampLike): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A timestamp in the canonical form used for query filters. */
export function toIsoString(value: TimestampLike): string | null {
  const ms = toInstant(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** A bottle, reduced to what the mapping needs. */
export interface ValuableBottle {
  id: string;
  wineDefinitionId: string;
  currentValue: number | null;
  /** The timestamp that joins this bottle to the ledger row that valued it. */
  currentValueAt: TimestampLike;
}

/** A row from `valuation_records`. */
export interface ValuationLedgerRow {
  id: string;
  bottleId: string | null;
  wineDefinitionId: string | null;
  /** Null when unreadable. Never defaulted to the app currency. */
  currency: string | null;
  amount: number;
  valuationBasis: string;
  source: string;
  createdAt: TimestampLike;
}

export type UnknownReason =
  | "no-valuation"
  /** The cache points at a ledger row that could not be read or found. */
  | "unmatched"
  /** Two equally specific records claim the same instant. */
  | "ambiguous";

export interface ResolvedValuation {
  bottleId: string;
  currency: string;
  amount: number;
  valuationBasis: string;
  source: string;
  valuationId: string;
  valuedAt: string;
}

export interface UnresolvedValuation {
  bottleId: string;
  currency: null;
  reason: UnknownReason;
}

export type BottleValuation = ResolvedValuation | UnresolvedValuation;

export function isResolved(v: BottleValuation): v is ResolvedValuation {
  return v.currency !== null;
}

/**
 * Timestamps that need looking up.
 *
 * Bounded by the number of DISTINCT valuation moments still current —
 * typically one per wine, not one per bottle. That is what keeps the lookup to
 * a single query regardless of cellar size.
 */
export function distinctValuationTimestamps(bottles: ValuableBottle[]): string[] {
  const seen = new Set<string>();
  for (const b of bottles) {
    // Canonical ISO, so cosmetically different inputs collapse to one entry.
    const iso = toIsoString(b.currentValueAt);
    if (iso) seen.add(iso);
  }
  return [...seen];
}

/**
 * Does a ledger row explain this bottle's cached value?
 *
 * Exported so the fallback read path can filter client-side with exactly the
 * same rule the primary path relies on.
 */
export function rowMatchesBottle(row: ValuationLedgerRow, bottle: ValuableBottle): boolean {
  const bottleAt = toInstant(bottle.currentValueAt);
  const rowAt = toInstant(row.createdAt);
  // Compare INSTANTS, never the serialised values. Two Date objects are never
  // strictly equal, and ISO strings differ cosmetically for the same moment.
  if (bottleAt === null || rowAt === null) return false;
  if (rowAt !== bottleAt) return false;
  if (row.bottleId !== null) return row.bottleId === bottle.id;
  return row.wineDefinitionId === bottle.wineDefinitionId;
}

/**
 * Resolve each bottle's valuation currency.
 *
 * Pure: takes bottles and ledger rows, returns a map. No I/O, no assumptions
 * about how the rows were fetched.
 */
export function mapValuationCurrencies(
  bottles: ValuableBottle[],
  rows: ValuationLedgerRow[],
): Map<string, BottleValuation> {
  const result = new Map<string, BottleValuation>();

  for (const bottle of bottles) {
    // No cached value, or no timestamp to trace: nothing is known. Not zero.
    if (bottle.currentValue === null || toInstant(bottle.currentValueAt) === null) {
      result.set(bottle.id, {
        bottleId: bottle.id,
        currency: null,
        reason: "no-valuation",
      });
      continue;
    }

    const candidates = rows.filter((r) => rowMatchesBottle(r, bottle));

    if (candidates.length === 0) {
      // The cache points at a row we could not read. Say so rather than
      // inventing a currency.
      result.set(bottle.id, {
        bottleId: bottle.id,
        currency: null,
        reason: "unmatched",
      });
      continue;
    }

    // A bottle-level record is more specific than a wine-level one and wins.
    const bottleLevel = candidates.filter((r) => r.bottleId !== null);
    const preferred = bottleLevel.length > 0 ? bottleLevel : candidates;

    if (preferred.length > 1) {
      // Still tied at the same specificity. Refuse to choose.
      result.set(bottle.id, {
        bottleId: bottle.id,
        currency: null,
        reason: "ambiguous",
      });
      continue;
    }

    const row = preferred[0]!;

    if (row.currency === null) {
      // A value whose currency cannot be established is not a usable amount.
      result.set(bottle.id, {
        bottleId: bottle.id,
        currency: null,
        reason: "unmatched",
      });
      continue;
    }

    result.set(bottle.id, {
      bottleId: bottle.id,
      currency: row.currency,
      amount: row.amount,
      valuationBasis: row.valuationBasis,
      source: row.source,
      valuationId: row.id,
      valuedAt: toIsoString(row.createdAt)!,
    });
  }

  return result;
}

/**
 * Which distinct currencies are actually in play?
 *
 * The caller uses this to decide whether a single monetary total is legitimate
 * at all. More than one means the totals must never be combined.
 */
export function distinctCurrencies(valuations: Map<string, BottleValuation>): string[] {
  const seen = new Set<string>();
  for (const v of valuations.values()) {
    if (isResolved(v)) seen.add(v.currency);
  }
  return [...seen].sort();
}

/**
 * Did the primary lookup return every timestamp it asked for?
 *
 * If PostgREST does not round-trip `timestamptz` precisely through an `in`
 * filter, rows go missing silently and bottles would be reported as
 * "unmatched" when their data is perfectly fine. Checking coverage turns that
 * silent data loss into a detectable condition the read path can recover from.
 */
export function coversAllTimestamps(
  requested: string[],
  rows: ValuationLedgerRow[],
): boolean {
  if (requested.length === 0) return true;
  const returned = new Set(rows.map((r) => toInstant(r.createdAt)));
  return requested.every((t) => returned.has(toInstant(t)));
}

// ═══════════════════════════════════════════════════════════════════════════
// HOLDING VALUATION
//
// ── THE RULE THAT SHAPES ALL OF THIS ─────────────────────────────────────
// Absence is never zero, and currencies are never combined.
//
// A cellar where one bottle is valued at £400 and forty are unvalued is not
// worth £400. It is worth "£400 across 1 of 41 bottles" — a different and
// honest statement. Likewise a holding costed in EUR and valued in GBP has no
// single gain figure, and inventing one by applying a rate we do not have
// would be worse than saying so.
// ═══════════════════════════════════════════════════════════════════════════

/** An active bottle's acquisition cost, or why there isn't one. */
export interface BottleCost {
  bottleId: string;
  unitPrice: number;
  currency: string;
}

export type CostReason =
  /** No acquisition item is linked. The FK is `on delete set null`, so this
   *  covers both "never recorded" and "link since severed" — indistinguishable
   *  without a schema change, and unknown either way. */
  | "unlinked"
  /** Linked, but the line carries no unit price. */
  | "no-price";

export interface UnknownCost {
  bottleId: string;
  unitPrice: null;
  reason: CostReason;
}

export type BottleCostResult = BottleCost | UnknownCost;

export function hasCost(c: BottleCostResult): c is BottleCost {
  return c.unitPrice !== null;
}

/** An acquisition line, reduced to what costing needs. */
export interface AcquisitionCost {
  itemId: string;
  unitPrice: number | null;
  /**
   * Inherited from the parent acquisition; `acquisition_items` has none.
   * Null when unreadable — never defaulted.
   */
  currency: string | null;
}

/** Resolve each bottle's acquisition cost. */
export function mapBottleCosts(
  bottles: { id: string; acquisitionItemId: string | null }[],
  costs: Map<string, AcquisitionCost>,
): Map<string, BottleCostResult> {
  const result = new Map<string, BottleCostResult>();

  for (const b of bottles) {
    if (!b.acquisitionItemId) {
      result.set(b.id, { bottleId: b.id, unitPrice: null, reason: "unlinked" });
      continue;
    }
    const cost = costs.get(b.acquisitionItemId);
    if (!cost || cost.unitPrice === null || cost.currency === null) {
      // A price with no known currency cannot be summed or compared.
      result.set(b.id, { bottleId: b.id, unitPrice: null, reason: "no-price" });
      continue;
    }
    result.set(b.id, {
      bottleId: b.id,
      unitPrice: cost.unitPrice,
      currency: cost.currency,
    });
  }

  return result;
}

// ── MONEY TOTALS ──────────────────────────────────────────────────────────

export interface CurrencyTotal {
  currency: string;
  amount: number;
  bottles: number;
}

export interface MoneyTotals {
  /** One entry per currency present. Never summed across entries. */
  byCurrency: CurrencyTotal[];
  /** Bottles contributing an amount. */
  present: number;
  /** Bottles with nothing recorded — counted, never valued at zero. */
  absent: number;
  total: number;
  /** More than one currency: a single monetary figure is not legitimate. */
  isMixed: boolean;
  /** The only currency, when there is exactly one. Null when mixed or empty. */
  single: CurrencyTotal | null;
}

function buildTotals(
  entries: { currency: string; amount: number }[],
  absent: number,
): MoneyTotals {
  const grouped = new Map<string, CurrencyTotal>();
  for (const e of entries) {
    const existing = grouped.get(e.currency);
    if (existing) {
      existing.amount = round2(existing.amount + e.amount);
      existing.bottles += 1;
    } else {
      grouped.set(e.currency, {
        currency: e.currency,
        amount: round2(e.amount),
        bottles: 1,
      });
    }
  }

  const byCurrency = [...grouped.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );

  return {
    byCurrency,
    present: entries.length,
    absent,
    total: entries.length + absent,
    isMixed: byCurrency.length > 1,
    single: byCurrency.length === 1 ? byCurrency[0]! : null,
  };
}

/** Acquisition cost across a set of bottles. */
export function holdingCost(
  bottleIds: string[],
  costs: Map<string, BottleCostResult>,
): MoneyTotals {
  const entries: { currency: string; amount: number }[] = [];
  let absent = 0;

  for (const id of bottleIds) {
    const c = costs.get(id);
    if (c && hasCost(c)) {
      entries.push({ currency: c.currency, amount: c.unitPrice });
    } else {
      absent += 1;
    }
  }

  return buildTotals(entries, absent);
}

/** Current valuation across a set of bottles. */
export function holdingValue(
  bottleIds: string[],
  valuations: Map<string, BottleValuation>,
): MoneyTotals {
  const entries: { currency: string; amount: number }[] = [];
  let absent = 0;

  for (const id of bottleIds) {
    const v = valuations.get(id);
    if (v && isResolved(v)) {
      entries.push({ currency: v.currency, amount: v.amount });
    } else {
      absent += 1;
    }
  }

  return buildTotals(entries, absent);
}

// ── GAIN ──────────────────────────────────────────────────────────────────

export type GainReason =
  | "no-valuation"
  | "no-cost"
  /** Cost and valuation exist but in different currencies, and no rate is
   *  available. Comparing them would fabricate a number. */
  | "currency-mismatch";

export interface BottleGain {
  bottleId: string;
  currency: string;
  cost: number;
  value: number;
  gain: number;
  /** Null when cost is zero — a percentage would divide by nothing. */
  percent: number | null;
}

export interface UnknownGain {
  bottleId: string;
  gain: null;
  reason: GainReason;
}

export type BottleGainResult = BottleGain | UnknownGain;

export function hasGain(g: BottleGainResult): g is BottleGain {
  return (g as BottleGain).gain !== null && "currency" in g;
}

/**
 * One bottle's unrealised gain.
 *
 * Requires cost AND valuation in the SAME currency. Anything else returns a
 * reason, never a number.
 */
export function bottleGain(
  bottleId: string,
  cost: BottleCostResult | undefined,
  valuation: BottleValuation | undefined,
): BottleGainResult {
  if (!valuation || !isResolved(valuation)) {
    return { bottleId, gain: null, reason: "no-valuation" };
  }
  if (!cost || !hasCost(cost)) {
    return { bottleId, gain: null, reason: "no-cost" };
  }
  if (cost.currency !== valuation.currency) {
    return { bottleId, gain: null, reason: "currency-mismatch" };
  }

  const gain = round2(valuation.amount - cost.unitPrice);
  return {
    bottleId,
    currency: cost.currency,
    cost: cost.unitPrice,
    value: valuation.amount,
    gain,
    percent: cost.unitPrice === 0 ? null : round1((gain / cost.unitPrice) * 100),
  };
}

export interface CurrencyGain {
  currency: string;
  cost: number;
  value: number;
  gain: number;
  percent: number | null;
  comparableBottles: number;
}

export interface HoldingGain {
  /** One entry per currency. Never summed across entries. */
  byCurrency: CurrencyGain[];
  /** Bottles with cost and valuation in a matching currency. */
  comparableBottles: number;
  totalActiveBottles: number;
  isMixed: boolean;
  /** Why the remaining bottles were left out. */
  excluded: { noCost: number; noValuation: number; currencyMismatch: number };
}

/**
 * Unrealised gain across a holding.
 *
 * Computed ONLY over bottles carrying both a cost and a valuation in the same
 * currency. A holding where different bottles are missing different halves
 * cannot be summed across, and the comparable count travels with the figure so
 * the UI can say exactly what it covers.
 */
export function holdingGain(
  bottleIds: string[],
  costs: Map<string, BottleCostResult>,
  valuations: Map<string, BottleValuation>,
): HoldingGain {
  const grouped = new Map<string, CurrencyGain>();
  const excluded = { noCost: 0, noValuation: 0, currencyMismatch: 0 };

  for (const id of bottleIds) {
    const g = bottleGain(id, costs.get(id), valuations.get(id));

    if (!hasGain(g)) {
      if (g.reason === "no-cost") excluded.noCost += 1;
      else if (g.reason === "no-valuation") excluded.noValuation += 1;
      else excluded.currencyMismatch += 1;
      continue;
    }

    const existing = grouped.get(g.currency);
    if (existing) {
      existing.cost = round2(existing.cost + g.cost);
      existing.value = round2(existing.value + g.value);
      existing.gain = round2(existing.gain + g.gain);
      existing.comparableBottles += 1;
    } else {
      grouped.set(g.currency, {
        currency: g.currency,
        cost: g.cost,
        value: g.value,
        gain: g.gain,
        percent: null,
        comparableBottles: 1,
      });
    }
  }

  // Percentage uses the SAME subset as the absolute gain, and is suppressed
  // when there is no denominator.
  const byCurrency = [...grouped.values()]
    .map((c) => ({
      ...c,
      percent: c.cost === 0 ? null : round1((c.gain / c.cost) * 100),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    byCurrency,
    comparableBottles: byCurrency.reduce((n, c) => n + c.comparableBottles, 0),
    totalActiveBottles: bottleIds.length,
    isMixed: byCurrency.length > 1,
    excluded,
  };
}

export interface HoldingValuation {
  cost: MoneyTotals;
  value: MoneyTotals;
  gain: HoldingGain;
  activeBottles: number;
}

/** Everything a holding panel needs, in one pass. */
export function holdingValuation(
  bottleIds: string[],
  costs: Map<string, BottleCostResult>,
  valuations: Map<string, BottleValuation>,
): HoldingValuation {
  return {
    cost: holdingCost(bottleIds, costs),
    value: holdingValue(bottleIds, valuations),
    gain: holdingGain(bottleIds, costs, valuations),
    activeBottles: bottleIds.length,
  };
}

/** "9 of 14 valued" — the completeness caption. */
export function describeCompleteness(t: MoneyTotals, noun: string): string {
  return `${t.present} of ${t.total} ${noun}`;
}

/** True when a single monetary figure would misrepresent the holding. */
export function isPartial(t: MoneyTotals): boolean {
  return t.absent > 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Valuation across the whole cellar, currency-aware.
 *
 * Home and Collection previously showed a bare `totals.value` — a single
 * number with no currency and no completeness. That was wrong in two ways at
 * once: it implied the whole cellar had been valued, and it would have summed
 * GBP and EUR into a figure representing neither.
 *
 * `record_valuation` accepts any currency, so mixed holdings are one user
 * action away. Every aggregate now goes through the same structure as Wine
 * Detail, and a single monetary figure is structurally impossible once more
 * than one currency is present.
 */
export function cellarValuation(
  bottles: { id: string; isActive: boolean }[],
  valuations: Map<string, BottleValuation>,
): MoneyTotals {
  return holdingValue(
    bottles.filter((b) => b.isActive).map((b) => b.id),
    valuations,
  );
}

/**
 * Acquisition cost across the whole cellar, currency-aware.
 *
 * Same principle as `cellarValuation`, for wherever cost is aggregated.
 */
export function cellarCost(
  bottles: { id: string; isActive: boolean }[],
  costs: Map<string, BottleCostResult>,
): MoneyTotals {
  return holdingCost(
    bottles.filter((b) => b.isActive).map((b) => b.id),
    costs,
  );
}
