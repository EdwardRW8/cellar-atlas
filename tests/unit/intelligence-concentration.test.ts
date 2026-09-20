import { describe, it, expect } from "vitest";
import {
  computeConcentration,
  significantSlices,
} from "@/domain/intelligence/concentration";
import { buildIntelligence } from "@/domain/intelligence";
import { emptyProfile } from "@/domain/intelligence/types";
import type { WineSummary, WineColour, GeoPath } from "@/domain/types";

function geo(code: string | null, name = "France"): GeoPath {
  return {
    country: code ? { id: `c-${code}`, name, code } : null,
    region: null,
    appellation: null,
    unmatched: code ? null : "Somewhere",
  };
}

function wine(over: Partial<WineSummary["wine"]> & { bottles?: number } = {}): WineSummary {
  const { bottles = 1, ...rest } = over;
  return {
    wine: {
      id: Math.random().toString(36).slice(2),
      producer: "Test Estate",
      name: "Test Wine",
      vintage: 2018,
      colour: "Red" as WineColour,
      grapes: [],
      geography: geo("FR"),
      drinkFrom: 2020,
      drinkUntil: 2040,
      notes: null,
      version: 1,
      ...rest,
    },
    activeBottles: bottles,
    totalBottles: bottles,
    locations: [],
    totalValue: null,
    valuation: { valuedBottles: 0, activeBottles: 0 },
  };
}

const dim = (wines: WineSummary[], d: string) =>
  computeConcentration(wines).find((x) => x.dimension === d)!;

describe("concentration reports shares, never judgements", () => {
  it("computes colour shares", () => {
    const d = dim(
      [wine({ colour: "Red", bottles: 6 }), wine({ colour: "White", bottles: 2 })],
      "colour",
    );
    expect(d.largest!.label).toBe("Red");
    expect(d.largest!.percentage).toBe(75);
  });

  it("PERCENTAGES SUM TO 100 across classified bottles", () => {
    const d = dim(
      [
        wine({ colour: "Red", bottles: 3 }),
        wine({ colour: "White", bottles: 1 }),
        wine({ colour: "Sparkling", bottles: 4 }),
      ],
      "colour",
    );
    expect(Math.round(d.slices.reduce((n, s) => n + s.percentage, 0))).toBe(100);
  });

  it("carries no verdict, rating or flag", () => {
    const json = JSON.stringify(computeConcentration([wine()])).toLowerCase();
    for (const banned of ["score", "rating", "verdict", "warning", "risk", "good", "bad"]) {
      expect(json).not.toContain(banned);
    }
  });

  it("sorts slices largest first", () => {
    const d = dim(
      [wine({ colour: "White", bottles: 1 }), wine({ colour: "Red", bottles: 9 })],
      "colour",
    );
    expect(d.slices[0]!.label).toBe("Red");
  });
});

describe("unclassified bottles are excluded, not counted as a category", () => {
  it("excludes wines with no colour", () => {
    const d = dim(
      [wine({ colour: "Red", bottles: 5 }), wine({ colour: null, bottles: 3 })],
      "colour",
    );
    expect(d.classifiedBottles).toBe(5);
    expect(d.unclassifiedBottles).toBe(3);
    expect(d.largest!.percentage).toBe(100);
  });

  it("excludes wines with no vintage", () => {
    const d = dim(
      [wine({ vintage: 2018, bottles: 4 }), wine({ vintage: null, bottles: 2 })],
      "decade",
    );
    expect(d.unclassifiedBottles).toBe(2);
  });

  it("everything unclassified leaves no slices and no crash", () => {
    const d = dim([wine({ colour: null, bottles: 5 })], "colour");
    expect(d.slices).toEqual([]);
    expect(d.largest).toBeNull();
    expect(d.classifiedBottles).toBe(0);
  });
});

describe("geography uses the canonical hierarchy only", () => {
  it("groups by canonical country", () => {
    const d = dim(
      [
        wine({ geography: geo("FR", "France"), bottles: 6 }),
        wine({ geography: geo("IT", "Italy"), bottles: 2 }),
      ],
      "country",
    );
    expect(d.slices.map((s) => s.label)).toEqual(["France", "Italy"]);
  });

  it("free text is NOT treated as a country", () => {
    const d = dim([wine({ geography: geo(null), bottles: 5 })], "country");
    expect(d.slices).toEqual([]);
    expect(d.unclassifiedBottles).toBe(5);
  });
});

