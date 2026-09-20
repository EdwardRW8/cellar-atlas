// @vitest-environment jsdom

/**
 * RACK RENDERER
 *
 * Verifies that the renderer is genuinely layout-agnostic, that unpositioned
 * storage draws nothing, and that drag rotation works through both mouse and
 * touch — Pointer Events give one code path, so the tests exercise both
 * pointerTypes rather than assuming they behave alike.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RackRenderer, type RackBottle } from "@/features/storage/rack/RackRenderer";
import { RackBoundary } from "@/features/storage/rack/RackBoundary";
import type { LayoutType, LayoutConfig } from "@/domain/storage/layout";
import type { DomainBottle, DomainWine } from "@/domain/types";

afterEach(cleanup);

/**
 * jsdom does not implement PointerEvent, so `fireEvent.pointerMove` delivers
 * `clientX: null`. Without this polyfill the drag tests pass vacuously — the
 * rotation becomes NaN and every assertion comparing "before" to "after"
 * succeeds for the wrong reason. Verified: `clientX: [null]` before, real
 * numbers after.
 */
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}

/** Guard against the polyfill silently failing and restoring the false pass. */
it("the pointer polyfill actually delivers clientX", () => {
  const seen: number[] = [];
  const { container } = render(<div onPointerMove={(e) => seen.push(e.clientX)} />);
  fireEvent.pointerMove(container.firstChild!, { clientX: 123 });
  expect(seen).toEqual([123]);
});

const STAIRCASE = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right" as const,
};

function bottle(over: Partial<DomainBottle> = {}): DomainBottle {
  return {
    id: over.id ?? "b1",
    wineDefinitionId: "w1",
    acquisitionItemId: null,
    bottleSize: "750ml",
    storageLocationId: "loc1",
    position: { col: 1, row: 1 },
    positionKey: "c1r1",
    status: "in_cellar",
    statusChangedAt: null,
    currentValue: null,
    currentValueAt: null,
    notes: null,
    version: 1,
    isActive: true,
    ...over,
  };
}

function wine(over: Partial<DomainWine> = {}): DomainWine {
  return {
    id: "w1",
    producer: "Test",
    name: "Test Wine",
    vintage: 2018,
    colour: "Red",
    grapes: ["Merlot"],
    geography: { country: null, region: null, appellation: null, unmatched: null },
    drinkFrom: 2022,
    drinkUntil: 2035,
    notes: null,
    version: 1,
    ...over,
  };
}

function renderRack(
  type: LayoutType,
  config: LayoutConfig,
  bottles: RackBottle[] = [],
  overrides: Partial<Parameters<typeof RackRenderer>[0]> = {},
) {
  const onSelect = vi.fn();
  const result = render(
    <RackRenderer
      layoutType={type}
      layoutConfig={config}
      bottles={bottles}
      matchedBottleIds={new Set()}
      filtering={false}
      selectedKey={null}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { ...result, onSelect };
}

describe("renders every positioned layout type from one component", () => {
  it("draws 130 slots for the owner's staircase", () => {
    const { container } = renderRack("staircase", STAIRCASE);
    const shapes = container.querySelectorAll("rect, polygon");
    expect(shapes.length).toBe(130);
  });

  it("draws 4 slots for a 2x2 grid — same component", () => {
    const { container } = renderRack("grid", { rows: 2, columns: 2 });
    expect(container.querySelectorAll("rect, polygon").length).toBe(4);
  });

  it("draws shelving", () => {
    const { container } = renderRack("shelving", { shelves: [3, 2] });
    expect(container.querySelectorAll("rect, polygon").length).toBe(5);
  });

  it("draws a fridge", () => {
    const { container } = renderRack("fridge", {
      zones: [{ name: "A", shelves: 2, perShelf: 3 }],
    });
    expect(container.querySelectorAll("rect, polygon").length).toBe(6);
  });
});

describe("unpositioned storage draws NOTHING", () => {
  for (const type of ["unpositioned", "external"] as LayoutType[]) {
    it(`${type} renders an explanation, not an empty rack`, () => {
      const { container } = renderRack(type, {} as LayoutConfig);
      expect(container.querySelector("svg")).toBeNull();
      expect(screen.getByText(/no fixed positions/i)).toBeTruthy();
    });
  }
});

describe("chamfered slots are drawn differently", () => {
  it("uses a polygon for chamfered slots and a rect for the rest", () => {
    const { container } = renderRack("staircase", STAIRCASE);
    expect(container.querySelectorAll("polygon").length).toBe(13);
    expect(container.querySelectorAll("rect").length).toBe(117);
  });

  it("uses only rects when chamfer is off", () => {
    const { container } = renderRack("staircase", { ...STAIRCASE, chamfer: false });
    expect(container.querySelectorAll("polygon").length).toBe(0);
  });
});

describe("occupied and empty slots are distinguishable", () => {
  it("an occupied slot is filled by wine colour", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 2 }, [
      {
        bottle: bottle({ position: { x: 1, y: 1 }, positionKey: "x1y1" }),
        wine: wine({ colour: "Red" }),
      },
    ]);
    const fills = [...container.querySelectorAll("rect")].map((r) =>
      r.getAttribute("fill"),
    );
    expect(fills).toContain("#8B2E3C");
    expect(fills).toContain("transparent");
  });

  it("different wine types get different colours", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 2 }, [
      {
        bottle: bottle({ id: "b1", position: { x: 1, y: 1 }, positionKey: "x1y1" }),
        wine: wine({ colour: "Red" }),
      },
      {
        bottle: bottle({ id: "b2", position: { x: 2, y: 1 }, positionKey: "x2y1" }),
        wine: wine({ id: "w2", colour: "White" }),
      },
    ]);
    const fills = [...container.querySelectorAll("rect")].map((r) =>
      r.getAttribute("fill"),
    );
    expect(new Set(fills).size).toBe(2);
  });

  it("shows a drinking-window dot only for occupied slots", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 2 }, [
      { bottle: bottle({ position: { x: 1, y: 1 }, positionKey: "x1y1" }), wine: wine() },
    ]);
    expect(container.querySelectorAll("circle").length).toBe(1);
  });

  it("ignores bottles that are no longer in the cellar", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 1 }, [
      {
        bottle: bottle({
          position: { x: 1, y: 1 },
          positionKey: "x1y1",
          isActive: false,
          status: "consumed",
        }),
        wine: wine(),
      },
    ]);
    expect(container.querySelector("rect")!.getAttribute("fill")).toBe("transparent");
  });
});

