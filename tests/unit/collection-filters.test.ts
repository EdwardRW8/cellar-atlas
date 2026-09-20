import { describe, it, expect } from "vitest";
import {
  emptyFilters,
  hasActiveFilters,
  countActiveFilters,
  filterCollection,
  sortCollection,
  summarise,
  deriveFilterOptions,
} from "@/domain/collection-filters";
import type { WineSummary } from "@/domain/types";

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
        region: { id: "r", name: "Bordeaux" },
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
    locations: [{ id: "loc-1", name: "Home Cellar", count: 3 }],
    totalValue: 150,
    valuation: { valuedBottles: 0, activeBottles: 0 },
    ...sum,
  };
}

describe("search", () => {
  const wines = [
    wine({ producer: "Château Margaux", name: "Château Margaux", vintage: 2015 }),
    wine({ producer: "Tenuta San Guido", name: "Sassicaia", vintage: 2018 }),
    wine({ producer: "Domaine Leflaive", name: "Puligny-Montrachet", vintage: 2020 }),
  ];

  it("matches producer", () => {
    const r = filterCollection(wines, { ...emptyFilters(), search: "margaux" }, YEAR);
    expect(r).toHaveLength(1);
  });

  it("is accent-insensitive — 'chateau' finds 'Château'", () => {
    const r = filterCollection(wines, { ...emptyFilters(), search: "chateau" }, YEAR);
    expect(r).toHaveLength(1);
  });

  it("requires ALL terms, so extra words narrow", () => {
    expect(
      filterCollection(wines, { ...emptyFilters(), search: "margaux 2015" }, YEAR),
    ).toHaveLength(1);
    expect(
      filterCollection(wines, { ...emptyFilters(), search: "margaux 2018" }, YEAR),
    ).toHaveLength(0);
  });

  it("searches geography", () => {
    expect(
      filterCollection(wines, { ...emptyFilters(), search: "bordeaux" }, YEAR),
    ).toHaveLength(3);
  });

  it("empty search returns everything", () => {
    expect(filterCollection(wines, emptyFilters(), YEAR)).toHaveLength(3);
  });
});

describe("filters", () => {
  const wines = [
    wine({ colour: "Red", grapes: ["Merlot"] }),
    wine({ colour: "White", grapes: ["Chardonnay"] }),
    wine({ colour: "Sparkling", grapes: ["Chardonnay", "Pinot Noir"] }),
  ];

  it("filters by colour", () => {
    expect(
      filterCollection(wines, { ...emptyFilters(), colours: ["Red"] }, YEAR),
    ).toHaveLength(1);
  });

  it("colour filter is OR within itself", () => {
    expect(
      filterCollection(wines, { ...emptyFilters(), colours: ["Red", "White"] }, YEAR),
    ).toHaveLength(2);
  });

  it("filters by grape, matching any", () => {
    expect(
      filterCollection(wines, { ...emptyFilters(), grapes: ["Chardonnay"] }, YEAR),
    ).toHaveLength(2);
  });

  it("hides wines with no active bottles by default", () => {
    const withEmpty = [...wines, wine({ colour: "Red" }, { activeBottles: 0 })];
    expect(filterCollection(withEmpty, emptyFilters(), YEAR)).toHaveLength(3);
    expect(
      filterCollection(withEmpty, { ...emptyFilters(), includeEmpty: true }, YEAR),
    ).toHaveLength(4);
  });

  it("filters by readiness", () => {
    const mixed = [
      wine({ drinkFrom: 2022, drinkUntil: 2035 }), // ready
      wine({ drinkFrom: 2032, drinkUntil: 2045 }), // young
      wine({ drinkFrom: 2000, drinkUntil: 2015 }), // past
    ];
    expect(
      filterCollection(mixed, { ...emptyFilters(), readiness: ["ready"] }, YEAR),
    ).toHaveLength(1);
    expect(
      filterCollection(mixed, { ...emptyFilters(), readiness: ["ready", "past"] }, YEAR),
    ).toHaveLength(2);
  });

  it("counts and detects active filters", () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false);
    const f = { ...emptyFilters(), colours: ["Red" as const], grapes: ["Merlot"] };
    expect(hasActiveFilters(f)).toBe(true);
    expect(countActiveFilters(f)).toBe(2);
  });
});

describe("sorting", () => {
  const wines = [
    wine({ name: "Zebra", vintage: 2010 }, { totalValue: 300, activeBottles: 1 }),
    wine({ name: "Apple", vintage: 2020 }, { totalValue: 100, activeBottles: 5 }),
    wine({ name: "Mango", vintage: null }, { totalValue: 200, activeBottles: 3 }),
  ];

  it("sorts by name", () => {
    expect(sortCollection(wines, "name").map((w) => w.wine.name)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });

  it("sorts by value descending", () => {
    expect(sortCollection(wines, "value", "desc").map((w) => w.totalValue)).toEqual([
      300, 200, 100,
    ]);
  });

  it("puts non-vintage last regardless of direction", () => {
    expect(sortCollection(wines, "vintage", "asc").at(-1)!.wine.vintage).toBeNull();
    expect(sortCollection(wines, "vintage", "desc").at(-1)!.wine.vintage).toBeNull();
  });

  it("sorts by bottle count", () => {
    expect(sortCollection(wines, "bottles", "desc").map((w) => w.activeBottles)).toEqual([
      5, 3, 1,
    ]);
  });

  it("ready wines sort first by readiness", () => {
    const mixed = [
      wine({ name: "Young", drinkFrom: 2032, drinkUntil: 2045 }),
      wine({ name: "Ready", drinkFrom: 2022, drinkUntil: 2035 }),
    ];
    expect(sortCollection(mixed, "readiness").map((w) => w.wine.name)[0]).toBe("Ready");
  });

  it("does not mutate the input", () => {
    const original = [...wines];
    sortCollection(wines, "name");
    expect(wines).toEqual(original);
  });
});

describe("totals and options", () => {
  it("sums bottles and value", () => {
    const t = summarise(
      [
        wine({}, { activeBottles: 3, totalValue: 150 }),
        wine({}, { activeBottles: 12, totalValue: 600 }),
      ],
      YEAR,
    );
    expect(t.wines).toBe(2);
    expect(t.bottles).toBe(15);
    expect(t.value).toBe(750);
  });

  it("counts only ready bottles as ready", () => {
    const t = summarise(
      [
        wine({ drinkFrom: 2022, drinkUntil: 2035 }, { activeBottles: 3 }),
        wine({ drinkFrom: 2040, drinkUntil: 2050 }, { activeBottles: 6 }),
      ],
      YEAR,
    );
    expect(t.readyNow).toBe(3);
  });

  it("derives options only from what is owned", () => {
    const o = deriveFilterOptions([
      wine({ colour: "Red", grapes: ["Merlot"] }),
      wine({ colour: "White", grapes: ["Chardonnay", "Merlot"] }),
    ]);
    expect(o.colours).toEqual(["Red", "White"]);
    expect(o.grapes).toEqual(["Chardonnay", "Merlot"]);
    expect(o.countries).toEqual([{ code: "FR", name: "France" }]);
    expect(o.locations).toEqual([{ id: "loc-1", name: "Home Cellar" }]);
  });
});
