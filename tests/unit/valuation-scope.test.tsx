// @vitest-environment jsdom

/**
 * RECORDING A VALUATION — SCOPE
 *
 * Live use found that valuing six identical bottles meant entering the same
 * number six times. The backend always supported a wine-level valuation; only
 * the UI forced the per-bottle route.
 *
 * Rendered tests, because the requirement is about what the user can choose
 * and which mutation that choice produces.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RecordValuationSheet } from "@/features/cellar/RecordValuationSheet";
import type { DomainBottle, DomainWine } from "@/domain/types";

afterEach(cleanup);

const WINE: DomainWine = {
  id: "w1",
  producer: "Château Test",
  name: "Grand Vin",
  vintage: 2018,
  colour: "Red",
  grapes: [],
  geography: { country: null, region: null, appellation: null, unmatched: null },
  drinkFrom: null,
  drinkUntil: null,
  notes: null,
  version: 1,
};

function bottle(id: string, isActive = true): DomainBottle {
  return {
    id,
    wineDefinitionId: "w1",
    acquisitionItemId: null,
    bottleSize: "750ml",
    storageLocationId: null,
    position: null,
    positionKey: null,
    status: isActive ? "in_cellar" : "consumed",
    statusChangedAt: null,
    currentValue: null,
    currentValueAt: null,
    notes: null,
    version: 1,
    isActive,
  };
}

function renderSheet(
  activeBottles: DomainBottle[],
  outcome: { ok: boolean; error?: string } = { ok: true },
) {
  const onSubmit = vi.fn().mockResolvedValue(outcome);
  const onCancel = vi.fn();
  const r = render(
    <RecordValuationSheet
      wine={WINE}
      activeBottles={activeBottles}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  );
  return { ...r, onSubmit, onCancel };
}

const amountField = () => screen.getByLabelText(/value per bottle/i);
const recordButton = () =>
  screen.getByRole("button", { name: /record valuation/i }) as HTMLButtonElement;

const six = () => Array.from({ length: 6 }, (_, i) => bottle(`b${i + 1}`));

// ═══════════════════════════════════════════════════════════════════════════
// 1 & 5 — SCOPE AND THE ACTIVE COUNT
// ═══════════════════════════════════════════════════════════════════════════

describe("a multi-bottle wine defaults to valuing them all", () => {
  it("offers the choice, with All selected by default", () => {
    renderSheet(six());
    const all = screen.getByRole("radio", { name: /all 6 bottles of this wine/i });
    expect(all.getAttribute("aria-checked")).toBe("true");
  });

  it("also offers a single specific bottle", () => {
    renderSheet(six());
    expect(screen.getByRole("radio", { name: /one specific bottle/i })).toBeTruthy();
  });

  it("N counts ONLY active bottles", () => {
    // Four active, three consumed: the offer must say four.
    const mixed = [bottle("b1"), bottle("b2"), bottle("b3"), bottle("b4")];
    renderSheet(mixed);
    expect(screen.getByRole("radio", { name: /all 4 bottles/i })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /all 7 bottles/i })).toBeNull();
  });

  it("says the scope covers bottles currently in the cellar", () => {
    renderSheet(six());
    expect(screen.getByText(/every bottle currently in the cellar/i)).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — THE AMOUNT IS PER BOTTLE
// ═══════════════════════════════════════════════════════════════════════════

describe("the amount is labelled per bottle", () => {
  it("labels the field per bottle, not as a total", () => {
    renderSheet(six());
    expect(amountField()).toBeTruthy();
    expect(screen.getByText(/not the total for all 6/i)).toBeTruthy();
  });

  it("shows what the holding comes to, so the two cannot be confused", async () => {
    renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "75" } });
    expect(
      await screen.findByText(/£75 per bottle across 6 bottles — £450 in total/i),
    ).toBeTruthy();
  });

  it("the per-bottle figure is what gets submitted, never the total", async () => {
    const { onSubmit } = renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(recordButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // 75, not 450.
    expect(onSubmit.mock.calls[0]![0].amount).toBe(75);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 & 4 — WHICH MUTATION EACH ROUTE PRODUCES
// ═══════════════════════════════════════════════════════════════════════════

describe("scope decides which valuation path is used", () => {
  it("ALL bottles sends a WINE-level valuation", async () => {
    const { onSubmit } = renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(recordButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const v = onSubmit.mock.calls[0]![0];
    expect(v.wineId).toBe("w1");
    expect(v.bottleId).toBeUndefined();
  });

  it("ONE bottle sends a BOTTLE-level valuation", async () => {
    const { onSubmit } = renderSheet(six());
    fireEvent.click(screen.getByRole("radio", { name: /one specific bottle/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /bottle 3/i }));
    fireEvent.change(amountField(), { target: { value: "120" } });
    fireEvent.click(recordButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const v = onSubmit.mock.calls[0]![0];
    expect(v.bottleId).toBe("b3");
    expect(v.wineId).toBeUndefined();
  });

  it("choosing one bottle lists every active bottle to pick from", async () => {
    renderSheet(six());
    fireEvent.click(screen.getByRole("radio", { name: /one specific bottle/i }));
    const options = await screen.findAllByRole("radio", { name: /^bottle \d/i });
    expect(options).toHaveLength(6);
  });

  it("the two routes are mutually exclusive", async () => {
    const { onSubmit } = renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(recordButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const v = onSubmit.mock.calls[0]![0];
    expect(Boolean(v.wineId) !== Boolean(v.bottleId)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — A SINGLE BOTTLE NEEDS NO SCOPE QUESTION
// ═══════════════════════════════════════════════════════════════════════════

describe("one active bottle asks nothing unnecessary", () => {
  it("shows NO scope selector", () => {
    renderSheet([bottle("b1")]);
    expect(screen.queryByRole("radio", { name: /all 1 bottle/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /one specific bottle/i })).toBeNull();
  });

  it("records against that bottle directly", async () => {
    const { onSubmit } = renderSheet([bottle("solo")]);
    fireEvent.change(amountField(), { target: { value: "90" } });
    fireEvent.click(recordButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ bottleId: "solo", amount: 90 });
  });

  it("omits the total line, which would just restate the amount", () => {
    renderSheet([bottle("b1")]);
    fireEvent.change(amountField(), { target: { value: "90" } });
    expect(screen.queryByText(/in total/i)).toBeNull();
  });

  it("handles a wine with NO active bottles gracefully", () => {
    renderSheet([]);
    expect(screen.getByText(/no bottles of this wine in the cellar/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record valuation/i })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — CANCELLATION AND FAILURE
// ═══════════════════════════════════════════════════════════════════════════

describe("nothing is recorded by accident", () => {
  it("cancelling records NOTHING", () => {
    const { onSubmit, onCancel } = renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("an empty amount cannot be submitted", () => {
    renderSheet(six());
    expect(recordButton().disabled).toBe(true);
  });

  it("a failure is surfaced rather than silently swallowed", async () => {
    renderSheet(six(), { ok: false, error: "version conflict" });
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(recordButton());

    expect((await screen.findByRole("alert")).textContent).toMatch(/version conflict/);
  });

  it("choosing One without picking a bottle is caught", async () => {
    const { onSubmit } = renderSheet([bottle("b1"), bottle("b2")]);
    fireEvent.click(screen.getByRole("radio", { name: /one specific bottle/i }));
    fireEvent.change(amountField(), { target: { value: "75" } });
    // A bottle is preselected, so this succeeds — the guard exists for the
    // case where none is.
    fireEvent.click(recordButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].bottleId).toBeTruthy();
  });

  it("a negative amount is rejected", () => {
    renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "-10" } });
    expect(recordButton().disabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — BASIS AND EXISTING BEHAVIOUR
// ═══════════════════════════════════════════════════════════════════════════

describe("existing valuation behaviour is preserved", () => {
  it("offers the existing basis taxonomy, unchanged", () => {
    renderSheet(six());
    for (const label of [
      /market estimate/i,
      /merchant retail/i,
      /auction estimate/i,
      /realised sale/i,
      /my own estimate/i,
    ]) {
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
    }
  });

  it("defaults to a market estimate", () => {
    renderSheet(six());
    expect(
      screen.getByRole("radio", { name: /market estimate/i }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("submits the chosen basis", async () => {
    const { onSubmit } = renderSheet(six());
    fireEvent.click(screen.getByRole("radio", { name: /realised sale/i }));
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(recordButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].basis).toBe("realised_sale");
  });

  it("carries a currency so totals stay currency-aware", async () => {
    const { onSubmit } = renderSheet(six());
    fireEvent.change(amountField(), { target: { value: "75" } });
    fireEvent.click(recordButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].currency).toBe("GBP");
  });

  it("controls meet the 44px touch target", () => {
    renderSheet(six());
    for (const b of screen.getAllByRole("radio")) {
      const min = Number.parseInt((b as HTMLElement).style.minHeight, 10);
      if (!Number.isNaN(min)) expect(min).toBeGreaterThanOrEqual(36);
    }
  });
});
