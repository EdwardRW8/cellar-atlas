import { describe, it, expect } from "vitest";
import {
  mapValuationCurrencies,
  distinctValuationTimestamps,
  distinctCurrencies,
  coversAllTimestamps,
  rowMatchesBottle,
  isResolved,
  type ValuableBottle,
  type ValuationLedgerRow,
} from "@/domain/valuation";

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-06-01T10:00:00.000Z";

function bottle(over: Partial<ValuableBottle> = {}): ValuableBottle {
  return {
    id: "b1",
    wineDefinitionId: "w1",
    currentValue: 150,
    currentValueAt: T1,
    ...over,
  };
}

function row(over: Partial<ValuationLedgerRow> = {}): ValuationLedgerRow {
  return {
    id: "v1",
    bottleId: null,
    wineDefinitionId: "w1",
    currency: "GBP",
    amount: 150,
    valuationBasis: "market_estimate",
    source: "manual",
    createdAt: T1,
    ...over,
  };
}

const resolve = (b: ValuableBottle[], r: ValuationLedgerRow[]) =>
  mapValuationCurrencies(b, r);

describe("wine-level valuations map to every bottle they updated", () => {
  it("a wine-level row resolves ALL bottles of that wine", () => {
    const bottles = [bottle({ id: "b1" }), bottle({ id: "b2" }), bottle({ id: "b3" })];
    const m = resolve(bottles, [row()]);

    for (const id of ["b1", "b2", "b3"]) {
      const v = m.get(id)!;
      expect(isResolved(v), `${id} unresolved`).toBe(true);
      expect((v as { currency: string }).currency).toBe("GBP");
    }
  });

  it("matching on bottle_id ALONE would have failed — the bug this avoids", () => {
    // The wine-level row carries no bottle_id at all.
    const r = row({ bottleId: null });
    expect(r.bottleId).toBeNull();
    const m = resolve([bottle()], [r]);
    expect(isResolved(m.get("b1")!)).toBe(true);
  });

  it("does NOT resolve a bottle of a different wine", () => {
    const m = resolve([bottle({ id: "b9", wineDefinitionId: "other" })], [row()]);
    expect(m.get("b9")).toMatchObject({ currency: null, reason: "unmatched" });
  });

  it("does NOT resolve a bottle whose timestamp differs", () => {
    const m = resolve([bottle({ currentValueAt: T2 })], [row({ createdAt: T1 })]);
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "unmatched" });
  });
});

describe("bottle-level records take precedence", () => {
  it("a bottle-level row WINS over a wine-level one at the same instant", () => {
    const m = resolve(
      [bottle({ id: "b1" })],
      [
        row({ id: "wine", bottleId: null, currency: "EUR", amount: 150 }),
        row({ id: "specific", bottleId: "b1", currency: "GBP", amount: 90 }),
      ],
    );
    const v = m.get("b1")!;
    expect(isResolved(v)).toBe(true);
    expect(v).toMatchObject({ currency: "GBP", amount: 90, valuationId: "specific" });
  });

  it("siblings still take the wine-level row", () => {
    const m = resolve(
      [bottle({ id: "b1" }), bottle({ id: "b2" })],
      [
        row({ id: "wine", bottleId: null, currency: "EUR" }),
        row({ id: "specific", bottleId: "b1", currency: "GBP" }),
      ],
    );
    expect(m.get("b1")).toMatchObject({ currency: "GBP" });
    expect(m.get("b2")).toMatchObject({ currency: "EUR" });
  });

  it("THE MIXED-CURRENCY CASE is detected across one wine", () => {
    const m = resolve(
      [bottle({ id: "b1" }), bottle({ id: "b2" }), bottle({ id: "b3" })],
      [
        row({ id: "wine", bottleId: null, currency: "EUR" }),
        row({ id: "specific", bottleId: "b1", currency: "GBP" }),
      ],
    );
    expect(distinctCurrencies(m)).toEqual(["EUR", "GBP"]);
  });

  it("a bottle-level row for ANOTHER bottle does not win", () => {
    const m = resolve(
      [bottle({ id: "b2" })],
      [
        row({ id: "wine", bottleId: null, currency: "EUR" }),
        row({ id: "other", bottleId: "b1", currency: "GBP" }),
      ],
    );
    expect(m.get("b2")).toMatchObject({ currency: "EUR" });
  });
});