describe("selection", () => {
  it("selecting an occupied slot fires onSelect with that bottle", () => {
    const { container, onSelect } = renderRack("grid", { rows: 1, columns: 1 }, [
      {
        bottle: bottle({ id: "b7", position: { x: 1, y: 1 }, positionKey: "x1y1" }),
        wine: wine(),
      },
    ]);
    fireEvent.click(container.querySelector("g")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].id).toBe("b7");
  });

  it("an empty slot does not fire onSelect", () => {
    const { container, onSelect } = renderRack("grid", { rows: 1, columns: 1 });
    fireEvent.click(container.querySelector("g")!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("occupied slots are keyboard reachable and labelled", () => {
    renderRack("grid", { rows: 1, columns: 1 }, [
      {
        bottle: bottle({ position: { x: 1, y: 1 }, positionKey: "x1y1" }),
        wine: wine({ name: "Margaux", vintage: 2015 }),
      },
    ]);
    const el = screen.getByRole("button", { name: /Margaux 2015/ });
    expect(el.getAttribute("tabindex")).toBe("0");
  });

  it("Enter activates a slot", () => {
    const { onSelect } = renderRack("grid", { rows: 1, columns: 1 }, [
      {
        bottle: bottle({ position: { x: 1, y: 1 }, positionKey: "x1y1" }),
        wine: wine({ name: "Keyboard Wine", vintage: 2020 }),
      },
    ]);
    // "Face on" is also a button, so target the slot by its label.
    fireEvent.keyDown(screen.getByRole("button", { name: /Keyboard Wine/ }), {
      key: "Enter",
    });
    expect(onSelect).toHaveBeenCalled();
  });
});

describe("drag rotation — mouse AND touch", () => {
  for (const pointerType of ["mouse", "touch"] as const) {
    it(`${pointerType}: dragging rotates the rack`, () => {
      const { container } = renderRack("grid", { rows: 2, columns: 4 });
      const svg = container.querySelector("svg")!;
      const before = container.querySelector("rect")!.getAttribute("x");

      fireEvent.pointerDown(svg, { pointerId: 1, pointerType, clientX: 100 });
      fireEvent.pointerMove(svg, { pointerId: 1, pointerType, clientX: 180 });
      fireEvent.pointerUp(svg, { pointerId: 1, pointerType });

      expect(container.querySelector("rect")!.getAttribute("x")).not.toBe(before);
    });

    it(`${pointerType}: a drag does not also select a bottle`, () => {
      const { container, onSelect } = renderRack("grid", { rows: 1, columns: 1 }, [
        { bottle: bottle({ position: { x: 1, y: 1 }, positionKey: "x1y1" }), wine: wine() },
      ]);
      const svg = container.querySelector("svg")!;

      fireEvent.pointerDown(svg, { pointerId: 1, pointerType, clientX: 100 });
      fireEvent.pointerMove(svg, { pointerId: 1, pointerType, clientX: 200 });
      fireEvent.pointerUp(svg, { pointerId: 1, pointerType });
      fireEvent.click(container.querySelector("g")!);

      expect(onSelect).not.toHaveBeenCalled();
    });

    it(`${pointerType}: a tap still selects`, () => {
      const { container, onSelect } = renderRack("grid", { rows: 1, columns: 1 }, [
        { bottle: bottle({ position: { x: 1, y: 1 }, positionKey: "x1y1" }), wine: wine() },
      ]);
      const svg = container.querySelector("svg")!;

      fireEvent.pointerDown(svg, { pointerId: 1, pointerType, clientX: 100 });
      fireEvent.pointerMove(svg, { pointerId: 1, pointerType, clientX: 101 });
      fireEvent.pointerUp(svg, { pointerId: 1, pointerType });
      fireEvent.click(container.querySelector("g")!);

      expect(onSelect).toHaveBeenCalled();
    });
  }

  it("rotation is clamped so the rack never turns edge-on", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 4 });
    const svg = container.querySelector("svg")!;
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 100000 });
    // Slots must still be laid out, not collapsed onto the axis.
    const xs = [...container.querySelectorAll("rect")].map((r) =>
      Number(r.getAttribute("x")),
    );
    expect(new Set(xs.map((x) => Math.round(x * 10))).size).toBeGreaterThan(1);
  });

  it("Face on resets rotation", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 4 });
    const svg = container.querySelector("svg")!;
    const before = container.querySelector("rect")!.getAttribute("x");

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: /face on/i }));

    expect(container.querySelector("rect")!.getAttribute("x")).toBe(before);
  });
});

