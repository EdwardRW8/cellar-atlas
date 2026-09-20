import { describe, it, expect } from "vitest";
import {
  computeConsumptionCapacity,
  projectionRange,
  MIN_CONSUMED_BOTTLES,
  MIN_HISTORY_DAYS,
  PROJECTION_BAND,
} from "@/domain/intelligence/consumption";
import { emptyProfile, type CellarProfile } from "@/domain/intelligence/types";
import type { DomainBottle, BottleStatus } from "@/domain/types";

const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function bottle(status: BottleStatus, changedAt: string | null): DomainBottle {
  return {
    id: Math.random().toString(36).slice(2),
    wineDefinitionId: "w1",
    acquisitionItemId: null,
    bottleSize: "750ml",
    storageLocationId: null,
    position: null,
    positionKey: null,
    status,
    statusChangedAt: changedAt,
    currentValue: null,
    currentValueAt: null,
    notes: null,
    version: 1,
    isActive: status === "in_cellar",
  };
}

/** n consumed bottles spread evenly across the trailing `spanDays`. */
function consumed(n: number, spanDays: number): DomainBottle[] {
  return Array.from({ length: n }, (_, i) =>
    bottle("consumed", daysAgo(Math.round((i / Math.max(1, n - 1)) * spanDays))),
  );
}

const profileWith = (over: Partial<CellarProfile>): CellarProfile => ({
  ...emptyProfile(),
  ...over,
});

describe("observed consumption requires enough evidence", () => {
  it("uses observation when both floors are met", () => {
    const r = computeConsumptionCapacity(consumed(12, 180), null, NOW);
    expect(r.isObserved).toBe(true);
    expect(r.evidence.source).toBe("observed");
    expect(r.bottlesPerYear).toBeGreaterThan(0);
  });

  it("SUPPRESSES observation below the bottle floor", () => {
    const r = computeConsumptionCapacity(
      consumed(MIN_CONSUMED_BOTTLES - 1, 200),
      null,
      NOW,
    );
    expect(r.isObserved).toBe(false);
    expect(r.bottlesPerYear).toBeNull();
    expect(r.evidence.source).toBe("none");
  });

  it("SUPPRESSES observation below the history floor", () => {
    // Plenty of bottles, but all within a fortnight — a party, not a habit.
    const r = computeConsumptionCapacity(consumed(20, 14), null, NOW);
    expect(r.isObserved).toBe(false);
    expect(r.bottlesPerYear).toBeNull();
  });

  it("both floors must be met, not either", () => {
    const enoughBottlesShortSpan = computeConsumptionCapacity(
      consumed(20, MIN_HISTORY_DAYS - 10),
      null,
      NOW,
    );
    const longSpanFewBottles = computeConsumptionCapacity(consumed(3, 300), null, NOW);
    expect(enoughBottlesShortSpan.isObserved).toBe(false);
    expect(longSpanFewBottles.isObserved).toBe(false);
  });

  it("computes a plausible annual rate", () => {
    // 12 bottles across ~365 days ≈ 12 per year.
    const r = computeConsumptionCapacity(consumed(12, 360), null, NOW);
    expect(r.bottlesPerYear).toBeGreaterThan(10);
    expect(r.bottlesPerYear).toBeLessThan(14);
  });

  it("reports monthly as a twelfth of annual", () => {
    const r = computeConsumptionCapacity(consumed(24, 360), null, NOW);
    expect(r.bottlesPerMonth).toBeCloseTo(r.bottlesPerYear! / 12, 0);
  });
});

describe("only genuinely consumed bottles count", () => {
  it("EXCLUDES gifted, sold and lost bottles from the rate", () => {
    const mixed = [
      ...consumed(8, 200),
      ...Array.from({ length: 50 }, () => bottle("gifted", daysAgo(100))),
      ...Array.from({ length: 50 }, () => bottle("sold", daysAgo(100))),
      ...Array.from({ length: 50 }, () => bottle("lost", daysAgo(100))),
    ];
    const r = computeConsumptionCapacity(mixed, null, NOW);
    expect(r.evidence.sampleSize).toBe(8);
    expect(r.evidence.excludedBottles).toBe(150);
  });

  it("ignores bottles still in the cellar", () => {
    const r = computeConsumptionCapacity(
      [...consumed(8, 200), ...Array.from({ length: 99 }, () => bottle("in_cellar", null))],
      null,
      NOW,
    );
    expect(r.evidence.sampleSize).toBe(8);
  });

  it("ignores consumed bottles with no timestamp", () => {
    const r = computeConsumptionCapacity(
      [...consumed(8, 200), bottle("consumed", null)],
      null,
      NOW,
    );
    expect(r.evidence.sampleSize).toBe(8);
  });

  it("ignores consumption older than the observation window", () => {
    const r = computeConsumptionCapacity(
      [...consumed(8, 200), bottle("consumed", daysAgo(900))],
      null,
      NOW,
    );
    expect(r.evidence.sampleSize).toBe(8);
  });

  it("ignores a malformed timestamp rather than crashing", () => {
    const r = computeConsumptionCapacity(
      [...consumed(8, 200), bottle("consumed", "not-a-date")],
      null,
      NOW,
    );
    expect(r.evidence.sampleSize).toBe(8);
  });
});

