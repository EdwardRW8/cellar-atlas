import { describe, it, expect } from "vitest";
import { assessWindow, isReadyNow, closesWithin } from "@/domain/drinking-window";

const YEAR = 2026;

describe("drinking window states", () => {
  it("unknown when no dates are given — an absence, not an error", () => {
    const a = assessWindow({ from: null, until: null }, YEAR);
    expect(a.state).toBe("unknown");
    expect(a.indicator).toBe("unknown");
  });

  it("veryYoung when more than 3 years from opening", () => {
    expect(assessWindow({ from: 2032, until: 2045 }, YEAR).state).toBe("veryYoung");
  });

  it("approaching when within 3 years of opening", () => {
    expect(assessWindow({ from: 2028, until: 2045 }, YEAR).state).toBe("approaching");
  });

  it("ready in the first quarter of the window", () => {
    expect(assessWindow({ from: 2025, until: 2045 }, YEAR).state).toBe("ready");
  });

  it("peak in the middle of the window", () => {
    expect(assessWindow({ from: 2016, until: 2036 }, YEAR).state).toBe("peak");
  });

  it("lateWindow in the final quarter", () => {
    expect(assessWindow({ from: 2010, until: 2028 }, YEAR).state).toBe("lateWindow");
  });

  it("pastWindow after the close date", () => {
    expect(assessWindow({ from: 2000, until: 2020 }, YEAR).state).toBe("pastWindow");
  });
});

describe("boundaries", () => {
  it("the opening year itself is ready, not approaching", () => {
    expect(assessWindow({ from: 2026, until: 2040 }, YEAR).state).toBe("ready");
  });

  it("the closing year itself is still drinkable", () => {
    const a = assessWindow({ from: 2015, until: 2026 }, YEAR);
    expect(a.state).toBe("lateWindow");
    expect(a.indicator).toBe("ready");
  });

  it("one year past the close is pastWindow", () => {
    expect(assessWindow({ from: 2015, until: 2025 }, YEAR).state).toBe("pastWindow");
  });

  it("handles a single-year window", () => {
    expect(assessWindow({ from: 2026, until: 2026 }, YEAR).indicator).toBe("ready");
  });

  it("handles only a lower bound", () => {
    expect(assessWindow({ from: 2020, until: null }, YEAR).indicator).toBe("ready");
  });

  it("handles only an upper bound", () => {
    expect(assessWindow({ from: null, until: 2030 }, YEAR).indicator).toBe("ready");
  });
});

describe("the rack still shows three colours", () => {
  it("maps seven states onto four indicators", () => {
    const cases: Array<[{ from: number | null; until: number | null }, string]> = [
      [{ from: 2032, until: 2045 }, "young"],
      [{ from: 2028, until: 2045 }, "young"],
      [{ from: 2025, until: 2045 }, "ready"],
      [{ from: 2016, until: 2036 }, "ready"],
      [{ from: 2010, until: 2028 }, "ready"],
      [{ from: 2000, until: 2020 }, "past"],
      [{ from: null, until: null }, "unknown"],
    ];
    for (const [w, expected] of cases) {
      expect(assessWindow(w, YEAR).indicator).toBe(expected);
    }
  });
});

describe("helpers used by pairings and drinking pressure", () => {
  it("isReadyNow", () => {
    expect(isReadyNow({ from: 2020, until: 2030 }, YEAR)).toBe(true);
    expect(isReadyNow({ from: 2030, until: 2040 }, YEAR)).toBe(false);
    expect(isReadyNow({ from: 2000, until: 2010 }, YEAR)).toBe(false);
  });

  it("closesWithin identifies upcoming pressure", () => {
    expect(closesWithin({ from: 2015, until: 2027 }, 2, YEAR)).toBe(true);
    expect(closesWithin({ from: 2015, until: 2035 }, 2, YEAR)).toBe(false);
    // Already past — not pressure, it is history.
    expect(closesWithin({ from: 2000, until: 2020 }, 2, YEAR)).toBe(false);
    expect(closesWithin({ from: 2015, until: null }, 2, YEAR)).toBe(false);
  });
});
