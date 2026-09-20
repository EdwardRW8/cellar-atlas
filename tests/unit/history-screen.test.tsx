// @vitest-environment jsdom

/**
 * HISTORY & TASTING SCREENS
 *
 * The behaviour that matters most: History offers NO way to change anything,
 * while Tastings does. That asymmetry is the whole point of Phase 9.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { HistoryEvent } from "@/domain/history";
import type { TastingRecord } from "@/domain/tasting-log";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

let cellarState: Record<string, unknown>;
vi.mock("@/hooks/useCellar", () => ({ useCellar: () => cellarState }));

const { default: HistoryScreen } = await import("@/features/history/HistoryScreen");
const { default: TastingLogScreen } = await import("@/features/tasting/TastingLogScreen");

afterEach(cleanup);
beforeEach(() => navigate.mockClear());

const today = new Date().toISOString();

function ev(over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: Math.random().toString(36).slice(2),
    bottleId: "b1",
    eventType: "added",
    occurredAt: today,
    reason: null,
    notes: null,
    wineId: "w1",
    producer: "Test Estate",
    wineName: "Test Wine",
    vintage: 2018,
    locationName: "Home Cellar",
    ...over,
  };
}

function tasting(over: Partial<TastingRecord> = {}): TastingRecord {
  return {
    id: Math.random().toString(36).slice(2),
    wineId: "w1",
    bottleId: "b1",
    rating: 4,
    notes: "Lovely",
    tastedOn: today.slice(0, 10),
    context: null,
    version: 1,
    producer: "Test Estate",
    wineName: "Test Wine",
    vintage: 2018,
    ...over,
  };
}

function renderHistory(events: HistoryEvent[], over: Record<string, unknown> = {}) {
  cellarState = {
    state: "ready",
    repository: { loadHistory: vi.fn().mockResolvedValue(events) },
    ...over,
  };
  return render(
    <MemoryRouter>
      <HistoryScreen />
    </MemoryRouter>,
  );
}

function renderTastings(list: TastingRecord[], over: Record<string, unknown> = {}) {
  const run = vi.fn().mockResolvedValue({ ok: true });
  cellarState = {
    state: "ready",
    repository: { loadAllTastings: vi.fn().mockResolvedValue(list) },
    run,
    ...over,
  };
  const r = render(
    <MemoryRouter>
      <TastingLogScreen />
    </MemoryRouter>,
  );
  return { ...r, run };
}

describe("History is read-only", () => {
  it("offers NO edit, delete or remove control anywhere", async () => {
    renderHistory([ev(), ev({ eventType: "consumed" })]);
    await screen.findByText(/Added to Home Cellar/);

    // Exact names, not substrings: "Corrected" is a legitimate event-type
    // FILTER, and matching /correct/i would flag it as an edit affordance.
    for (const name of [/^edit$/i, /^delete$/i, /^remove$/i, /^save/i, /^undo$/i]) {
      expect(
        screen.queryByRole("button", { name }),
        `History offers a ${name} control`,
      ).toBeNull();
    }
  });

  it("EVERY button in History is a filter or a navigation — never a mutation", async () => {
    renderHistory([ev(), ev({ eventType: "consumed" })]);
    await screen.findByText(/Added to Home Cellar/);

    for (const b of screen.getAllByRole("button")) {
      const isFilter = b.hasAttribute("aria-pressed");
      const isEventRow = /Added to|Consumed/.test(b.textContent ?? "");
      const isPaging = /load older/i.test(b.textContent ?? "");
      expect(
        isFilter || isEventRow || isPaging,
        `unexpected control in History: "${b.textContent}"`,
      ).toBe(true);
    }
  });

  it("tapping an event navigates rather than editing", async () => {
    renderHistory([ev({ bottleId: "b7" })]);
    fireEvent.click(await screen.findByText(/Added to Home Cellar/));
    expect(navigate).toHaveBeenCalledWith("/cellar/bottle/b7");
  });

  it("renders events in plain English, never raw types", async () => {
    renderHistory([ev({ eventType: "tasting_recorded", locationName: null })]);
    expect(await screen.findByText("Tasting recorded")).toBeTruthy();
    expect(screen.queryByText(/tasting_recorded/)).toBeNull();
  });

  it("groups by day with a relative label", async () => {
    renderHistory([ev()]);
    expect(await screen.findByText("Today")).toBeTruthy();
  });
});

describe("History states", () => {
  it("shows a skeleton while loading", () => {
    cellarState = {
      state: "ready",
      repository: { loadHistory: () => new Promise(() => {}) },
    };
    render(
      <MemoryRouter>
        <HistoryScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status", { name: /loading/i })).toBeTruthy();
  });

  it("shows an empty state when there is no history", async () => {
    renderHistory([]);
    expect(await screen.findByText(/no history yet/i)).toBeTruthy();
  });

  it("shows an error with retry", async () => {
    cellarState = {
      state: "ready",
      repository: { loadHistory: vi.fn().mockRejectedValue(new Error("Boom")) },
    };
    render(
      <MemoryRouter>
        <HistoryScreen />
      </MemoryRouter>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/Boom/);
  });

  it("offers filters that are real event types", async () => {
    renderHistory([ev()]);
    await screen.findByText("Today");
    expect(screen.getByRole("button", { name: "Consumed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delivered" })).toBeTruthy();
  });

  it("hides Load older once a short page comes back", async () => {
    renderHistory([ev()]);
    await screen.findByText("Today");
    expect(screen.queryByRole("button", { name: /load older/i })).toBeNull();
  });

  it("shows Load older when a full page comes back", async () => {
    renderHistory(Array.from({ length: 50 }, () => ev()));
    await screen.findAllByText(/Added to Home Cellar/);
    expect(screen.getByRole("button", { name: /load older/i })).toBeTruthy();
  });
});

describe("Tasting log", () => {
  it("lists tastings with rating in words", async () => {
    renderTastings([tasting({ rating: 5 })]);
    expect(await screen.findByText("Exceptional")).toBeTruthy();
  });

  it("marks a wine tasted elsewhere", async () => {
    renderTastings([tasting({ bottleId: null })]);
    expect(await screen.findByText(/tasted elsewhere/i)).toBeTruthy();
  });

  it("shows an unrated tasting honestly, not as zero", async () => {
    renderTastings([tasting({ rating: null })]);
    expect(await screen.findByText("No rating")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("DOES offer editing — unlike History", async () => {
    renderTastings([tasting()]);
    expect(await screen.findByRole("button", { name: /^edit$/i })).toBeTruthy();
  });

  it("opens an edit form with the current values", async () => {
    renderTastings([tasting({ rating: 3, notes: "Original" })]);
    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    expect(await screen.findByDisplayValue("Original")).toBeTruthy();
  });

  it("saving calls updateTasting with the version", async () => {
    const { run } = renderTastings([tasting({ version: 7 })]);
    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(run).toHaveBeenCalled());
    const mutator = { updateTasting: vi.fn().mockResolvedValue({ ok: true }) };
    await run.mock.calls[0]![1](mutator);
    expect(mutator.updateTasting).toHaveBeenCalledWith(
      expect.objectContaining({ version: 7 }),
    );
  });

  it("deletion requires a reason", async () => {
    renderTastings([tasting()]);
    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^remove$/i }));

    const confirm = await screen.findByRole("button", { name: /^remove$/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an empty state", async () => {
    renderTastings([]);
    expect(await screen.findByText(/no tastings yet/i)).toBeTruthy();
  });

  it("summarises only rated tastings in the average", async () => {
    renderTastings([tasting({ rating: 4 }), tasting({ rating: null })]);
    expect(await screen.findByText(/4 average of 1 rated/)).toBeTruthy();
  });
});

describe("mobile safety", () => {
  it("history controls meet the touch target", async () => {
    renderHistory([ev()]);
    await screen.findByText("Today");
    for (const b of screen.getAllByRole("button")) {
      const min = Number.parseInt((b as HTMLElement).style.minHeight, 10);
      if (!Number.isNaN(min)) expect(min).toBeGreaterThanOrEqual(36);
    }
  });

  it("history rows are full width", async () => {
    renderHistory([ev()]);
    await screen.findByText("Today");
    const row = screen.getByText(/Added to Home Cellar/).closest("button")!;
    expect(row.style.width).toBe("100%");
  });
});
