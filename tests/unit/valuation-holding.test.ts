import { describe, it, expect } from "vitest";
import {
  mapBottleCosts,
  holdingCost,
  holdingValue,
  holdingGain,
  holdingValuation,
  bottleGain,
  describeCompleteness,
  isPartial,
  hasCost,
  hasGain,
  type BottleCostResult,
  type BottleValuation,
  type AcquisitionCost,
} from "@/domain/valuation";
import { isValuationComplete, type CollectionTotals } from "@/domain/collection-filters";

const T = "2026-03-01T10:00:00.000Z";

function cost(id: string, unitPrice: number, currency = "GBP"): BottleCostResult {
  return { bottleId: id, unitPrice, currency };
}
function noCost(id: string): BottleCostResult {
  return { bottleId: id, unitPrice: null, reason: "unlinked" };
}
function valued(id: string, amount: number, currency = "GBP"): BottleValuation {
  return {
    bottleId: id,
    currency,
    amount,
    valuationBasis: "market_estimate",
    source: "manual",
    valuationId: `v-${id}`,
    valuedAt: T,
  };
}
function unvalued(id: string): BottleValuation {
  return { bottleId: id, currency: null, reason: "no-valuation" };
}

const asMap = <T extends { bottleId: string }>(xs: T[]) =>
  new Map(xs.map((x) => [x.bottleId, x]));

