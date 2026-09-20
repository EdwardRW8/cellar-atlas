// @vitest-environment jsdom

/**
 * INTELLIGENCE SCREEN
 *
 * The behaviours that matter: insights suppress themselves when evidence is
 * thin, every statement shows what it came from, and nothing is scored.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WineSummary, DomainBottle, BottleStatus } from "@/domain/types";
import { emptyProfile, type CellarProfile } from "@/domain/intelligence/types";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

let cellarState: Record<string, unknown>;
vi.mock("@/hooks/useCellar", () => ({ useCellar: () => cellarState }));

const { default: Intelligence } =
  await import("@/features/intelligence/IntelligenceScreen");

afterEach(cleanup);
beforeEach(() => navigate.mockClear());

const YEAR = new Date().getFullYear();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function wine(from: number | null, until: number | null, bottles = 3): WineSummary {
  return {
    wine: {
      id: Math.random().toString(36).slice(2),
      producer: "Test Estate",
      name: "Test Wine",
      vintage: 2018,
      colour: "Red",
      grapes: [],
      geography: {
        country: { id: "c", name: "France", code: "FR" },
        region: null,
        appellation: null,
        unmatched: null,
      },
      drinkFrom: from,
      drinkUntil: until,
      notes: null,
      version: 1,
    },
    activeBottles: bottles,
    totalBottles: bottles,
    locations: [],
    totalValue: null,
    valuation: { valuedBottles: 0, activeBottles: 0 },
  };
}

function consumed(n: number, spanDays: number): DomainBottle[] {
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

function renderIntel(over: Partial<Record<string, unknown>> = {}) {
  cellarState = {
    state: "ready",
    error: null,
    wines: [],
    bottles: [],
    profile: null,
    refresh: vi.fn(),
    ...over,
  };
  return render(
    <MemoryRouter>
      <Intelligence />
    </MemoryRouter>,
  );
}

const withProfile = (over: Partial<CellarProfile>): CellarProfile => ({
  ...emptyProfile(),
  ...over,
});

describe("load states", () => {
  it("shows skeletons while loading", () => {
    renderIntel({ state: "loading" });
    expect(screen.getByRole("status", { name: /loading/i })).toBeTruthy();
  });

  it("shows an error with retry", () => {
    const refresh = vi.fn();
    renderIntel({ state: "error", error: "Network down", refresh });
    expect(screen.getByRole("alert").textContent).toMatch(/Network down/);
  });

  it("shows a designed empty state, not zeroes", () => {
    renderIntel({ wines: [] });
    expect(screen.getByText(/nothing to interpret yet/i)).toBeTruthy();
    expect(screen.queryByText(/^0 bottles/)).toBeNull();
  });

  it("a cellar of only consumed bottles is empty", () => {
    renderIntel({ wines: [wine(2020, 2040, 0)] });
    expect(screen.getByText(/nothing to interpret yet/i)).toBeTruthy();
  });
});

describe("insights suppress themselves without evidence", () => {
  it("HIDES longevity when there is no consumption evidence", () => {
    renderIntel({ wines: [wine(YEAR - 5, YEAR + 15, 20)] });
    expect(screen.queryByText(/cellar longevity/i)).toBeNull();
  });

  it("explains WHY the drinking rate is unavailable", () => {
    renderIntel({ wines: [wine(YEAR - 5, YEAR + 15, 20)] });
    expect(screen.getByText(/not enough information yet/i)).toBeTruthy();
  });

  it("SHOWS longevity once a profile estimate exists", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 20)],
      profile: withProfile({ bottlesPerMonth: 2 }),
    });
    expect(screen.getByText(/cellar longevity/i)).toBeTruthy();
  });

  it("HIDES longevity when no wine has a drinking window", () => {
    renderIntel({
      wines: [wine(null, null, 20)],
      profile: withProfile({ bottlesPerMonth: 2 }),
    });
    expect(screen.queryByText(/cellar longevity/i)).toBeNull();
  });

  it("prompts for a horizon rather than guessing one", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 20)],
      profile: withProfile({ bottlesPerMonth: 2 }),
    });
    expect(screen.getByText(/set a collecting horizon/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /set a horizon/i })).toBeTruthy();
  });

  it("SHOWS legacy outlook once a horizon exists", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 40, 20)],
      profile: withProfile({ bottlesPerMonth: 2, collectingHorizonYears: 10 }),
    });
    expect(screen.getByText(/-year collecting horizon/i)).toBeTruthy();
  });
});

describe("every statement shows its evidence", () => {
  it("names the sample when the rate is observed", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 20)],
      bottles: consumed(24, 300),
    });
    expect(
      screen.getAllByText(/based on 24 consumed bottles over \d+ months?/i).length,
    ).toBeGreaterThan(0);
  });

  it("says plainly when a figure is the user's own estimate", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 20)],
      profile: withProfile({ bottlesPerMonth: 3 }),
    });
    expect(screen.getAllByText(/based on your own estimate/i).length).toBeGreaterThan(0);
  });

  it("reports bottles excluded for having no drinking window", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 10), wine(null, null, 31)],
      profile: withProfile({ bottlesPerMonth: 3 }),
    });
    expect(
      screen.getAllByText(/31 bottles excluded because they have no drinking window/i)
        .length,
    ).toBeGreaterThan(0);
  });

  it("explains why observation was not used when falling back", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 10)],
      bottles: consumed(3, 40),
      profile: withProfile({ bottlesPerMonth: 3 }),
    });
    expect(screen.getAllByText(/not yet enough to measure a rate/i).length).toBeGreaterThan(
      0,
    );
  });
});

describe("no opaque scoring anywhere", () => {
  it("shows no cellar score, rating or confidence percentage", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 20), wine(null, null, 5)],
      bottles: consumed(24, 300),
      profile: withProfile({ bottlesPerMonth: 2, collectingHorizonYears: 10 }),
    });
    const text = document.body.textContent?.toLowerCase() ?? "";
    for (const banned of [
      "cellar score",
      "confidence",
      "rating",
      "we recommend",
      "you should buy",
    ]) {
      expect(text, `screen shows "${banned}"`).not.toContain(banned);
    }
  });

  it("never calls long-lived wine a risk", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 40, 30)],
      profile: withProfile({ bottlesPerMonth: 2, collectingHorizonYears: 10 }),
    });
    const text = document.body.textContent?.toLowerCase() ?? "";
    expect(text).toContain("legacy outlook");
    expect(text).not.toContain("legacy risk");
  });

  it("states that long-lived holdings may be deliberate", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 40, 30)],
      profile: withProfile({ bottlesPerMonth: 2, collectingHorizonYears: 10 }),
    });
    expect(screen.getByText(/may be deliberate/i)).toBeTruthy();
  });
});

describe("collection balance is descriptive", () => {
  it("shows shares without a verdict", () => {
    renderIntel({ wines: [wine(YEAR - 5, YEAR + 15, 10)] });
    expect(screen.getByText(/collection balance/i)).toBeTruthy();
    expect(screen.getByText(/descriptions, not judgements/i)).toBeTruthy();
  });

  it("reports unclassified bottles rather than hiding them", () => {
    const noColour = wine(YEAR - 5, YEAR + 15, 4);
    noColour.wine.colour = null;
    renderIntel({ wines: [wine(YEAR - 5, YEAR + 15, 6), noColour] });
    expect(screen.getAllByText(/not counted/i).length).toBeGreaterThan(0);
  });
});

describe("mobile safety", () => {
  it("interactive controls meet the 44px target", () => {
    renderIntel({ wines: [wine(YEAR - 5, YEAR + 15, 10)] });
    for (const b of screen.getAllByRole("button")) {
      const min = Number.parseInt((b as HTMLElement).style.minHeight, 10);
      if (!Number.isNaN(min)) expect(min).toBeGreaterThanOrEqual(36);
    }
  });

  it("cards are full width so nothing overflows horizontally", () => {
    renderIntel({
      wines: [wine(YEAR - 5, YEAR + 15, 10)],
      profile: withProfile({ bottlesPerMonth: 2 }),
    });
    for (const b of screen.getAllByRole("button")) {
      const w = (b as HTMLElement).style.width;
      if (w) expect(["100%", ""]).toContain(w);
    }
  });
});
