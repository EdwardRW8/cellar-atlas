// @vitest-environment jsdom

/**
 * Proves the E2E drag assertion is sound against the REAL renderer.
 *
 * The live test previously compared only the first slot's `x`. Rotation is
 * applied per slot and is proportional to distance from the axis, so a slot
 * near the centre barely moves. This demonstrates that directly, and shows
 * the all-slots comparison the E2E test now uses does detect rotation.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { RackRenderer } from "@/features/storage/rack/RackRenderer";
import type { LayoutConfig } from "@/domain/storage/layout";

afterEach(cleanup);

class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
}

function geometry(container: HTMLElement): string[] {
  return [...container.querySelectorAll("rect, polygon")].map((el) =>
    [
      el.getAttribute("x") ?? "",
      el.getAttribute("y") ?? "",
      el.getAttribute("points") ?? "",
    ].join("|"),
  );
}

function drag(container: HTMLElement, dx: number) {
  const svg = container.querySelector("svg")!;
  fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(svg, { pointerId: 1, clientX: 100 + dx });
  fireEvent.pointerUp(svg, { pointerId: 1 });
}

function renderGrid(columns: number) {
  return render(
    <RackRenderer
      layoutType="grid"
      layoutConfig={{ rows: 1, columns } as LayoutConfig}
      bottles={[]}
      matchedBottleIds={new Set()}
      filtering={false}
      selectedKey={null}
      onSelect={() => {}}
    />,
  );
}

describe("why the single-slot assertion was invalid", () => {
  it("a slot ON the rotation axis does not move — the old test's blind spot", () => {
    // An odd column count puts the middle slot exactly on the axis.
    const { container } = renderGrid(3);
    const before = geometry(container);
    drag(container, 100);
    const after = geometry(container);

    // The middle slot is unchanged...
    expect(after[1]).toBe(before[1]);
    // ...while the rack as a whole has clearly rotated.
    expect(after).not.toEqual(before);
  });

  it("the all-slots comparison detects the rotation the old one missed", () => {
    const { container } = renderGrid(3);
    const before = geometry(container);
    drag(container, 100);
    const changed = geometry(container).filter((g, i) => g !== before[i]).length;
    expect(changed).toBeGreaterThan(0);
  });
});

describe("the Face on control mirrors rotation state", () => {
  it("is disabled at rest and enabled after a drag", () => {
    const { container, getByRole } = renderGrid(4);
    const faceOn = () => getByRole("button", { name: /face on/i }) as HTMLButtonElement;

    expect(faceOn().disabled).toBe(true);
    drag(container, 100);
    expect(faceOn().disabled).toBe(false);
  });

  it("returns to disabled, and geometry to original, after reset", () => {
    const { container, getByRole } = renderGrid(4);
    const original = geometry(container);
    const faceOn = () => getByRole("button", { name: /face on/i }) as HTMLButtonElement;

    drag(container, 100);
    expect(faceOn().disabled).toBe(false);

    fireEvent.click(faceOn());
    expect(faceOn().disabled).toBe(true);
    expect(geometry(container)).toEqual(original);
  });

  it("a sub-slop nudge rotates only fractionally but still registers", () => {
    const { container, getByRole } = renderGrid(4);
    drag(container, 6);
    expect(
      (getByRole("button", { name: /face on/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