describe("producer matching is exact — never fuzzy", () => {
  it("groups identical producers", () => {
    const d = dim(
      [
        wine({ producer: "Château Margaux", bottles: 3 }),
        wine({ producer: "Château Margaux", bottles: 2 }),
      ],
      "producer",
    );
    expect(d.slices).toHaveLength(1);
    expect(d.slices[0]!.bottles).toBe(5);
  });

  it("is case and whitespace insensitive", () => {
    const d = dim(
      [wine({ producer: "Test Estate" }), wine({ producer: "  test estate  " })],
      "producer",
    );
    expect(d.slices).toHaveLength(1);
  });

  it("does NOT merge differently-written names", () => {
    // Understating concentration is the honest error; merging two real
    // estates would be worse.
    const d = dim(
      [wine({ producer: "Château Margaux" }), wine({ producer: "Ch. Margaux" })],
      "producer",
    );
    expect(d.slices).toHaveLength(2);
  });
});

describe("vintage decades", () => {
  it("buckets by decade", () => {
    const d = dim(
      [wine({ vintage: 2018 }), wine({ vintage: 2015 }), wine({ vintage: 2003 })],
      "decade",
    );
    expect(d.slices.map((s) => s.label).sort()).toEqual(["2000s", "2010s"]);
  });

  it("handles a boundary year", () => {
    const d = dim([wine({ vintage: 2020 })], "decade");
    expect(d.slices[0]!.label).toBe("2020s");
  });
});

describe("significant slices keep the list readable", () => {
  it("groups small slices into an Other bucket", () => {
    const wines = [
      wine({ producer: "Big", bottles: 90 }),
      ...Array.from({ length: 10 }, (_, i) => wine({ producer: `Small ${i}`, bottles: 1 })),
    ];
    const sliced = significantSlices(dim(wines, "producer"));
    expect(sliced.at(-1)!.key).toBe("__other__");
    expect(sliced.at(-1)!.bottles).toBe(10);
  });

  it("does NOT create an Other bucket when nothing is small", () => {
    const sliced = significantSlices(
      dim(
        [wine({ colour: "Red", bottles: 5 }), wine({ colour: "White", bottles: 5 })],
        "colour",
      ),
    );
    expect(sliced.some((s) => s.key === "__other__")).toBe(false);
  });
});

describe("composition", () => {
  it("builds every result in one pass", () => {
    const i = buildIntelligence([wine({ bottles: 5 })], [], null, new Date("2026-06-01"));
    expect(i.activeBottles).toBe(5);
    expect(i.concentration).toHaveLength(4);
    expect(i.isEmpty).toBe(false);
  });

  it("reports an empty cellar", () => {
    const i = buildIntelligence([], [], null, new Date("2026-06-01"));
    expect(i.isEmpty).toBe(true);
    expect(i.activeBottles).toBe(0);
  });

  it("a cellar of only consumed bottles is empty", () => {
    const i = buildIntelligence([wine({ bottles: 0 })], [], null, new Date("2026-06-01"));
    expect(i.isEmpty).toBe(true);
  });

  it("reports whether a usable profile exists", () => {
    const now = new Date("2026-06-01");
    expect(buildIntelligence([wine()], [], null, now).hasProfile).toBe(false);
    expect(buildIntelligence([wine()], [], emptyProfile(), now).hasProfile).toBe(false);
    expect(
      buildIntelligence([wine()], [], { ...emptyProfile(), bottlesPerMonth: 3 }, now)
        .hasProfile,
    ).toBe(true);
  });

  it("is pure — repeated calls agree", () => {
    const wines = [wine({ producer: "Fixed" })];
    const now = new Date("2026-06-01");
    expect(buildIntelligence(wines, [], null, now)).toEqual(
      buildIntelligence(wines, [], null, now),
    );
  });

  it("does not mutate its inputs", () => {
    const wines = [wine({ producer: "Fixed" })];
    const before = JSON.stringify(wines);
    buildIntelligence(wines, [], null, new Date("2026-06-01"));
    expect(JSON.stringify(wines)).toBe(before);
  });
});
