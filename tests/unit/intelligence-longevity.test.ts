import { describe, it, expect } from "vitest";
import {
  computeLongevity,
  computeLegacyOutlook,
  pastWindowBottles,
  PROJECTION_YEARS,
} from "@/domain/intelligence/longevity";
import { computeConsumptionCapacity } from "@/domain/intelligence/consumption";
import { emptyProfile, type CellarProfile } from "@/domain/intelligence/types";
import type { WineSummary, DomainBottle, BottleStatus } from "@/domain/types";

const YEAR = 2026;
const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function wine(
  from: number | null,
  until: number | null,
  bottles = 1,
  over: Partial<WineSummary["wine"]> = {},
): WineSummary {
  return {
    wine: {
      id: Math.random().toString(36).slice(2),
      producer: "Test",
      name: "Test Wine",
      vintage: 2018,
      colour: "Red",
      grapes: [],
      geography: { country: null, region: null, appellation: null, unmatched: null },
      drinkFrom: from,
      drinkUntil: until,
      notes: null,
      version: 1,
      ...over,
    },
    activeBottles: bottles,
    totalBottles: bottles,
    locations: [],
    totalValue: null,
    valuation: { valuedBottles: 0, activeBottles: 0 },
  };
}

function consumedBottles(n: number, spanDays: number): DomainBottle[] {
  return Array.from({ length: n }, (_, i) => ({
    id: Math.random().toString(36).slice(2),
    wineDefinitionId: "w",
    acquisitionItemId: null,
    bottleSize: "750ml" as const,
    storageLocationId: null,
    position: null,
    positionKey: null,
    status: "consumed" as BottleStatus,
    statusChangedAt: daysAgo(Math.round((i / Math.max(1, n - 1)) * spanDays)),
    currentValue: null,
    currentValueAt: null,
    notes: null,
    version: 1,
    isActive: false,
  }));
}

/** ~24 bottles/year observed. */
const observedCapacity = () =>
  computeConsumptionCapacity(consumedBottles(24, 360), null, NOW);

const profileCapacity = (perMonth: number) =>
  computeConsumptionCapacity([], { ...emptyProfile(), bottlesPerMonth: perMonth }, NOW);

const noCapacity = () => computeConsumptionCapacity([], null, NOW);

// ═══════════════════════════════════════════════════════════════════════════
// LONGEVITY — MATURATION vs CAPACITY
// ═══════════════════════════════════════════════════════════════════════════

