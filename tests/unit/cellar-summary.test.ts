import { describe, it, expect } from "vitest";
import {
  buildCellarSummary,
  summariseReadiness,
  summariseAttention,
  summariseStorage,
  CLOSING_SOON_YEARS,
} from "@/domain/cellar-summary";
import { summarise } from "@/domain/collection-filters";
import type { WineSummary, DomainStorageLocation } from "@/domain/types";

const YEAR = 2026;

function wine(
  over: Partial<WineSummary["wine"]> = {},
  sum: Partial<WineSummary> = {},
): WineSummary {
  return {
    wine: {
      id: over.id ?? Math.random().toString(36).slice(2),
      producer: "Test Estate",
      name: "Test Wine",
      vintage: 2018,
      colour: "Red",
      grapes: ["Merlot"],
      geography: {
        country: { id: "c", name: "France", code: "FR" },
        region: null,
        appellation: null,
        unmatched: null,
      },
      drinkFrom: 2022,
      drinkUntil: 2035,
      notes: null,
      version: 1,
      ...over,
    },
    activeBottles: 3,
    totalBottles: 3,
    locations: [{ id: "loc-1", name: "Home", count: 3 }],
    totalValue: 150,
    valuation: { valuedBottles: 0, activeBottles: 0 },
    ...sum,
  };
}

