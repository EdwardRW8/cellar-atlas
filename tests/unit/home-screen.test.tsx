// @vitest-environment jsdom

/**
 * HOME DASHBOARD
 *
 * Panels must hide when they have nothing to say — a dashboard full of zeroes
 * is worse than a short one. Each state is rendered against a stubbed
 * useCellar so the screen is tested without a network or a database.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WineSummary, DomainStorageLocation } from "@/domain/types";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

let cellarState: Record<string, unknown>;
vi.mock("@/hooks/useCellar", () => ({
  useCellar: () => cellarState,
}));

const { default: Home } = await import("@/features/home");

afterEach(cleanup);
beforeEach(() => navigate.mockClear());

function wine(
  over: Partial<WineSummary["wine"]> = {},
  sum: Partial<WineSummary> = {},
): WineSummary {
  return {
    wine: {
      id: over.id ?? Math.random().toString(36).slice(2),
      producer: "Test",
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
      drinkFrom: 2000,
      drinkUntil: 2099,
      notes: null,
      version: 1,
      ...over,
    },
    activeBottles: 3,
    totalBottles: 3,
    locations: [],
    totalValue: null,
    valuation: { valuedBottles: 0, activeBottles: 0 },
    ...sum,
  };
}

function location(over: Partial<DomainStorageLocation> = {}): DomainStorageLocation {
  return {
    id: "loc1",
    name: "Rack",
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

function renderHome(over: Partial<Record<string, unknown>> = {}) {
  cellarState = {
    state: "ready",
    error: null,
    wines: [],
    // Phase 10: Home reads these for the currency-aware valuation total.
    bottles: [],
    valuations: new Map(),
    locations: [],
    refresh: vi.fn(),
    ...over,
  };
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

describe("load states", () => {
  it("shows skeletons while loading", () => {
    renderHome({ state: "loading" });
    expect(screen.getByRole("status", { name: /loading/i })).toBeTruthy();
  });

  it("shows an error with a retry action", () => {
    const refresh = vi.fn();
    renderHome({ state: "error", error: "Network unreachable", refresh });
    expect(screen.getByRole("alert").textContent).toMatch(/Could not load/i);
    expect(screen.getByText("Network unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a strong empty state with an add action", () => {
    renderHome({ wines: [] });
    expect(screen.getByText(/your cellar is empty/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add your first wine/i }));
    expect(navigate).toHaveBeenCalledWith("/add");
  });

  it("treats a cellar of fully consumed wines as empty", () => {
    renderHome({ wines: [wine({}, { activeBottles: 0 })] });
    expect(screen.getByText(/your cellar is empty/i)).toBeTruthy();
  });

  it("always renders the header, whatever the state", () => {
    for (const state of ["loading", "error", "ready"]) {
      cleanup();
      renderHome({ state, error: "x" });
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    }
  });
});

describe("panels hide when they have nothing to say", () => {
  it("shows Ready to drink when bottles are ready", () => {
    renderHome({ wines: [wine({ drinkFrom: 2000, drinkUntil: 2099 })] });
    expect(screen.getByText(/ready to drink/i)).toBeTruthy();
  });

  it("HIDES Ready to drink when nothing is ready", () => {
    renderHome({ wines: [wine({ drinkFrom: 2090, drinkUntil: 2099 })] });
    expect(screen.queryByText(/ready to drink/i)).toBeNull();
  });

  it("HIDES Closing soon when no window is closing", () => {
    renderHome({ wines: [wine({ drinkFrom: 2000, drinkUntil: 2099 })] });
    expect(screen.queryByText(/closing soon/i)).toBeNull();
  });

  it("shows Closing soon when a window closes shortly", () => {
    const soon = new Date().getFullYear() + 1;
    renderHome({ wines: [wine({ drinkFrom: 2000, drinkUntil: soon })] });
    expect(screen.getByText(/closing soon/i)).toBeTruthy();
  });

  it("HIDES Storage when there is no bounded storage", () => {
    renderHome({
      wines: [wine()],
      locations: [location({ layoutType: null, layoutConfig: null, isPositioned: false })],
    });
    expect(screen.queryByText(/^storage$/i)).toBeNull();
  });

  it("shows Storage when a bounded location exists", () => {
    renderHome({ wines: [wine()], locations: [location({ occupied: 2 })] });
    expect(screen.getByText("Storage")).toBeTruthy();
    expect(screen.getByText("50% full")).toBeTruthy();
  });

  it("HIDES Needs attention when nothing needs it", () => {
    renderHome({ wines: [wine({ drinkFrom: 2000, drinkUntil: 2099 })] });
    expect(screen.queryByText(/needs attention/i)).toBeNull();
  });

  it("shows Needs attention for past-window bottles", () => {
    renderHome({ wines: [wine({ drinkFrom: 1990, drinkUntil: 2000 })] });
    expect(screen.getByText(/needs attention/i)).toBeTruthy();
    expect(screen.getByText(/past their drinking window/i)).toBeTruthy();
  });

  it("shows Needs attention for missing geography", () => {
    renderHome({
      wines: [
        wine({
          geography: {
            country: null,
            region: null,
            appellation: null,
            unmatched: null,
          },
        }),
      ],
    });
    expect(screen.getByText(/need geography/i)).toBeTruthy();
  });
});

describe("wording is factual", () => {
  it('never claims a wine is ready "tonight"', () => {
    renderHome({ wines: [wine()], locations: [location({ occupied: 1 })] });
    expect(document.body.textContent?.toLowerCase()).not.toContain("tonight");
  });

  it("uses year-accurate language for closing windows", () => {
    const soon = new Date().getFullYear() + 1;
    renderHome({ wines: [wine({ drinkFrom: 2000, drinkUntil: soon })] });
    expect(screen.getByText(/window closes within \d+ years?/i)).toBeTruthy();
  });

  it("shows no predictive language anywhere", () => {
    renderHome({
      wines: [wine({ drinkFrom: 1990, drinkUntil: 2000 }), wine()],
      locations: [location({ occupied: 3 })],
    });
    const text = document.body.textContent?.toLowerCase() ?? "";
    for (const banned of ["longevity", "legacy", "forecast", "we recommend", "predicted"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("navigation", () => {
  it("Ready to drink opens Cellar filtered to ready", () => {
    renderHome({ wines: [wine()] });
    fireEvent.click(screen.getByText(/ready to drink/i).closest("button")!);
    expect(navigate).toHaveBeenCalledWith("/cellar", {
      state: { filters: { readiness: ["ready"] } },
    });
  });

  it("Storage opens the storage screen", () => {
    renderHome({ wines: [wine()], locations: [location({ occupied: 1 })] });
    fireEvent.click(screen.getByText("Storage").closest("button")!);
    expect(navigate).toHaveBeenCalledWith("/storage");
  });

  it("Needs attention opens Cellar", () => {
    renderHome({ wines: [wine({ drinkFrom: 1990, drinkUntil: 2000 })] });
    fireEvent.click(screen.getByText(/needs attention/i).closest("button")!);
    expect(navigate).toHaveBeenCalledWith("/cellar");
  });
});

describe("mobile safety", () => {
  it("every interactive card meets the 44px touch target", () => {
    renderHome({
      wines: [wine({ drinkFrom: 1990, drinkUntil: 2000 }), wine()],
      locations: [location({ occupied: 2 })],
    });
    for (const b of screen.getAllByRole("button")) {
      const min = Number.parseInt((b as HTMLElement).style.minHeight, 10);
      if (!Number.isNaN(min)) expect(min).toBeGreaterThanOrEqual(44);
    }
  });

  it("cards are full width, so nothing can overflow horizontally", () => {
    renderHome({ wines: [wine()], locations: [location({ occupied: 1 })] });
    for (const b of screen.getAllByRole("button")) {
      const w = (b as HTMLElement).style.width;
      if (w) expect(w).toBe("100%");
    }
  });

  it("shows at most four panels", () => {
    renderHome({
      wines: [
        wine({ drinkFrom: 2000, drinkUntil: new Date().getFullYear() + 1 }),
        wine({ drinkFrom: 1990, drinkUntil: 2000 }),
        wine({ colour: null }),
      ],
      locations: [location({ occupied: 2 })],
    });
    // Cards are buttons; none of the panels renders a nested button.
    expect(screen.getAllByRole("button").length).toBeLessThanOrEqual(4);
  });
});

describe("storage panel reports unbounded storage honestly", () => {
  it("mentions unpositioned bottles without folding them into the percentage", () => {
    renderHome({
      wines: [wine()],
      locations: [
        location({ occupied: 2 }),
        location({
          id: "merchant",
          layoutType: null,
          layoutConfig: null,
          isPositioned: false,
          isExternal: true,
          occupied: 50,
        }),
      ],
    });
    expect(screen.getByText("50% full")).toBeTruthy();
    expect(screen.getByText(/50 bottles in storage without fixed positions/i)).toBeTruthy();
  });

  it("names full locations", () => {
    renderHome({
      wines: [wine()],
      locations: [
        location({
          name: "Packed Rack",
          layoutConfig: { rows: 1, columns: 2 },
          occupied: 2,
        }),
      ],
    });
    expect(screen.getByText(/full: packed rack/i)).toBeTruthy();
  });
});