describe("ambiguity yields UNKNOWN, never a guess", () => {
  it("two wine-level rows at the same instant are ambiguous", () => {
    const m = resolve(
      [bottle()],
      [row({ id: "a", currency: "GBP" }), row({ id: "b", currency: "EUR" })],
    );
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "ambiguous" });
  });

  it("two bottle-level rows at the same instant are ambiguous", () => {
    const m = resolve(
      [bottle()],
      [
        row({ id: "a", bottleId: "b1", currency: "GBP" }),
        row({ id: "b", bottleId: "b1", currency: "USD" }),
      ],
    );
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "ambiguous" });
  });

  it("an ambiguous bottle contributes NO currency to the distinct set", () => {
    const m = resolve(
      [bottle()],
      [row({ id: "a", currency: "GBP" }), row({ id: "b", currency: "EUR" })],
    );
    expect(distinctCurrencies(m)).toEqual([]);
  });

  it("one bottle-level plus one wine-level is NOT ambiguous", () => {
    const m = resolve(
      [bottle()],
      [row({ id: "w", bottleId: null }), row({ id: "b", bottleId: "b1" })],
    );
    expect(isResolved(m.get("b1")!)).toBe(true);
  });
});

describe("absence is unknown, never zero", () => {
  it("a bottle with no cached value is unknown", () => {
    const m = resolve([bottle({ currentValue: null, currentValueAt: null })], [row()]);
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "no-valuation" });
  });

  it("a value with no timestamp is unknown", () => {
    const m = resolve([bottle({ currentValueAt: null })], [row()]);
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "no-valuation" });
  });

  it("no ledger rows at all leaves every bottle unmatched", () => {
    const m = resolve([bottle()], []);
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "unmatched" });
  });

  it("NOTHING in the result is ever a zero amount", () => {
    const m = resolve(
      [bottle({ currentValue: null, currentValueAt: null }), bottle({ id: "b2" })],
      [],
    );
    for (const v of m.values()) {
      expect(isResolved(v) ? v.amount : null).not.toBe(0);
    }
  });

  it("every bottle appears in the result, resolved or not", () => {
    const m = resolve(
      [
        bottle({ id: "b1" }),
        bottle({ id: "b2", currentValue: null, currentValueAt: null }),
      ],
      [row()],
    );
    expect([...m.keys()].sort()).toEqual(["b1", "b2"]);
  });
});

describe("the timestamp set stays bounded", () => {
  it("collapses many bottles sharing one valuation to ONE timestamp", () => {
    const bottles = Array.from({ length: 200 }, (_, i) => bottle({ id: `b${i}` }));
    expect(distinctValuationTimestamps(bottles)).toEqual([T1]);
  });

  it("returns one entry per distinct valuation moment", () => {
    const stamps = distinctValuationTimestamps([
      bottle({ id: "b1", currentValueAt: T1 }),
      bottle({ id: "b2", currentValueAt: T2 }),
      bottle({ id: "b3", currentValueAt: T1 }),
    ]);
    expect(stamps.sort()).toEqual([T1, T2]);
  });

  it("ignores bottles with no valuation", () => {
    expect(distinctValuationTimestamps([bottle({ currentValueAt: null })])).toEqual([]);
  });
});

describe("coverage detection protects against silent row loss", () => {
  it("reports covered when every timestamp came back", () => {
    expect(
      coversAllTimestamps([T1, T2], [row({ createdAt: T1 }), row({ createdAt: T2 })]),
    ).toBe(true);
  });

  it("reports NOT covered when a timestamp is missing", () => {
    // This is what a PostgREST precision mismatch would look like.
    expect(coversAllTimestamps([T1, T2], [row({ createdAt: T1 })])).toBe(false);
  });

  it("an empty request is trivially covered", () => {
    expect(coversAllTimestamps([], [])).toBe(true);
  });

  it("no rows for a non-empty request is NOT covered", () => {
    expect(coversAllTimestamps([T1], [])).toBe(false);
  });
});