// ═══════════════════════════════════════════════════════════════════════════
// COST RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe("acquisition cost is resolved, never assumed", () => {
  const costs = new Map<string, AcquisitionCost>([
    ["i1", { itemId: "i1", unitPrice: 40, currency: "GBP" }],
    ["i2", { itemId: "i2", unitPrice: null, currency: "EUR" }],
  ]);

  it("resolves a linked item with a price", () => {
    const m = mapBottleCosts([{ id: "b1", acquisitionItemId: "i1" }], costs);
    expect(m.get("b1")).toMatchObject({ unitPrice: 40, currency: "GBP" });
  });

  it("a SEVERED link is unknown, never zero", () => {
    // acquisition_item_id is `on delete set null`.
    const m = mapBottleCosts([{ id: "b1", acquisitionItemId: null }], costs);
    expect(m.get("b1")).toMatchObject({ unitPrice: null, reason: "unlinked" });
  });

  it("a linked item with NO price is unknown, never zero", () => {
    const m = mapBottleCosts([{ id: "b1", acquisitionItemId: "i2" }], costs);
    expect(m.get("b1")).toMatchObject({ unitPrice: null, reason: "no-price" });
  });

  it("a missing item is unknown", () => {
    const m = mapBottleCosts([{ id: "b1", acquisitionItemId: "gone" }], costs);
    expect(hasCost(m.get("b1")!)).toBe(false);
  });

  it("currency is inherited from the parent acquisition", () => {
    const m = mapBottleCosts([{ id: "b1", acquisitionItemId: "i1" }], costs);
    expect((m.get("b1") as { currency: string }).currency).toBe("GBP");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HOLDING TOTALS AND COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════

describe("totals carry their completeness", () => {
  it("sums only bottles that have a value", () => {
    const t = holdingValue(
      ["b1", "b2", "b3"],
      asMap([valued("b1", 100), valued("b2", 200), unvalued("b3")]),
    );
    expect(t.single).toMatchObject({ amount: 300, bottles: 2 });
    expect(t.present).toBe(2);
    expect(t.absent).toBe(1);
    expect(t.total).toBe(3);
  });

  it("an unvalued bottle contributes NOTHING, not zero", () => {
    const t = holdingValue(["b1", "b2"], asMap([valued("b1", 100), unvalued("b2")]));
    // 100 across one bottle — not 100 across two, and not 50 each.
    expect(t.single!.amount).toBe(100);
    expect(t.single!.bottles).toBe(1);
  });

  it("reports partial when anything is missing", () => {
    const t = holdingValue(["b1", "b2"], asMap([valued("b1", 100), unvalued("b2")]));
    expect(isPartial(t)).toBe(true);
    expect(describeCompleteness(t, "valued")).toBe("1 of 2 valued");
  });

  it("reports complete when nothing is missing", () => {
    const t = holdingValue(["b1"], asMap([valued("b1", 100)]));
    expect(isPartial(t)).toBe(false);
  });

  it("an entirely unvalued holding has no amount at all", () => {
    const t = holdingValue(["b1", "b2"], asMap([unvalued("b1"), unvalued("b2")]));
    expect(t.single).toBeNull();
    expect(t.byCurrency).toEqual([]);
    expect(t.present).toBe(0);
  });

  it("cost totals behave identically", () => {
    const t = holdingCost(["b1", "b2"], asMap([cost("b1", 40), noCost("b2")]));
    expect(t.single).toMatchObject({ amount: 40, bottles: 1 });
    expect(describeCompleteness(t, "costed")).toBe("1 of 2 costed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MIXED CURRENCIES — NEVER COMBINED
// ═══════════════════════════════════════════════════════════════════════════

describe("currencies are never combined", () => {
  const mixed = holdingValue(
    ["b1", "b2", "b3"],
    asMap([valued("b1", 100, "GBP"), valued("b2", 200, "EUR"), valued("b3", 50, "GBP")]),
  );

  it("flags the holding as mixed", () => {
    expect(mixed.isMixed).toBe(true);
  });

  it("refuses a single figure", () => {
    expect(mixed.single).toBeNull();
  });

  it("NEVER produces the naive sum", () => {
    const total = mixed.byCurrency.reduce((n, c) => n + c.amount, 0);
    // 350 would be the fabricated number. It must not be presented as one.
    expect(total).toBe(350);
    expect(mixed.single).toBeNull();
  });

  it("groups per currency with its own bottle count", () => {
    expect(mixed.byCurrency).toEqual([
      { currency: "EUR", amount: 200, bottles: 1 },
      { currency: "GBP", amount: 150, bottles: 2 },
    ]);
  });

  it("a single-currency holding is NOT mixed", () => {
    const t = holdingValue(["b1"], asMap([valued("b1", 100, "GBP")]));
    expect(t.isMixed).toBe(false);
    expect(t.single).toMatchObject({ currency: "GBP" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BOTTLE GAIN
// ═══════════════════════════════════════════════════════════════════════════

describe("individual bottle gain", () => {
  it("computes gain when both sides exist in one currency", () => {
    const g = bottleGain("b1", cost("b1", 40), valued("b1", 100));
    expect(g).toMatchObject({ gain: 60, cost: 40, value: 100 });
    expect((g as { percent: number }).percent).toBe(150);
  });

  it("handles a LOSS honestly", () => {
    const g = bottleGain("b1", cost("b1", 100), valued("b1", 60));
    expect(g).toMatchObject({ gain: -40, percent: -40 });
  });

  it("no valuation → reason, never zero", () => {
    const g = bottleGain("b1", cost("b1", 40), unvalued("b1"));
    expect(g).toMatchObject({ gain: null, reason: "no-valuation" });
  });

  it("no cost → reason, never zero", () => {
    const g = bottleGain("b1", noCost("b1"), valued("b1", 100));
    expect(g).toMatchObject({ gain: null, reason: "no-cost" });
  });

  it("CURRENCY MISMATCH → reason, never a fabricated number", () => {
    const g = bottleGain("b1", cost("b1", 40, "EUR"), valued("b1", 100, "GBP"));
    expect(g).toMatchObject({ gain: null, reason: "currency-mismatch" });
  });

  it("a zero cost suppresses the percentage rather than dividing by nothing", () => {
    const g = bottleGain("b1", cost("b1", 0), valued("b1", 100));
    expect(hasGain(g)).toBe(true);
    expect((g as { gain: number; percent: number | null }).gain).toBe(100);
    expect((g as { percent: number | null }).percent).toBeNull();
  });

  it("missing both sides reports the valuation first", () => {
    expect(bottleGain("b1", noCost("b1"), unvalued("b1"))).toMatchObject({
      reason: "no-valuation",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HOLDING GAIN — COMPARABLE SUBSET ONLY
// ═══════════════════════════════════════════════════════════════════════════

describe("holding gain covers only the comparable subset", () => {
  it("excludes bottles missing either side and says how many", () => {
    const g = holdingGain(
      ["b1", "b2", "b3", "b4"],
      asMap([cost("b1", 40), cost("b2", 50), noCost("b3"), cost("b4", 60)]),
      asMap([valued("b1", 100), unvalued("b2"), valued("b3", 90), unvalued("b4")]),
    );
    expect(g.comparableBottles).toBe(1);
    expect(g.totalActiveBottles).toBe(4);
    expect(g.byCurrency[0]).toMatchObject({ gain: 60, comparableBottles: 1 });
    expect(g.excluded).toEqual({
      noCost: 1,
      noValuation: 2,
      currencyMismatch: 0,
    });
  });

  it("THE PERCENTAGE USES THE SAME SUBSET as the absolute gain", () => {
    const g = holdingGain(
      ["b1", "b2"],
      asMap([cost("b1", 100), cost("b2", 1000)]),
      asMap([valued("b1", 150), unvalued("b2")]),
    );
    const c = g.byCurrency[0]!;
    // Denominator is 100 — b1's cost — not 1100.
    expect(c.cost).toBe(100);
    expect(c.gain).toBe(50);
    expect(c.percent).toBe(50);
  });

  it("groups gain per currency and never combines them", () => {
    const g = holdingGain(
      ["b1", "b2"],
      asMap([cost("b1", 40, "GBP"), cost("b2", 80, "EUR")]),
      asMap([valued("b1", 100, "GBP"), valued("b2", 200, "EUR")]),
    );
    expect(g.isMixed).toBe(true);
    expect(g.byCurrency).toHaveLength(2);
    expect(g.byCurrency.find((c) => c.currency === "GBP")).toMatchObject({ gain: 60 });
    expect(g.byCurrency.find((c) => c.currency === "EUR")).toMatchObject({ gain: 120 });
  });

  it("counts a cross-currency bottle as excluded, not as gain", () => {
    const g = holdingGain(
      ["b1"],
      asMap([cost("b1", 40, "EUR")]),
      asMap([valued("b1", 100, "GBP")]),
    );
    expect(g.comparableBottles).toBe(0);
    expect(g.byCurrency).toEqual([]);
    expect(g.excluded.currencyMismatch).toBe(1);
  });

  it("no comparable bottles yields NO gain figure", () => {
    const g = holdingGain(["b1"], asMap([noCost("b1")]), asMap([unvalued("b1")]));
    expect(g.byCurrency).toEqual([]);
    expect(g.comparableBottles).toBe(0);
  });

  it("an empty holding does not crash", () => {
    const g = holdingGain([], new Map(), new Map());
    expect(g).toMatchObject({ comparableBottles: 0, totalActiveBottles: 0 });
  });

  it("zero total cost suppresses the percentage", () => {
    const g = holdingGain(["b1"], asMap([cost("b1", 0)]), asMap([valued("b1", 100)]));
    expect(g.byCurrency[0]!.percent).toBeNull();
  });
});

describe("the full holding view", () => {
  it("assembles cost, value and gain consistently", () => {
    const h = holdingValuation(
      ["b1", "b2", "b3"],
      asMap([cost("b1", 40), cost("b2", 50), noCost("b3")]),
      asMap([valued("b1", 100), unvalued("b2"), valued("b3", 90)]),
    );
    expect(h.activeBottles).toBe(3);
    expect(h.cost.present).toBe(2);
    expect(h.value.present).toBe(2);
    expect(h.gain.comparableBottles).toBe(1);
  });

  it("is pure and does not mutate its inputs", () => {
    const costs = asMap([cost("b1", 40)]);
    const vals = asMap([valued("b1", 100)]);
    const before = JSON.stringify([...costs, ...vals]);
    holdingValuation(["b1"], costs, vals);
    expect(JSON.stringify([...costs, ...vals])).toBe(before);
  });

  it("consumed bottles are simply absent from the id list", () => {
    // Callers pass ACTIVE bottle ids only; unrealised gain is about what is
    // still held.
    const h = holdingValuation(["b1"], asMap([cost("b1", 40)]), asMap([valued("b1", 100)]));
    expect(h.activeBottles).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COLLECTION TOTALS COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════

describe("collection totals expose completeness", () => {
  const totals = (over: Partial<CollectionTotals> = {}): CollectionTotals => ({
    wines: 1,
    bottles: 14,
    value: 1680,
    readyNow: 0,
    valuedBottles: 11,
    activeBottles: 14,
    ...over,
  });

  it("a PARTIAL valuation is not complete", () => {
    expect(isValuationComplete(totals())).toBe(false);
  });

  it("a fully valued collection is complete", () => {
    expect(isValuationComplete(totals({ valuedBottles: 14 }))).toBe(true);
  });

  it("an empty collection is not claimed complete", () => {
    expect(isValuationComplete(totals({ valuedBottles: 0, activeBottles: 0 }))).toBe(false);
  });

  it("THE REPORTED BUG: one valued bottle of forty-one is not complete", () => {
    expect(
      isValuationComplete(totals({ valuedBottles: 1, activeBottles: 41, value: 400 })),
    ).toBe(false);
  });
});
