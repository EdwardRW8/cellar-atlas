import { describe, it, expect } from "vitest";
import {
  buildAtlasData,
  metricValue,
  formatMetric,
  shadeIntensity,
  symbolRadius,
  interactiveCountryCodes,
  ATLAS_METRICS,
} from "@/domain/atlas-aggregation";
import type { WineSummary, GeoPath } from "@/domain/types";

const YEAR = 2026;

function geo(
  country: [string, string] | null,
  region?: [string, string],
  appellation?: [string, string],
  unmatched?: string,
): GeoPath {
  return {
    country: country ? { id: `c-${country[0]}`, name: country[1], code: country[0] } : null,
    region: region ? { id: `r-${region[0]}`, name: region[1] } : null,
    appellation: appellation ? { id: `a-${appellation[0]}`, name: appellation[1] } : null,
    unmatched: unmatched ?? null,
  };
}

function wine(
  geography: GeoPath,
  sum: Partial<WineSummary> = {},
  over: Partial<WineSummary["wine"]> = {},
): WineSummary {
  return {
    wine: {
      id: over.id ?? Math.random().toString(36).slice(2),
      producer: "Test Estate",
      name: "Test Wine",
      vintage: 2018,
      colour: "Red",
      grapes: [],
      geography,
      drinkFrom: 2020,
      drinkUntil: 2040,
      notes: null,
      version: 1,
      ...over,
    },
    activeBottles: 3,
    totalBottles: 3,
    locations: [],
    totalValue: 150,
    valuation: { valuedBottles: 0, activeBottles: 0 },
    ...sum,
  };
}

const FR = geo(["FR", "France"], ["bdx", "Bordeaux"], ["pau", "Pauillac"]);
const IT = geo(["IT", "Italy"], ["pie", "Piedmont"], ["bar", "Barolo"]);

