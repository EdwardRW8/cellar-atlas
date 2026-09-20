// @vitest-environment jsdom

/**
 * HOME AND COLLECTION CANNOT FABRICATE A COMBINED TOTAL
 *
 * Rendered tests, because the requirement is about what a person SEES. A
 * domain test proving `single` is null would not prove the screen refuses to
 * print a number.
 *
 * The scenario throughout: a cellar holding GBP and EUR valuations. The naive
 * sum would be a figure representing no real quantity, and no exchange rate
 * exists in this application to justify one.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ValuationTotal } from "@/components/ValuationTotal";
import { cellarValuation, cellarCost } from "@/domain/valuation";
import type { BottleValuation, BottleCostResult } from "@/domain/valuation";
import type { DomainBottle, WineSummary } from "@/domain/types";

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

let cellarState: Record<string, unknown>;
vi.mock("@/hooks/useCellar", () => ({ useCellar: () => cellarState }));

const { default: Home } = await import("@/features/home");
const { default: CollectionScreen } = await import("@/features/cellar/CollectionScreen");

afterEach(cleanup);

function bottle(id: string, isActive = true): DomainBottle {
  return {
    id,
    wineDefinitionId: "w1",
    acquisitionItemId: `i-${id}`,
    bottleSize: "750ml",
    storageLocationId: null,
    position: null,
    positionKey: null,
    status: isActive ? "in_cellar" : "consumed",
    statusChangedAt: null,
    currentValue: 100,
    currentValueAt: "2026-03-01T10:00:00.000Z",
    notes: null,
    version: 1,
    isActive,
  };
}

function valued(id: string, amount: number, currency: string): BottleValuation {
  return {
    bottleId: id,
    currency,
    amount,
    valuationBasis: "market_estimate",
    source: "manual",
    valuationId: `v-${id}`,
    valuedAt: "2026-03-01T10:00:00.000Z",
  };
}
const unknownCurrency = (id: string): BottleValuation => ({
  bottleId: id,
  currency: null,
  reason: "unmatched",
});

function wine(): WineSummary {
  return {
    wine: {
      id: "w1",
      producer: "P",
      name: "Wine",
      vintage: 2018,
      colour: "Red",
      grapes: [],
      geography: { country: null, region: null, appellation: null, unmatched: null },
      drinkFrom: null,
      drinkUntil: null,
      notes: null,
      version: 1,
    },
    activeBottles: 2,
    totalBottles: 2,
    locations: [],
    totalValue: 300,
    valuation: { valuedBottles: 2, activeBottles: 2 },
  };
}

function renderScreen(
  Screen: () => JSX.Element,
  bottles: DomainBottle[],
  valuations: Map<string, BottleValuation>,
) {
  cellarState = {
    state: "ready",
    error: null,
    wines: [wine()],
    bottles,
    locations: [],
    profile: null,
    costs: new Map(),
    valuations,
    repository: null,
    refresh: vi.fn(),
    run: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <Screen />
    </MemoryRouter>,
  );
}

const MIXED = new Map<string, BottleValuation>([
  ["b1", valued("b1", 100, "GBP")],
  ["b2", valued("b2", 200, "EUR")],
]);

// ═══════════════════════════════════════════════════════════════════════════
// THE CORE REQUIREMENT
// ═══════════════════════════════════════════════════════════════════════════

describe("mixed currencies are never combined on any screen", () => {
  for (const [name, Screen] of [
    ["Home", Home],
    ["Collection", CollectionScreen],
  ] as const) {
    it(`${name}: NEVER shows the fabricated sum`, () => {
      renderScreen(Screen as () => JSX.Element, [bottle("b1"), bottle("b2")], MIXED);
      const text = document.body.textContent ?? "";
      // 100 GBP + 200 EUR = "300" of nothing.
      expect(text, `${name} printed a combined total`).not.toMatch(/£300|300\.00/);
    });

    it(`${name}: shows BOTH currencies separately`, () => {
      renderScreen(Screen as () => JSX.Element, [bottle("b1"), bottle("b2")], MIXED);
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/£100/);
      expect(text).toMatch(/€200/);
    });

    it(`${name}: says plainly they are not combined`, () => {
      renderScreen(Screen as () => JSX.Element, [bottle("b1"), bottle("b2")], MIXED);
      // Collection states it on the header AND on each affected wine row,
      // so one or more is correct — zero would not be.
      expect(
        screen.getAllByLabelText(/mixed currencies, not combined/i).length,
      ).toBeGreaterThan(0);
    });

    it(`${name}: a single currency still shows a normal total`, () => {
      renderScreen(
        Screen as () => JSX.Element,
        [bottle("b1"), bottle("b2")],
        new Map([
          ["b1", valued("b1", 100, "GBP")],
          ["b2", valued("b2", 200, "GBP")],
        ]),
      );
      expect(document.body.textContent).toMatch(/£300/);
    });

    it(`${name}: partial valuation keeps its completeness`, () => {
      renderScreen(
        Screen as () => JSX.Element,
        [bottle("b1"), bottle("b2"), bottle("b3")],
        new Map([["b1", valued("b1", 100, "GBP")]]),
      );
      expect(document.body.textContent).toMatch(/1 of 3 valued/);
    });

    it(`${name}: an unvalued cellar shows NO figure, not zero`, () => {
      renderScreen(Screen as () => JSX.Element, [bottle("b1")], new Map());
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/£0\b/);
    });

    it(`${name}: UNKNOWN currency is excluded, not defaulted`, () => {
      renderScreen(
        Screen as () => JSX.Element,
        [bottle("b1"), bottle("b2")],
        new Map([
          ["b1", valued("b1", 100, "GBP")],
          ["b2", unknownCurrency("b2")],
        ]),
      );
      const text = document.body.textContent ?? "";
      // 100, not 300: the unknown-currency bottle is not silently GBP.
      expect(text).toMatch(/£100/);
      expect(text).not.toMatch(/£300/);
      expect(text).toMatch(/1 of 2 valued/);
    });

    it(`${name}: consumed bottles are excluded from the total`, () => {
      renderScreen(
        Screen as () => JSX.Element,
        [bottle("b1"), bottle("b2", false)],
        new Map([
          ["b1", valued("b1", 100, "GBP")],
          ["b2", valued("b2", 900, "GBP")],
        ]),
      );
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/£100/);
      expect(text).not.toMatch(/£1,000/);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// THE COMPONENT ITSELF
// ═══════════════════════════════════════════════════════════════════════════

describe("ValuationTotal has no path to a combined figure", () => {
  const render_ = (valuations: Map<string, BottleValuation>, bottles = ["b1", "b2"]) =>
    render(
      <ValuationTotal
        totals={cellarValuation(
          bottles.map((id) => ({ id, isActive: true })),
          valuations,
        )}
      />,
    );

  it("renders nothing at all when nothing is valued", () => {
    const { container } = render_(new Map());
    expect(container.textContent).toBe("");
  });

  it("never renders a zero", () => {
    const { container } = render_(new Map());
    expect(container.textContent).not.toMatch(/0/);
  });

  it("mixed input produces two amounts and no third", () => {
    const { container } = render_(MIXED);
    const amounts = (container.textContent ?? "").match(/[£€]\d+/g) ?? [];
    expect(amounts.sort()).toEqual(["£100", "€200"]);
  });

  it("single currency shows one amount", () => {
    const { container } = render_(
      new Map([
        ["b1", valued("b1", 100, "GBP")],
        ["b2", valued("b2", 50, "GBP")],
      ]),
    );
    expect(container.textContent).toMatch(/£150/);
  });

  it("an unrecognised currency code still renders honestly", () => {
    const { container } = render_(
      new Map([
        ["b1", valued("b1", 100, "XYZ")],
        ["b2", valued("b2", 100, "XYZ")],
      ]),
    );
    // Intl separates an unrecognised code with a non-breaking space.
    expect(container.textContent?.replace(/\u00a0/g, " ")).toMatch(/XYZ\s?200/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COST FOLLOWS THE SAME RULE
// ═══════════════════════════════════════════════════════════════════════════

describe("acquisition cost aggregates the same way", () => {
  const costs = new Map<string, BottleCostResult>([
    ["b1", { bottleId: "b1", unitPrice: 40, currency: "GBP" }],
    ["b2", { bottleId: "b2", unitPrice: 80, currency: "EUR" }],
  ]);

  it("mixed cost currencies are never summed", () => {
    const t = cellarCost(
      [
        { id: "b1", isActive: true },
        { id: "b2", isActive: true },
      ],
      costs,
    );
    expect(t.isMixed).toBe(true);
    expect(t.single).toBeNull();
  });

  it("a cost with unknown currency is excluded, not defaulted", () => {
    const t = cellarCost(
      [
        { id: "b1", isActive: true },
        { id: "b3", isActive: true },
      ],
      new Map([
        ["b1", { bottleId: "b1", unitPrice: 40, currency: "GBP" }],
        ["b3", { bottleId: "b3", unitPrice: null, reason: "no-price" }],
      ]),
    );
    expect(t.single).toMatchObject({ amount: 40, bottles: 1 });
    expect(t.absent).toBe(1);
  });

  it("consumed bottles are excluded from cost too", () => {
    const t = cellarCost(
      [
        { id: "b1", isActive: true },
        { id: "b2", isActive: false },
      ],
      costs,
    );
    expect(t.present).toBe(1);
    expect(t.isMixed).toBe(false);
  });
});