describe("mobile safety", () => {
  it("the svg scales to its container rather than a fixed width", () => {
    const { container } = renderRack("staircase", STAIRCASE);
    const svg = container.querySelector("svg")!;
    expect(svg.style.width).toBe("100%");
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.getAttribute("viewBox")).toBeTruthy();
  });

  it("touch-action is none, so a rotate-drag is not read as a page scroll", () => {
    const { container } = renderRack("grid", { rows: 2, columns: 2 });
    expect(container.querySelector("svg")!.style.touchAction).toBe("none");
  });

  it("the wrapper hides overflow, so a rotated rack cannot widen the page", () => {
    const { container } = renderRack("staircase", STAIRCASE);
    expect((container.firstChild as HTMLElement).style.overflow).toBe("hidden");
  });

  it("the reset control meets the 44px touch target", () => {
    renderRack("grid", { rows: 1, columns: 1 });
    const btn = screen.getByRole("button", { name: /face on/i });
    expect(Number.parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });
});

describe("filtering highlights and fades", () => {
  const bottles: RackBottle[] = [
    {
      bottle: bottle({ id: "b1", position: { x: 1, y: 1 }, positionKey: "x1y1" }),
      wine: wine({ id: "w1" }),
    },
    {
      bottle: bottle({ id: "b2", position: { x: 2, y: 1 }, positionKey: "x2y1" }),
      wine: wine({ id: "w2" }),
    },
  ];

  it("fades non-matching slots when filtering", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 2 }, bottles, {
      filtering: true,
      matchedBottleIds: new Set(["b1"]),
    });
    const opacities = [...container.querySelectorAll("g")].map((g) =>
      g.getAttribute("opacity"),
    );
    expect(opacities).toContain("1");
    expect(opacities).toContain("0.18");
  });

  it("fades EMPTY slots too, so matches stand out", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 3 }, bottles, {
      filtering: true,
      matchedBottleIds: new Set(["b1"]),
    });
    const faded = [...container.querySelectorAll("g")].filter(
      (g) => g.getAttribute("opacity") === "0.18",
    );
    expect(faded.length).toBe(2); // one non-match, one empty
  });

  it("fades nothing when not filtering", () => {
    const { container } = renderRack("grid", { rows: 1, columns: 2 }, bottles);
    const opacities = [...container.querySelectorAll("g")].map((g) =>
      g.getAttribute("opacity"),
    );
    expect(opacities.every((o) => o === "1")).toBe(true);
  });
});

describe("inner error boundary", () => {
  function Boom(): JSX.Element {
    throw new Error("renderer exploded");
  }

  it("falls back to the list instead of blanking the screen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RackBoundary fallback={<p>List fallback</p>}>
        <Boom />
      </RackBoundary>,
    );
    expect(screen.getByText("List fallback")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/could not be drawn/i);
    spy.mockRestore();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <RackBoundary fallback={<p>List fallback</p>}>
        <p>Rack content</p>
      </RackBoundary>,
    );
    expect(screen.getByText("Rack content")).toBeTruthy();
    expect(screen.queryByText("List fallback")).toBeNull();
  });
});