describe("longevity models maturation against capacity", () => {
  it("reports the three projection horizons", () => {
    const r = computeLongevity([wine(2020, 2040, 10)], observedCapacity(), YEAR);
    expect(r.windows.map((w) => w.years)).toEqual([...PROJECTION_YEARS]);
  });

  it("counts bottles DRINKABLE within a period, not merely owned", () => {
    const r = computeLongevity(
      [
        wine(2020, 2030, 10), // open now
        wine(2035, 2050, 20), // opens well after 5 years
      ],
      observedCapacity(),
      YEAR,
    );
    const fiveYear = r.windows.find((w) => w.years === 5)!;
    expect(fiveYear.drinkableBottles).toBe(10);
  });

  it("counts bottles becoming NEWLY ready in a period", () => {
    const r = computeLongevity(
      [wine(2020, 2040, 5), wine(2029, 2045, 7)],
      observedCapacity(),
      YEAR,
    );
    const fiveYear = r.windows.find((w) => w.years === 5)!;
    expect(fiveYear.newlyReadyBottles).toBe(7);
  });

  it("counts bottles whose window CLOSES within a period", () => {
    const r = computeLongevity(
      [wine(2020, 2028, 6), wine(2020, 2060, 40)],
      observedCapacity(),
      YEAR,
    );
    const fiveYear = r.windows.find((w) => w.years === 5)!;
    expect(fiveYear.closingBottles).toBe(6);
  });

  it("projects expected consumption as a RANGE, not a point", () => {
    const r = computeLongevity([wine(2020, 2040, 100)], profileCapacity(2), YEAR);
    const fiveYear = r.windows.find((w) => w.years === 5)!;
    // 2/month = 24/year, 5 years = 120.
    expect(fiveYear.expectedConsumption!.low).toBeLessThan(120);
    expect(fiveYear.expectedConsumption!.high).toBeGreaterThan(120);
  });

  it("CAPACITY EXCEEDS maturing inventory — no surplus", () => {
    // 10 bottles closing in 5 years against ~120 of capacity.
    const r = computeLongevity([wine(2020, 2029, 10)], profileCapacity(2), YEAR);
    const fiveYear = r.windows.find((w) => w.years === 5)!;
    expect(fiveYear.surplusClosing).toBe(0);
  });

  it("CAPACITY BELOW maturing inventory — surplus reported", () => {
    // 300 bottles closing in 5 years against ~120 of capacity.
    const r = computeLongevity([wine(2020, 2029, 300)], profileCapacity(2), YEAR);
    const fiveYear = r.windows.find((w) => w.years === 5)!;
    expect(fiveYear.surplusClosing).toBeGreaterThan(100);
  });

  it("years-of-drinking is present but is only a SUPPORTING fact", () => {
    const r = computeLongevity([wine(2020, 2040, 48)], profileCapacity(2), YEAR);
    // 48 bottles at 24/year ≈ 2 years.
    expect(r.yearsOfDrinkingAtCurrentRate).not.toBeNull();
    expect(r.yearsOfDrinkingAtCurrentRate!.low).toBeLessThanOrEqual(2);
    expect(r.yearsOfDrinkingAtCurrentRate!.high).toBeGreaterThanOrEqual(2);
  });
});

describe("missing drinking windows are excluded and reported", () => {
  it("a wine with NO window is excluded from projections", () => {
    const r = computeLongevity(
      [wine(2020, 2040, 10), wine(null, null, 31)],
      observedCapacity(),
      YEAR,
    );
    expect(r.withWindow).toBe(10);
    expect(r.withoutWindow).toBe(31);
    expect(r.evidence.missingWindows).toBe(31);
  });

  it("NEVER invents a window", () => {
    const r = computeLongevity([wine(null, null, 50)], observedCapacity(), YEAR);
    for (const w of r.windows) {
      expect(w.drinkableBottles).toBe(0);
      expect(w.closingBottles).toBe(0);
      expect(w.newlyReadyBottles).toBe(0);
    }
  });

  it("a PARTIAL window is still usable", () => {
    const openEnded = computeLongevity([wine(2020, null, 10)], observedCapacity(), YEAR);
    expect(openEnded.withWindow).toBe(10);
    expect(openEnded.withoutWindow).toBe(0);

    const noStart = computeLongevity([wine(null, 2030, 10)], observedCapacity(), YEAR);
    expect(noStart.withWindow).toBe(10);
  });

  it("an open-ended window never counts as closing", () => {
    const r = computeLongevity([wine(2020, null, 10)], observedCapacity(), YEAR);
    for (const w of r.windows) expect(w.closingBottles).toBe(0);
  });

  it("hasProjection is false when nothing has a window", () => {
    expect(
      computeLongevity([wine(null, null, 10)], observedCapacity(), YEAR).hasProjection,
    ).toBe(false);
  });

  it("hasProjection is false without capacity", () => {
    expect(computeLongevity([wine(2020, 2040, 10)], noCapacity(), YEAR).hasProjection).toBe(
      false,
    );
  });
});

describe("consumed bottles are excluded from inventory", () => {
  it("counts only ACTIVE bottles", () => {
    const w = wine(2020, 2040, 5);
    w.totalBottles = 20; // 15 already drunk
    const r = computeLongevity([w], observedCapacity(), YEAR);
    expect(r.activeBottles).toBe(5);
  });

  it("a wine with zero active bottles contributes nothing", () => {
    const r = computeLongevity([wine(2020, 2040, 0)], observedCapacity(), YEAR);
    expect(r.activeBottles).toBe(0);
    expect(r.withWindow).toBe(0);
  });
});