describe("the match rule is shared by both read paths", () => {
  it("requires exact timestamp equality — not a range", () => {
    const b = bottle({ currentValueAt: T1 });
    expect(rowMatchesBottle(row({ createdAt: T1 }), b)).toBe(true);
    // One millisecond out is a different valuation moment.
    expect(rowMatchesBottle(row({ createdAt: "2026-03-01T10:00:00.001Z" }), b)).toBe(false);
  });

  it("the fallback narrows a wide range back to the same answer", () => {
    const bottles = [bottle({ id: "b1", currentValueAt: T1 })];
    // A range query would return neighbours too.
    const wide = [
      row({ id: "before", createdAt: "2026-02-01T10:00:00.000Z" }),
      row({ id: "exact", createdAt: T1 }),
      row({ id: "after", createdAt: T2 }),
    ];
    const m = mapValuationCurrencies(bottles, wide);
    expect(m.get("b1")).toMatchObject({ valuationId: "exact" });
  });

  it("a bottle with no timestamp never matches anything", () => {
    expect(rowMatchesBottle(row(), bottle({ currentValueAt: null }))).toBe(false);
  });
});

describe("REGRESSION: timestamps are compared as instants, not values", () => {
  it("a Date and an equivalent ISO string MATCH", () => {
    // Drivers differ: supabase-js returns ISO strings, PGlite returns Dates.
    // `===` on two Dates is reference equality and is always false — this was
    // a real defect caught against a live Postgres engine.
    const m = mapValuationCurrencies(
      [bottle({ currentValueAt: new Date(T1) })],
      [row({ createdAt: T1 })],
    );
    expect(isResolved(m.get("b1")!)).toBe(true);
  });

  it("two separate Date objects for the same instant MATCH", () => {
    const m = mapValuationCurrencies(
      [bottle({ currentValueAt: new Date(T1) })],
      [row({ createdAt: new Date(T1) })],
    );
    expect(isResolved(m.get("b1")!)).toBe(true);
  });

  it("cosmetic ISO differences MATCH — offset versus Z", () => {
    const m = mapValuationCurrencies(
      [bottle({ currentValueAt: "2026-03-01T10:00:00+00:00" })],
      [row({ createdAt: "2026-03-01T10:00:00.000Z" })],
    );
    expect(isResolved(m.get("b1")!)).toBe(true);
  });

  it("genuinely different instants still do NOT match", () => {
    const m = mapValuationCurrencies(
      [bottle({ currentValueAt: new Date(T1) })],
      [row({ createdAt: new Date(T2) })],
    );
    expect(m.get("b1")).toMatchObject({ reason: "unmatched" });
  });

  it("the timestamp set canonicalises equivalent forms to ONE entry", () => {
    const stamps = distinctValuationTimestamps([
      bottle({ id: "b1", currentValueAt: new Date(T1) }),
      bottle({ id: "b2", currentValueAt: "2026-03-01T10:00:00+00:00" }),
      bottle({ id: "b3", currentValueAt: T1 }),
    ]);
    expect(stamps).toHaveLength(1);
  });

  it("coverage detection is instant-based too", () => {
    expect(coversAllTimestamps([T1], [row({ createdAt: new Date(T1) })])).toBe(true);
  });

  it("an unparseable timestamp is unknown, not a crash", () => {
    const m = mapValuationCurrencies([bottle({ currentValueAt: "not-a-date" })], [row()]);
    expect(m.get("b1")).toMatchObject({ currency: null, reason: "no-valuation" });
  });
});

describe("purity", () => {
  it("does not mutate its inputs", () => {
    const bottles = [bottle()];
    const rows = [row()];
    const before = JSON.stringify({ bottles, rows });
    mapValuationCurrencies(bottles, rows);
    expect(JSON.stringify({ bottles, rows })).toBe(before);
  });

  it("repeated calls agree", () => {
    const bottles = [bottle()];
    const rows = [row()];
    expect([...mapValuationCurrencies(bottles, rows)]).toEqual([
      ...mapValuationCurrencies(bottles, rows),
    ]);
  });
});
