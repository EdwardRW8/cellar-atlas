import { describe, it, expect } from "vitest";
import {
  describeEvent,
  describeWine,
  describeDay,
  groupByDay,
  filterEvents,
  summariseHistory,
  EVENT_TYPES,
  EVENT_FILTERS,
  type HistoryEvent,
} from "@/domain/history";

const NOW = new Date("2026-06-15T12:00:00Z");

function ev(over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: Math.random().toString(36).slice(2),
    bottleId: "b1",
    eventType: "added",
    occurredAt: "2026-06-15T10:00:00Z",
    reason: null,
    notes: null,
    wineId: "w1",
    producer: "Test Estate",
    wineName: "Test Wine",
    vintage: 2018,
    locationName: null,
    ...over,
  };
}

describe("every event type reads as plain English", () => {
  it("describes ALL twelve types without falling through", () => {
    for (const type of EVENT_TYPES) {
      const text = describeEvent(ev({ eventType: type }));
      expect(text.length, `${type} has no description`).toBeGreaterThan(0);
      // Never a raw identifier.
      expect(text, `${type} leaked an underscore`).not.toMatch(/_/);
    }
  });

  it("includes the destination where it is meaningful", () => {
    expect(describeEvent(ev({ eventType: "moved", locationName: "Home Cellar" }))).toBe(
      "Moved to Home Cellar",
    );
    expect(describeEvent(ev({ eventType: "delivered", locationName: "Home Cellar" }))).toBe(
      "Delivered to Home Cellar",
    );
    expect(describeEvent(ev({ eventType: "added", locationName: "Wall Rack" }))).toBe(
      "Added to Wall Rack",
    );
  });

  it("reads correctly with no location", () => {
    expect(describeEvent(ev({ eventType: "moved", locationName: null }))).toBe("Moved");
    expect(describeEvent(ev({ eventType: "added", locationName: null }))).toBe(
      "Added to the cellar",
    );
  });

  it("degrades gracefully for an unknown type", () => {
    // A future migration may add a type this build has never seen.
    expect(describeEvent(ev({ eventType: "teleported_away" }))).toBe("Teleported away");
  });

  it("does not throw on an empty type", () => {
    expect(() => describeEvent(ev({ eventType: "" }))).not.toThrow();
  });

  it("names the wine as a person would", () => {
    expect(describeWine(ev({ wineName: "Margaux", vintage: 2015 }))).toBe("Margaux 2015");
    expect(describeWine(ev({ wineName: "Grande Cuvée", vintage: null }))).toBe(
      "Grande Cuvée",
    );
  });
});

describe("day labels are relative and readable", () => {
  it("says Today and Yesterday", () => {
    expect(describeDay("2026-06-15", NOW)).toBe("Today");
    expect(describeDay("2026-06-14", NOW)).toBe("Yesterday");
  });

  it("omits the year within the current year", () => {
    const label = describeDay("2026-03-04", NOW);
    expect(label).toMatch(/4 March/);
    expect(label).not.toMatch(/2026/);
  });

  it("includes the year for a different year", () => {
    expect(describeDay("2024-03-04", NOW)).toMatch(/2024/);
  });

  it("returns the raw value rather than throwing on a bad date", () => {
    expect(describeDay("not-a-date", NOW)).toBe("not-a-date");
  });
});

describe("grouping uses occurred_at, not created_at", () => {
  it("groups events by the day they actually happened", () => {
    const days = groupByDay(
      [
        ev({ occurredAt: "2026-06-15T09:00:00Z" }),
        ev({ occurredAt: "2026-06-15T18:00:00Z" }),
        ev({ occurredAt: "2026-06-13T10:00:00Z" }),
      ],
      NOW,
    );
    expect(days).toHaveLength(2);
    expect(days[0]!.events).toHaveLength(2);
  });

  it("orders days newest first", () => {
    const days = groupByDay(
      [
        ev({ occurredAt: "2026-06-10T10:00:00Z" }),
        ev({ occurredAt: "2026-06-15T10:00:00Z" }),
      ],
      NOW,
    );
    expect(days.map((d) => d.date)).toEqual(["2026-06-15", "2026-06-10"]);
  });

  it("orders events within a day newest first", () => {
    const days = groupByDay(
      [
        ev({ id: "early", occurredAt: "2026-06-15T08:00:00Z" }),
        ev({ id: "late", occurredAt: "2026-06-15T20:00:00Z" }),
      ],
      NOW,
    );
    expect(days[0]!.events.map((e) => e.id)).toEqual(["late", "early"]);
  });

  it("handles a day boundary correctly", () => {
    const days = groupByDay(
      [
        ev({ occurredAt: "2026-06-15T23:59:59Z" }),
        ev({ occurredAt: "2026-06-16T00:00:01Z" }),
      ],
      NOW,
    );
    expect(days).toHaveLength(2);
  });

  it("skips events with no timestamp rather than crashing", () => {
    expect(groupByDay([ev({ occurredAt: "" })], NOW)).toEqual([]);
  });

  it("returns nothing for no events", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });

  it("labels each day", () => {
    const days = groupByDay([ev({ occurredAt: "2026-06-15T10:00:00Z" })], NOW);
    expect(days[0]!.label).toBe("Today");
  });
});

describe("filtering", () => {
  const events = [
    ev({ eventType: "added" }),
    ev({ eventType: "consumed" }),
    ev({ eventType: "moved" }),
  ];

  it("an empty filter means everything", () => {
    expect(filterEvents(events, [])).toHaveLength(3);
  });

  it("filters to one type", () => {
    expect(filterEvents(events, ["consumed"])).toHaveLength(1);
  });

  it("filters to several types", () => {
    expect(filterEvents(events, ["consumed", "moved"])).toHaveLength(2);
  });

  it("an unmatched filter returns nothing, not everything", () => {
    expect(filterEvents(events, ["valued"])).toHaveLength(0);
  });

  it("every offered filter is a real event type", () => {
    for (const f of EVENT_FILTERS) {
      expect(EVENT_TYPES).toContain(f.type);
    }
  });
});

describe("summary", () => {
  it("counts events, days and types", () => {
    const s = summariseHistory([
      ev({ eventType: "added", occurredAt: "2026-06-15T10:00:00Z" }),
      ev({ eventType: "added", occurredAt: "2026-06-14T10:00:00Z" }),
      ev({ eventType: "consumed", occurredAt: "2026-06-14T11:00:00Z" }),
    ]);
    expect(s.totalEvents).toBe(3);
    expect(s.days).toBe(2);
    expect(s.byType[0]).toMatchObject({ type: "added", count: 2 });
  });

  it("uses readable labels", () => {
    const s = summariseHistory([ev({ eventType: "tasting_recorded" })]);
    expect(s.byType[0]!.label).toBe("Tasted");
  });

  it("handles no events", () => {
    expect(summariseHistory([])).toEqual({ totalEvents: 0, days: 0, byType: [] });
  });
});

describe("history is read-only by construction", () => {
  it("the module exports no mutation", () => {
    const exported = Object.keys(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      {} as Record<string, unknown>,
    );
    expect(exported).toEqual([]);
  });

  it("describe functions do not mutate their input", () => {
    const e = ev();
    const before = JSON.stringify(e);
    describeEvent(e);
    describeWine(e);
    expect(JSON.stringify(e)).toBe(before);
  });

  it("grouping does not mutate its input", () => {
    const events = [ev({ occurredAt: "2026-06-15T10:00:00Z" })];
    const before = JSON.stringify(events);
    groupByDay(events, NOW);
    expect(JSON.stringify(events)).toBe(before);
  });
});