describe("no capacity means no projection, not a zero projection", () => {
  it("expected consumption is null throughout", () => {
    const r = computeLongevity([wine(2020, 2040, 10)], noCapacity(), YEAR);
    for (const w of r.windows) {
      expect(w.expectedConsumption).toBeNull();
      expect(w.surplusClosing).toBeNull();
    }
  });

  it("years-of-drinking is null", () => {
    expect(
      computeLongevity([wine(2020, 2040, 10)], noCapacity(), YEAR)
        .yearsOfDrinkingAtCurrentRate,
    ).toBeNull();
  });

  it("but the inventory counts are still reported", () => {
    const r = computeLongevity([wine(2020, 2040, 10)], noCapacity(), YEAR);
    expect(r.windows.find((w) => w.years === 5)!.drinkableBottles).toBe(10);
  });
});

describe("empty cellar", () => {
  it("reports zeroes without crashing", () => {
    const r = computeLongevity([], observedCapacity(), YEAR);
    expect(r.activeBottles).toBe(0);
    expect(r.hasProjection).toBe(false);
    expect(r.yearsOfDrinkingAtCurrentRate!.low).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY OUTLOOK
// ═══════════════════════════════════════════════════════════════════════════

const withHorizon = (years: number): CellarProfile => ({
  ...emptyProfile(),
  collectingHorizonYears: years,
  bottlesPerMonth: 2,
});

describe("legacy outlook needs a horizon", () => {
  it("reports hasHorizon false when none is set — prompt, never guess", () => {
    const r = computeLegacyOutlook([wine(2020, 2080, 10)], observedCapacity(), null, YEAR);
    expect(r.hasHorizon).toBe(false);
    expect(r.horizonYears).toBeNull();
    expect(r.beyondHorizonBottles).toBe(0);
  });

  it("an empty profile is the same as no horizon", () => {
    expect(
      computeLegacyOutlook([wine(2020, 2080, 10)], observedCapacity(), emptyProfile(), YEAR)
        .hasHorizon,
    ).toBe(false);
  });

  it("still reports missing windows without a horizon", () => {
    const r = computeLegacyOutlook([wine(null, null, 7)], observedCapacity(), null, YEAR);
    expect(r.withoutWindow).toBe(7);
  });
});

describe("beyond-horizon is informational, NOT a risk", () => {
  it("counts bottles still drinkable after the horizon", () => {
    const r = computeLegacyOutlook(
      [wine(2020, 2080, 12), wine(2020, 2030, 5)],
      observedCapacity(),
      withHorizon(10),
      YEAR,
    );
    expect(r.beyondHorizonBottles).toBe(12);
    expect(r.beyondHorizonWines).toBe(1);
  });

  it("a long-lived wine is NOT counted as a consumption conflict", () => {
    // 12 bottles lasting to 2080: nothing forces drinking them soon.
    const r = computeLegacyOutlook(
      [wine(2020, 2080, 12)],
      profileCapacity(2),
      withHorizon(10),
      YEAR,
    );
    expect(r.beyondHorizonBottles).toBe(12);
    expect(r.consumptionConflictBottles).toBe(0);
  });

  it("an open-ended window counts as beyond the horizon", () => {
    const r = computeLegacyOutlook(
      [wine(2020, null, 4)],
      observedCapacity(),
      withHorizon(5),
      YEAR,
    );
    expect(r.beyondHorizonBottles).toBe(4);
  });
});

describe("consumption conflict is the genuine pressure", () => {
  it("reports a conflict when closing bottles exceed capacity", () => {
    // 500 bottles must be drunk within 10 years.
    // Capacity 2/month = 24/year; over 10 years = 240; upper band = 300.
    // Conflict = 500 - 300 = exactly 200.
    const r = computeLegacyOutlook(
      [wine(2020, 2034, 500)],
      profileCapacity(2),
      withHorizon(10),
      YEAR,
    );
    expect(r.expectedConsumptionOverHorizon!.high).toBe(300);
    expect(r.consumptionConflictBottles).toBe(200);
  });

  it("reports NO conflict when capacity is ample", () => {
    const r = computeLegacyOutlook(
      [wine(2020, 2034, 20)],
      profileCapacity(5),
      withHorizon(10),
      YEAR,
    );
    expect(r.consumptionConflictBottles).toBe(0);
  });

  it("conflict is zero without capacity, rather than a false alarm", () => {
    const r = computeLegacyOutlook(
      [wine(2020, 2030, 500)],
      noCapacity(),
      withHorizon(10),
      YEAR,
    );
    expect(r.consumptionConflictBottles).toBe(0);
    expect(r.expectedConsumptionOverHorizon).toBeNull();
  });

  it("distinguishes beyond-horizon from conflict in the same cellar", () => {
    const r = computeLegacyOutlook(
      [
        wine(2020, 2080, 30), // beyond horizon, deliberate
        wine(2020, 2030, 400), // must be drunk soon
      ],
      profileCapacity(2),
      withHorizon(10),
      YEAR,
    );
    expect(r.beyondHorizonBottles).toBe(30);
    // 400 closing within the horizon, upper band 300 → 100 surplus.
    expect(r.consumptionConflictBottles).toBe(100);
  });
});

describe("evidence metadata is correct throughout", () => {
  it("longevity carries the capacity's evidence plus window exclusions", () => {
    const r = computeLongevity(
      [wine(2020, 2040, 10), wine(null, null, 4)],
      observedCapacity(),
      YEAR,
    );
    expect(r.evidence.source).toBe("observed");
    expect(r.evidence.sampleSize).toBe(24);
    expect(r.evidence.missingWindows).toBe(4);
  });

  it("marks profile-sourced evidence as such", () => {
    const r = computeLongevity([wine(2020, 2040, 10)], profileCapacity(3), YEAR);
    expect(r.evidence.source).toBe("profile");
  });

  it("marks mixed evidence when both exist", () => {
    const capacity = computeConsumptionCapacity(
      consumedBottles(24, 360),
      { ...emptyProfile(), bottlesPerMonth: 3 },
      NOW,
    );
    expect(computeLongevity([wine(2020, 2040, 5)], capacity, YEAR).evidence.source).toBe(
      "mixed",
    );
  });

  it("legacy carries evidence too", () => {
    const r = computeLegacyOutlook(
      [wine(2020, 2080, 10), wine(null, null, 3)],
      observedCapacity(),
      withHorizon(10),
      YEAR,
    );
    expect(r.evidence.missingWindows).toBe(3);
    expect(r.evidence.sampleSize).toBe(24);
  });

  it("no result carries a numeric confidence", () => {
    const json = JSON.stringify({
      l: computeLongevity([wine(2020, 2040, 5)], observedCapacity(), YEAR),
      g: computeLegacyOutlook(
        [wine(2020, 2040, 5)],
        observedCapacity(),
        withHorizon(5),
        YEAR,
      ),
    }).toLowerCase();
    for (const banned of ["confidence", "score", "certainty"]) {
      expect(json).not.toContain(banned);
    }
  });
});

describe("past-window bottles", () => {
  it("counts bottles whose window has closed", () => {
    expect(pastWindowBottles([wine(2000, 2015, 6), wine(2020, 2040, 3)], YEAR)).toBe(6);
  });

  it("ignores wines with no window", () => {
    expect(pastWindowBottles([wine(null, null, 9)], YEAR)).toBe(0);
  });

  it("ignores consumed bottles", () => {
    expect(pastWindowBottles([wine(2000, 2015, 0)], YEAR)).toBe(0);
  });
});
