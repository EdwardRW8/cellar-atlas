import { describe, it, expect } from "vitest";
import {
  describeRating,
  describeTastedWine,
  wasTastedElsewhere,
  describeMonth,
  groupByMonth,
  summariseTastings,
  type TastingRecord,
} from "@/domain/tasting-log";

const NOW = new Date("2026-06-15T12:00:00Z");

function tasting(over: Partial<TastingRecord> = {}): TastingRecord {
  return {
    id: Math.random().toString(36).slice(2),
    wineId: "w1",
    bottleId: "b1",
    rating: 4,
    notes: "Good",
    tastedOn: "2026-06-10",
    context: null,
    version: 1,
    producer: "Test Estate",
    wineName: "Test Wine",
    vintage: 2018,
    ...over,
  };
}

describe("a tasting survives its bottle", () => {
  it("a tasting with NO bottle is valid — tasted elsewhere", () => {
    const t = tasting({ bottleId: null });
    expect(wasTastedElsewhere(t)).toBe(true);
    expect(describeTastedWine(t)).toBe("Test Wine 2018");
  });

  it("a tasting WITH a bottle is not marked as elsewhere", () => {
    expect(wasTastedElsewhere(tasting({ bottleId: "b1" }))).toBe(false);
  });

  it("elsewhere tastings are NEVER filtered out of grouping", () => {
    const months = groupByMonth(
      [tasting({ bottleId: null }), tasting({ bottleId: "b1" })],
      NOW,
    );
    expect(months[0]!.tastings).toHaveLength(2);
  });

  it("elsewhere tastings count in the summary", () => {
    const s = summariseTastings([tasting({ bottleId: null }), tasting({ bottleId: "b1" })]);
    expect(s.total).toBe(2);
    expect(s.tastedElsewhere).toBe(1);
  });

  it("reads sensibly when the wine is no longer readable", () => {
    expect(describeTastedWine(tasting({ wineName: null }))).toBe("Unknown wine");
  });

  it("handles a non-vintage wine", () => {
    expect(describeTastedWine(tasting({ wineName: "Krug", vintage: null }))).toBe("Krug");
  });
});

describe("ratings", () => {
  it("describes each rating in words", () => {
    expect(describeRating(1)).toBe("Disappointing");
    expect(describeRating(3)).toBe("Very good");
    expect(describeRating(5)).toBe("Exceptional");
  });

  it("an unrated tasting says so — never zero", () => {
    expect(describeRating(null)).toBe("No rating");
  });

  it("degrades for an out-of-range value rather than crashing", () => {
    expect(describeRating(9)).toBe("9 of 5");
  });
});

describe("grouping by month", () => {
  it("groups and orders newest first", () => {
    const months = groupByMonth(
      [
        tasting({ tastedOn: "2026-04-02" }),
        tasting({ tastedOn: "2026-06-10" }),
        tasting({ tastedOn: "2026-06-01" }),
      ],
      NOW,
    );
    expect(months.map((m) => m.month)).toEqual(["2026-06", "2026-04"]);
    expect(months[0]!.tastings).toHaveLength(2);
  });

  it("orders within a month newest first", () => {
    const months = groupByMonth(
      [
        tasting({ id: "early", tastedOn: "2026-06-01" }),
        tasting({ id: "late", tastedOn: "2026-06-20" }),
      ],
      NOW,
    );
    expect(months[0]!.tastings.map((t) => t.id)).toEqual(["late", "early"]);
  });

  it("omits the year within the current year", () => {
    expect(describeMonth("2026-06", NOW)).toBe("June");
  });

  it("includes the year otherwise", () => {
    expect(describeMonth("2024-06", NOW)).toMatch(/2024/);
  });

  it("skips a tasting with no date rather than crashing", () => {
    expect(groupByMonth([tasting({ tastedOn: "" })], NOW)).toEqual([]);
  });

  it("handles no tastings", () => {
    expect(groupByMonth([], NOW)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const list = [tasting()];
    const before = JSON.stringify(list);
    groupByMonth(list, NOW);
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe("statistics exclude unrated tastings from the average", () => {
  it("averages only rated tastings", () => {
    const s = summariseTastings([
      tasting({ rating: 4 }),
      tasting({ rating: 2 }),
      tasting({ rating: null }),
    ]);
    // An unrated note is not a zero-star review.
    expect(s.averageRating).toBe(3);
    expect(s.rated).toBe(2);
    expect(s.total).toBe(3);
  });

  it("reports no average when nothing is rated", () => {
    expect(summariseTastings([tasting({ rating: null })]).averageRating).toBeNull();
  });

  it("counts distinct wines, not tastings", () => {
    const s = summariseTastings([
      tasting({ wineId: "w1" }),
      tasting({ wineId: "w1" }),
      tasting({ wineId: "w2" }),
    ]);
    expect(s.total).toBe(3);
    expect(s.distinctWines).toBe(2);
  });

  it("handles an empty log", () => {
    expect(summariseTastings([])).toEqual({
      total: 0,
      rated: 0,
      averageRating: null,
      distinctWines: 0,
      tastedElsewhere: 0,
    });
  });

  it("rounds the average to one decimal", () => {
    const s = summariseTastings([
      tasting({ rating: 4 }),
      tasting({ rating: 5 }),
      tasting({ rating: 5 }),
    ]);
    expect(s.averageRating).toBe(4.7);
  });
});