// ═══════════════════════════════════════════════════════════════════════════
// AGGREGATION UP THE CANONICAL HIERARCHY
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregation rolls up through all three levels", () => {
  it("aggregates a wine into country, region and appellation", () => {
    const d = buildAtlasData([wine(FR, { activeBottles: 6 })], undefined, YEAR);
    expect(d.countries[0]!.bottles).toBe(6);
    expect(d.regionsByCountry.FR![0]!.bottles).toBe(6);
    expect(d.appellationsByRegion["r-bdx"]![0]!.bottles).toBe(6);
  });

  it("sums several wines into one country node", () => {
    const d = buildAtlasData(
      [wine(FR, { activeBottles: 6 }), wine(FR, { activeBottles: 4 })],
      undefined,
      YEAR,
    );
    expect(d.countries).toHaveLength(1);
    expect(d.countries[0]!.bottles).toBe(10);
    expect(d.countries[0]!.wines).toBe(2);
  });

  it("keeps countries separate", () => {
    const d = buildAtlasData([wine(FR), wine(IT)], undefined, YEAR);
    expect(d.countries.map((c) => c.countryCode).sort()).toEqual(["FR", "IT"]);
  });

  it("a wine with ONLY a country stops at country level", () => {
    const d = buildAtlasData([wine(geo(["ES", "Spain"]))], undefined, YEAR);
    expect(d.countries[0]!.bottles).toBe(3);
    expect(d.regionsByCountry.ES).toBeUndefined();
  });

  it("a wine with country and region but no appellation stops at region", () => {
    const d = buildAtlasData(
      [wine(geo(["PT", "Portugal"], ["dou", "Douro"]))],
      undefined,
      YEAR,
    );
    expect(d.regionsByCountry.PT![0]!.name).toBe("Douro");
    expect(d.appellationsByRegion["r-dou"]).toBeUndefined();
  });

  it("sorts nodes by bottle count descending", () => {
    const d = buildAtlasData(
      [wine(FR, { activeBottles: 2 }), wine(IT, { activeBottles: 9 })],
      undefined,
      YEAR,
    );
    expect(d.countries.map((c) => c.countryCode)).toEqual(["IT", "FR"]);
  });

  it("ignores wines with no bottles left", () => {
    const d = buildAtlasData([wine(FR, { activeBottles: 0 })], undefined, YEAR);
    expect(d.countries).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INCOMPLETE GEOGRAPHY IS NEVER SILENTLY DISCARDED
// ═══════════════════════════════════════════════════════════════════════════

describe("incomplete geography is counted, never dropped", () => {
  it("a wine with no country goes to unmapped", () => {
    const d = buildAtlasData(
      [wine(geo(null, undefined, undefined, "Somewhere"), { activeBottles: 5 })],
      undefined,
      YEAR,
    );
    expect(d.unmapped.wines).toBe(1);
    expect(d.unmapped.bottles).toBe(5);
    expect(d.countries).toHaveLength(0);
  });

  it("EVERY bottle is accounted for — mapped plus unmapped", () => {
    const wines = [
      wine(FR, { activeBottles: 6 }),
      wine(IT, { activeBottles: 4 }),
      wine(geo(null), { activeBottles: 7 }),
    ];
    const d = buildAtlasData(wines, undefined, YEAR);
    const total = wines.reduce((n, w) => n + w.activeBottles, 0);
    expect(d.totalMappedBottles + d.unmapped.bottles).toBe(total);
  });

  it("surfaces the free text the user actually typed", () => {
    const d = buildAtlasData(
      [wine(geo(null, undefined, undefined, "Mystery Valley"))],
      undefined,
      YEAR,
    );
    expect(d.unmapped.examples).toContain("Mystery Valley");
  });

  it("falls back to the producer when there is no free text", () => {
    const d = buildAtlasData(
      [wine(geo(null), {}, { producer: "Unknown Estate" })],
      undefined,
      YEAR,
    );
    expect(d.unmapped.examples).toContain("Unknown Estate");
  });

  it("caps examples so the banner stays short", () => {
    const wines = Array.from({ length: 20 }, (_, i) =>
      wine(geo(null, undefined, undefined, `Place ${i}`)),
    );
    expect(
      buildAtlasData(wines, undefined, YEAR).unmapped.examples.length,
    ).toBeLessThanOrEqual(5);
  });

  it("a cellar of ONLY unmapped wines is not empty", () => {
    const d = buildAtlasData([wine(geo(null))], undefined, YEAR);
    expect(d.isEmpty).toBe(false);
    expect(d.unmapped.wines).toBe(1);
  });

  it("a cellar with nothing at all is empty", () => {
    const d = buildAtlasData([], undefined, YEAR);
    expect(d.isEmpty).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NO INVENTED GEOGRAPHY
// ═══════════════════════════════════════════════════════════════════════════

describe("geography is never inferred", () => {
  it("free text alone does NOT create a country node", () => {
    const d = buildAtlasData(
      [wine(geo(null, undefined, undefined, "Bordeaux"))],
      undefined,
      YEAR,
    );
    // "Bordeaux" as free text must not conjure a France node.
    expect(d.countries).toHaveLength(0);
    expect(d.unmapped.wines).toBe(1);
  });

  it("only countries with canonical data are interactive", () => {
    const d = buildAtlasData([wine(FR)], undefined, YEAR);
    const codes = interactiveCountryCodes(d);
    expect(codes.has("FR")).toBe(true);
    expect(codes.has("DE")).toBe(false);
    expect(codes.size).toBe(1);
  });

  it("no node is created without a canonical id", () => {
    const d = buildAtlasData([wine(FR), wine(geo(null))], undefined, YEAR);
    for (const n of d.countries) expect(n.id).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VERIFIED CENTROIDS
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinates come from the canonical hierarchy", () => {
  const centroids = new Map([
    ["c-FR", { latitude: 46.6, longitude: 2.2, precision: "approximate" }],
    ["r-bdx", { latitude: 44.84, longitude: -0.58, precision: "approximate" }],
  ]);

  it("applies verified centroids to country and region nodes", () => {
    const d = buildAtlasData([wine(FR)], centroids, YEAR);
    expect(d.countries[0]!.latitude).toBe(46.6);
    expect(d.regionsByCountry.FR![0]!.longitude).toBe(-0.58);
  });

  it("carries the recorded precision, so the UI can be honest", () => {
    const d = buildAtlasData([wine(FR)], centroids, YEAR);
    expect(d.countries[0]!.centroidPrecision).toBe("approximate");
  });

  it("a node with no centroid keeps null coordinates — never a guess", () => {
    const d = buildAtlasData([wine(FR)], centroids, YEAR);
    const appellation = d.appellationsByRegion["r-bdx"]![0]!;
    expect(appellation.latitude).toBeNull();
    expect(appellation.centroidPrecision).toBe("none");
  });

  it("aggregation works with no centroids at all", () => {
    const d = buildAtlasData([wine(FR)], undefined, YEAR);
    expect(d.countries[0]!.bottles).toBe(3);
    expect(d.countries[0]!.latitude).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════════════════

describe("metrics", () => {
  it("offers exactly the four specified metrics", () => {
    expect(ATLAS_METRICS.map((m) => m.key)).toEqual([
      "bottles",
      "value",
      "percentage",
      "ready",
    ]);
  });

  it("counts ready bottles by drinking window", () => {
    const d = buildAtlasData(
      [
        wine(FR, { activeBottles: 4 }, { drinkFrom: 2020, drinkUntil: 2040 }),
        wine(FR, { activeBottles: 2 }, { drinkFrom: 2050, drinkUntil: 2060 }),
      ],
      undefined,
      YEAR,
    );
    expect(d.countries[0]!.bottles).toBe(6);
    expect(d.countries[0]!.readyBottles).toBe(4);
  });

  it("sums value, treating a missing valuation as zero not null", () => {
    const d = buildAtlasData(
      [wine(FR, { totalValue: 200 }), wine(FR, { totalValue: null })],
      undefined,
      YEAR,
    );
    expect(d.countries[0]!.value).toBe(200);
  });

  it("PERCENTAGES SUM TO 100 across countries", () => {
    const d = buildAtlasData(
      [
        wine(FR, { activeBottles: 3 }),
        wine(IT, { activeBottles: 1 }),
        wine(geo(["ES", "Spain"]), { activeBottles: 4 }),
      ],
      undefined,
      YEAR,
    );
    const total = d.countries.reduce((n, c) => n + c.percentage, 0);
    expect(Math.round(total)).toBe(100);
  });

  it("percentages are of the MAPPED collection, so unmapped does not skew them", () => {
    const d = buildAtlasData(
      [wine(FR, { activeBottles: 5 }), wine(geo(null), { activeBottles: 95 })],
      undefined,
      YEAR,
    );
    expect(d.countries[0]!.percentage).toBe(100);
  });

  it("metricValue reads each metric correctly", () => {
    const d = buildAtlasData(
      [wine(FR, { activeBottles: 4, totalValue: 80 })],
      undefined,
      YEAR,
    );
    const n = d.countries[0]!;
    expect(metricValue(n, "bottles")).toBe(4);
    expect(metricValue(n, "value")).toBe(80);
    expect(metricValue(n, "percentage")).toBe(100);
    expect(metricValue(n, "ready")).toBe(4);
  });

  it("formats value as currency and shows a dash when zero", () => {
    const withValue = buildAtlasData([wine(FR, { totalValue: 250 })], undefined, YEAR);
    const without = buildAtlasData([wine(FR, { totalValue: null })], undefined, YEAR);
    expect(formatMetric(withValue.countries[0]!, "value")).toMatch(/£250/);
    expect(formatMetric(without.countries[0]!, "value")).toBe("—");
  });

  it("pluralises bottles", () => {
    const one = buildAtlasData([wine(FR, { activeBottles: 1 })], undefined, YEAR);
    expect(formatMetric(one.countries[0]!, "bottles")).toBe("1 bottle");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SHADING AND SYMBOLS
// ═══════════════════════════════════════════════════════════════════════════

describe("shading and symbol sizing", () => {
  const nodes = buildAtlasData(
    [
      wine(FR, { activeBottles: 10 }),
      wine(IT, { activeBottles: 2 }),
      wine(geo(["ES", "Spain"]), { activeBottles: 0 }),
    ],
    undefined,
    YEAR,
  ).countries;

  it("the largest node reaches full intensity", () => {
    expect(shadeIntensity(nodes[0]!, nodes, "bottles")).toBe(1);
  });

  it("a smaller node shades less, but remains visible", () => {
    const small = shadeIntensity(nodes[1]!, nodes, "bottles");
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(1);
  });

  it("returns ZERO when no node has a value — no false shading", () => {
    // A collection with no valuations must not shade every country alike.
    const noValue = buildAtlasData(
      [wine(FR, { totalValue: null }), wine(IT, { totalValue: null })],
      undefined,
      YEAR,
    ).countries;
    for (const n of noValue) {
      expect(shadeIntensity(n, noValue, "value")).toBe(0);
    }
  });

  it("symbol radius grows with value but never below the minimum", () => {
    const big = symbolRadius(nodes[0]!, nodes, "bottles", 1, 5);
    const small = symbolRadius(nodes[1]!, nodes, "bottles", 1, 5);
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(1);
    expect(big).toBeLessThanOrEqual(5);
  });

  it("a zero-value node gets the minimum radius, not zero", () => {
    const noValue = buildAtlasData(
      [wine(FR, { totalValue: null })],
      undefined,
      YEAR,
    ).countries;
    expect(symbolRadius(noValue[0]!, noValue, "value", 0.6, 4)).toBe(0.6);
  });
});

describe("purity", () => {
  it("repeated calls give identical results", () => {
    const wines = [wine(FR, {}, { id: "fixed" })];
    expect(buildAtlasData(wines, undefined, YEAR)).toEqual(
      buildAtlasData(wines, undefined, YEAR),
    );
  });

  it("does not mutate its input", () => {
    const wines = [wine(FR, {}, { id: "a" })];
    const before = JSON.stringify(wines);
    buildAtlasData(wines, undefined, YEAR);
    expect(JSON.stringify(wines)).toBe(before);
  });

  it("carries no Phase 8 field", () => {
    const json = JSON.stringify(buildAtlasData([wine(FR)], undefined, YEAR));
    for (const banned of ["score", "forecast", "predict", "recommend", "trend", "risk"]) {
      expect(json.toLowerCase()).not.toContain(banned);
    }
  });
});