describe("profile estimate is the fallback", () => {
  it("uses the profile when history is insufficient", () => {
    const r = computeConsumptionCapacity(
      consumed(2, 30),
      profileWith({ bottlesPerMonth: 4 }),
      NOW,
    );
    expect(r.isObserved).toBe(false);
    expect(r.evidence.source).toBe("profile");
    expect(r.bottlesPerYear).toBe(48);
  });

  it("reports the sample size even when falling back, so the UI can explain", () => {
    const r = computeConsumptionCapacity(
      consumed(3, 30),
      profileWith({ bottlesPerMonth: 4 }),
      NOW,
    );
    expect(r.evidence.sampleSize).toBe(3);
  });

  it("observation WINS over the profile when supported", () => {
    const r = computeConsumptionCapacity(
      consumed(30, 300),
      profileWith({ bottlesPerMonth: 1 }),
      NOW,
    );
    expect(r.isObserved).toBe(true);
    expect(r.bottlesPerYear).toBeGreaterThan(20);
  });

  it("marks evidence MIXED when both observation and a profile exist", () => {
    const r = computeConsumptionCapacity(
      consumed(30, 300),
      profileWith({ bottlesPerMonth: 3 }),
      NOW,
    );
    expect(r.evidence.source).toBe("mixed");
  });

  it("ignores a zero profile rate rather than dividing by it later", () => {
    const r = computeConsumptionCapacity(
      consumed(1, 10),
      profileWith({ bottlesPerMonth: 0 }),
      NOW,
    );
    expect(r.bottlesPerYear).toBeNull();
  });
});

describe("no evidence at all", () => {
  it("suppresses entirely rather than assuming zero", () => {
    const r = computeConsumptionCapacity([], null, NOW);
    expect(r.bottlesPerYear).toBeNull();
    expect(r.bottlesPerMonth).toBeNull();
    expect(r.evidence.source).toBe("none");
  });

  it("an empty profile is the same as no profile", () => {
    const r = computeConsumptionCapacity([], emptyProfile(), NOW);
    expect(r.bottlesPerYear).toBeNull();
  });
});

describe("evidence carries no numeric confidence", () => {
  it("exposes only factual fields", () => {
    const r = computeConsumptionCapacity(consumed(12, 200), null, NOW);
    const keys = Object.keys(r.evidence).sort();
    expect(keys).toEqual(["excludedBottles", "historyDays", "sampleSize", "source"]);
  });

  it("has no confidence or score field anywhere", () => {
    const json = JSON.stringify(
      computeConsumptionCapacity(consumed(12, 200), null, NOW),
    ).toLowerCase();
    for (const banned of ["confidence", "score", "certainty", "probability"]) {
      expect(json).not.toContain(banned);
    }
  });

  it("history days reflects the evidence span, not the window we searched", () => {
    const r = computeConsumptionCapacity(consumed(10, 120), null, NOW);
    expect(r.evidence.historyDays).toBeGreaterThan(110);
    expect(r.evidence.historyDays).toBeLessThan(130);
  });
});

describe("projection ranges are honest bands", () => {
  it("brackets the value by the stated band", () => {
    const r = projectionRange(100);
    expect(r.low).toBe(Math.floor(100 * (1 - PROJECTION_BAND)));
    expect(r.high).toBe(Math.ceil(100 * (1 + PROJECTION_BAND)));
  });

  it("never goes negative", () => {
    expect(projectionRange(0).low).toBe(0);
    expect(projectionRange(1).low).toBeGreaterThanOrEqual(0);
  });

  it("low is never above high", () => {
    for (const v of [0, 1, 7, 150, 9999]) {
      const r = projectionRange(v);
      expect(r.low).toBeLessThanOrEqual(r.high);
    }
  });
});
