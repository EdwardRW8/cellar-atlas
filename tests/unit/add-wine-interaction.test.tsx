// @vitest-environment jsdom

/**
 * ADD WINE — REAL INTERACTION
 *
 * The previous regression test read the `canAdvance` expression from source.
 * That was not enough: the rendered button's disabled attribute is
 *
 *   !canAdvance || (step === 0 && shouldBlock(duplicates))
 *
 * so a source-level check of `canAdvance` alone could pass while the button
 * stayed disabled for an entirely different reason.
 *
 * This test renders the actual screen and drives it as a person does: type a
 * producer, type a wine name, look at the button.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WineSummary } from "@/domain/types";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

/** Stable object: a fresh one each call re-fires effects keyed on it. */
const stubRepository = { searchGeography: vi.fn().mockResolvedValue([]) };
let cellarState: Record<string, unknown>;
vi.mock("@/hooks/useCellar", () => ({ useCellar: () => cellarState }));

const { default: AddWineScreen } = await import("@/features/add-wine/AddWineScreen");

afterEach(cleanup);

function existingWine(over: Partial<WineSummary["wine"]> = {}): WineSummary {
  return {
    wine: {
      id: "w1",
      producer: "Château Margaux",
      name: "Grand Vin",
      vintage: 2018,
      colour: "Red",
      grapes: [],
      geography: { country: null, region: null, appellation: null, unmatched: null },
      drinkFrom: null,
      drinkUntil: null,
      notes: null,
      version: 1,
      ...over,
    },
    activeBottles: 3,
    totalBottles: 3,
    locations: [],
    totalValue: null,
    valuation: { valuedBottles: 0, activeBottles: 0 },
  };
}

function renderAddWine(wines: WineSummary[] = []) {
  cellarState = {
    state: "ready",
    error: null,
    wines,
    bottles: [],
    locations: [],
    profile: null,
    repository: stubRepository,
    run: vi.fn().mockResolvedValue({ ok: true }),
    runBatch: vi.fn(),
    refresh: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <AddWineScreen />
    </MemoryRouter>,
  );
}

const continueButton = () =>
  screen.getByRole("button", { name: /^continue$/i }) as HTMLButtonElement;

/** Type into a labelled field exactly as a user would. */
function type(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("THE LIVE SCENARIO: producer + wine name on the first screen", () => {
  it("Continue is disabled before anything is entered", () => {
    renderAddWine();
    expect(continueButton().disabled).toBe(true);
  });

  it("wine type is NOT on the first screen", () => {
    renderAddWine();
    // Nothing to choose here — which is why gating on it deadlocked.
    expect(screen.queryByRole("radio", { name: "Red" })).toBeNull();
  });

  it("CONTINUE BECOMES ENABLED with producer and name alone", async () => {
    renderAddWine();
    type(/producer/i, "Berry Bros");
    type(/wine name/i, "Test Wine");

    await waitFor(() =>
      expect(
        continueButton().disabled,
        "Continue must enable once step 0's own fields are complete",
      ).toBe(false),
    );
  });

  it("no vintage is required to continue", async () => {
    renderAddWine();
    type(/producer/i, "Krug");
    type(/wine name/i, "Grande Cuvée");
    await waitFor(() => expect(continueButton().disabled).toBe(false));
  });

  it("the user can actually REACH the step holding wine type", async () => {
    renderAddWine();
    type(/producer/i, "Berry Bros");
    type(/wine name/i, "Test Wine");
    await waitFor(() => expect(continueButton().disabled).toBe(false));

    fireEvent.click(continueButton());

    // The type control is now on screen.
    await waitFor(() => expect(screen.getByRole("radio", { name: "Red" })).toBeTruthy());
  });

  it("and CANNOT leave that step without choosing a type", async () => {
    renderAddWine();
    type(/producer/i, "Berry Bros");
    type(/wine name/i, "Test Wine");
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    fireEvent.click(continueButton());

    await waitFor(() => expect(screen.getByRole("radio", { name: "Red" })).toBeTruthy());
    // Mandatory type still enforced — just at the right step.
    expect(continueButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    await waitFor(() => expect(continueButton().disabled).toBe(false));
  });
});

describe("an exact duplicate legitimately blocks Continue", () => {
  it("blocks when the same wine already exists", async () => {
    renderAddWine([existingWine()]);
    type(/producer/i, "Château Margaux");
    type(/wine name/i, "Grand Vin");
    type(/vintage/i, "2018");

    // This is intended behaviour, not the deadlock: the wine is already here.
    await waitFor(() => expect(continueButton().disabled).toBe(true));
    expect(screen.getByText(/already/i)).toBeTruthy();
  });

  it("does NOT block a genuinely different wine", async () => {
    renderAddWine([existingWine()]);
    type(/producer/i, "Completely Different Estate");
    type(/wine name/i, "Another Wine");
    await waitFor(() => expect(continueButton().disabled).toBe(false));
  });
});