function location(over: Partial<DomainStorageLocation> = {}): DomainStorageLocation {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    name: "Test Location",
    kind: "home",
    layoutId: "l1",
    layoutType: "grid",
    layoutConfig: { rows: 2, columns: 2 },
    capacity: 4,
    isExternal: false,
    isPositioned: true,
    occupied: 0,
    version: 1,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// READINESS
// ═══════════════════════════════════════════════════════════════════════════

describe("readiness counts bottles, not just wines", () => {
  it("counts ready bottles and ready wines separately", () => {
    const r = summariseReadiness(
      [
        wine({ drinkFrom: 2022, drinkUntil: 2035 }, { activeBottles: 6 }),
        wine({ drinkFrom: 2020, drinkUntil: 2030 }, { activeBottles: 1 }),
      ],
      YEAR,
    );
    expect(r.readyBottles).toBe(7);
    expect(r.readyWines).toBe(2);
  });

  it("counts past-window separately", () => {
    const r = summariseReadiness(
      [wine({ drinkFrom: 2000, drinkUntil: 2015 }, { activeBottles: 2 })],
      YEAR,
    );
    expect(r.pastWindowBottles).toBe(2);
    expect(r.pastWindowWines).toBe(1);
    expect(r.readyBottles).toBe(0);
  });

  it("does not count wines that are not yet ready", () => {
    const r = summariseReadiness(
      [wine({ drinkFrom: 2040, drinkUntil: 2050 }, { activeBottles: 4 })],
      YEAR,
    );
    expect(r.readyBottles).toBe(0);
    expect(r.pastWindowBottles).toBe(0);
  });

  it("counts wines with no window as unknown", () => {
    const r = summariseReadiness([wine({ drinkFrom: null, drinkUntil: null })], YEAR);
    expect(r.unknownWindowWines).toBe(1);
    expect(r.readyBottles).toBe(0);
  });

  it("IGNORES wines with no bottles left", () => {
    const r = summariseReadiness(
      [wine({ drinkFrom: 2022, drinkUntil: 2035 }, { activeBottles: 0 })],
      YEAR,
    );
    expect(r.readyBottles).toBe(0);
    expect(r.readyWines).toBe(0);
  });

  it("an empty collection returns zeroes, never nulls", () => {
    const r = summariseReadiness([], YEAR);
    expect(Object.values(r).every((v) => v === 0)).toBe(true);
  });
});

describe("closing soon is a SUBSET of ready", () => {
  it("a wine closing within the threshold is BOTH ready and closing", () => {
    const r = summariseReadiness(
      [wine({ drinkFrom: 2020, drinkUntil: YEAR + 1 }, { activeBottles: 2 })],
      YEAR,
    );
    expect(r.readyBottles).toBe(2);
    expect(r.closingSoonBottles).toBe(2);
  });

  it("a wine closing beyond the threshold is ready but NOT closing", () => {
    const r = summariseReadiness(
      [
        wine(
          { drinkFrom: 2020, drinkUntil: YEAR + CLOSING_SOON_YEARS + 5 },
          { activeBottles: 2 },
        ),
      ],
      YEAR,
    );
    expect(r.readyBottles).toBe(2);
    expect(r.closingSoonBottles).toBe(0);
  });

  it("a wine not yet open cannot be closing, whatever its end year", () => {
    const r = summariseReadiness(
      [wine({ drinkFrom: 2040, drinkUntil: YEAR + 1 }, { activeBottles: 2 })],
      YEAR,
    );
    expect(r.closingSoonBottles).toBe(0);
  });

  it("a past-window wine is not counted as closing", () => {
    const r = summariseReadiness(
      [wine({ drinkFrom: 2000, drinkUntil: 2015 }, { activeBottles: 2 })],
      YEAR,
    );
    expect(r.closingSoonBottles).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTENTION
// ═══════════════════════════════════════════════════════════════════════════

describe("attention counts blank fields, never judges the wine", () => {
  it("reports missing geography", () => {
    const items = summariseAttention([
      wine({
        geography: {
          country: null,
          region: null,
          appellation: null,
          unmatched: "Somewhere",
        },
      }),
    ]);
    expect(items.find((i) => i.kind === "missing-geography")?.wines).toBe(1);
  });

  it("reports a missing drinking window", () => {
    const items = summariseAttention([wine({ drinkFrom: null, drinkUntil: null })]);
    expect(items.find((i) => i.kind === "missing-window")?.wines).toBe(1);
  });

  it("does NOT report a partial window as missing", () => {
    const items = summariseAttention([wine({ drinkFrom: 2022, drinkUntil: null })]);
    expect(items.find((i) => i.kind === "missing-window")).toBeUndefined();
  });

  it("reports a missing type", () => {
    const items = summariseAttention([wine({ colour: null })]);
    expect(items.find((i) => i.kind === "missing-colour")?.wines).toBe(1);
  });

  it("returns nothing when everything is complete", () => {
    expect(summariseAttention([wine()])).toEqual([]);
  });

  it("ignores wines with no bottles left", () => {
    expect(summariseAttention([wine({ colour: null }, { activeBottles: 0 })])).toEqual([]);
  });

  it("pluralises correctly", () => {
    const one = summariseAttention([wine({ colour: null })]);
    const two = summariseAttention([wine({ colour: null }), wine({ colour: null })]);
    expect(one[0]!.label).toMatch(/1 wine have|1 wine has|1 wine /);
    expect(two[0]!.label).toMatch(/2 wines/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE PRESSURE — LAYOUT AGNOSTIC
// ═══════════════════════════════════════════════════════════════════════════

describe("storage pressure aggregates across locations", () => {
  it("sums bounded locations of DIFFERENT layout types", () => {
    const s = summariseStorage([
      location({
        layoutType: "grid",
        layoutConfig: { rows: 2, columns: 2 },
        occupied: 2,
      }),
      location({
        layoutType: "staircase",
        layoutConfig: {
          columns: 3,
          heights: [2, 3, 4],
          chamfer: false,
          orientation: "ascending-right",
        },
        occupied: 3,
      }),
    ])!;
    expect(s.boundedLocations).toBe(2);
    expect(s.capacity).toBe(4 + 9);
    expect(s.occupied).toBe(5);
    expect(s.free).toBe(8);
  });

  it("computes a correct percentage", () => {
    const s = summariseStorage([
      location({ layoutConfig: { rows: 2, columns: 2 }, occupied: 1 }),
    ])!;
    expect(s.percentFull).toBe(25);
  });

  it("EXCLUDES unbounded storage from the percentage", () => {
    const s = summariseStorage([
      location({ layoutConfig: { rows: 2, columns: 2 }, occupied: 2 }),
      location({
        layoutType: null,
        layoutConfig: null,
        isPositioned: false,
        isExternal: true,
        occupied: 200,
      }),
    ])!;
    // 200 merchant bottles must not make this look 100% full.
    expect(s.percentFull).toBe(50);
    expect(s.capacity).toBe(4);
    expect(s.unboundedBottles).toBe(200);
    expect(s.unboundedLocations).toBe(1);
  });

  it("returns NULL when there is no bounded storage at all", () => {
    expect(
      summariseStorage([
        location({
          layoutType: null,
          layoutConfig: null,
          isPositioned: false,
          isExternal: true,
          occupied: 12,
        }),
      ]),
    ).toBeNull();
  });

  it("returns null for a cellar with no storage whatsoever", () => {
    expect(summariseStorage([])).toBeNull();
  });

  it("identifies full locations by name", () => {
    const s = summariseStorage([
      location({
        id: "full",
        name: "Full Rack",
        layoutConfig: { rows: 1, columns: 2 },
        occupied: 2,
      }),
      location({ layoutConfig: { rows: 2, columns: 2 }, occupied: 1 }),
    ])!;
    expect(s.fullLocations).toEqual([{ id: "full", name: "Full Rack" }]);
  });

  it("never reports negative free space", () => {
    const s = summariseStorage([
      location({ layoutConfig: { rows: 1, columns: 1 }, occupied: 5 }),
    ])!;
    expect(s.free).toBe(0);
  });

  it("handles every positioned layout type", () => {
    const configs: [string, unknown, number][] = [
      ["grid", { rows: 2, columns: 3 }, 6],
      ["shelving", { shelves: [4, 4] }, 8],
      ["fridge", { zones: [{ name: "A", shelves: 2, perShelf: 5 }] }, 10],
    ];
    for (const [type, config, expected] of configs) {
      const s = summariseStorage([
        location({ layoutType: type, layoutConfig: config as never, occupied: 0 }),
      ])!;
      expect(s.capacity, type).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FULL SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

describe("the full summary", () => {
  it("TOTALS AGREE with the Cellar screen's own summarise()", () => {
    const wines = [
      wine({}, { activeBottles: 6, totalValue: 300 }),
      wine({}, { activeBottles: 2, totalValue: 100 }),
    ];
    const home = buildCellarSummary(wines, [], YEAR);
    const cellar = summarise(wines, YEAR);
    expect(home.totals).toEqual(cellar);
  });

  it("excludes fully consumed wines from totals, as the Cellar screen does", () => {
    const wines = [
      wine({}, { activeBottles: 3 }),
      wine({}, { activeBottles: 0, totalValue: 999 }),
    ];
    const home = buildCellarSummary(wines, [], YEAR);
    expect(home.totals.wines).toBe(1);
    expect(home.totals.bottles).toBe(3);
  });

  it("reports empty for a cellar with no active bottles", () => {
    expect(buildCellarSummary([wine({}, { activeBottles: 0 })], [], YEAR).isEmpty).toBe(
      true,
    );
  });

  it("reports empty for a cellar with no wines at all", () => {
    const s = buildCellarSummary([], [], YEAR);
    expect(s.isEmpty).toBe(true);
    expect(s.totals.bottles).toBe(0);
    expect(s.attention).toEqual([]);
    expect(s.storage).toBeNull();
  });

  it("is not empty when bottles exist", () => {
    expect(buildCellarSummary([wine()], [], YEAR).isEmpty).toBe(false);
  });

  it("is pure — repeated calls give identical results", () => {
    const wines = [wine({ id: "fixed" })];
    const locs = [location({ id: "fixed-loc", occupied: 1 })];
    expect(buildCellarSummary(wines, locs, YEAR)).toEqual(
      buildCellarSummary(wines, locs, YEAR),
    );
  });

  it("does not mutate its inputs", () => {
    const wines = [wine({ id: "a" })];
    const locs = [location({ id: "b" })];
    const wineCopy = JSON.stringify(wines);
    const locCopy = JSON.stringify(locs);
    buildCellarSummary(wines, locs, YEAR);
    expect(JSON.stringify(wines)).toBe(wineCopy);
    expect(JSON.stringify(locs)).toBe(locCopy);
  });
});

describe("no prediction leaks in — Phase 8 boundary", () => {
  it("the summary exposes only counts, sums and names", () => {
    const s = buildCellarSummary([wine()], [location({ occupied: 1 })], YEAR);
    const keys = Object.keys(s).sort();
    expect(keys).toEqual(["attention", "isEmpty", "readiness", "storage", "totals"]);
  });

  it("carries no score, forecast or recommendation field", () => {
    const json = JSON.stringify(
      buildCellarSummary([wine()], [location({ occupied: 1 })], YEAR),
    );
    for (const banned of [
      "score",
      "forecast",
      "predict",
      "longevity",
      "legacy",
      "recommend",
      "risk",
    ]) {
      expect(json.toLowerCase()).not.toContain(banned);
    }
  });
});
