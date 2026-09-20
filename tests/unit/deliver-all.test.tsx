// @vitest-environment jsdom

/**
 * DELIVER ALL — POSITIONED DESTINATIONS
 *
 * The live failure: six bottles at a merchant, delivered to a staircase rack,
 * all six refused. The UI sent `position: null`; `validate_position` correctly
 * raised "A staircase location requires a position".
 *
 * The database was right. These tests prove the UI now asks.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { DeliverAllSheet, humaniseFailure } from "@/features/storage/DeliverAllSheet";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainBottle, DomainStorageLocation, DomainWine } from "@/domain/types";

afterEach(cleanup);

function bottle(id: string, over: Partial<DomainBottle> = {}): DomainBottle {
  return {
    id,
    wineDefinitionId: "w1",
    acquisitionItemId: null,
    bottleSize: "750ml",
    storageLocationId: "bbr",
    position: null,
    positionKey: null,
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

const WINE: DomainWine = {
  id: "w1",
  producer: "Berry Bros",
  name: "Test Wine",
  vintage: 2018,
  colour: "Red",
  grapes: [],
  geography: { country: null, region: null, appellation: null, unmatched: null },
  drinkFrom: 2022,
  drinkUntil: 2040,
  notes: null,
  version: 1,
};

function location(over: Partial<DomainStorageLocation> = {}): DomainStorageLocation {
  return {
    id: "dest",
    name: "Cellar",
    kind: "home",
    layoutId: "l1",
    layoutType: null,
    layoutConfig: null,
    capacity: null,
    isExternal: false,
    isPositioned: false,
    occupied: 0,
    version: 1,
    ...over,
  };
}

/** The owner's real rack, as configuration. */
const STAIRCASE = location({
  id: "staircase",
  name: "Cellar",
  layoutType: "staircase",
  layoutConfig: {
    chamfer: true,
    columns: 13,
    heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    orientation: "ascending-right",
  },
  capacity: 130,
  isPositioned: true,
});

const GRID = location({
  id: "grid",
  name: "Wall Rack",
  layoutType: "grid",
  layoutConfig: { rows: 2, columns: 3 },
  capacity: 6,
  isPositioned: true,
});

const UNPOSITIONED = location({ id: "shelf", name: "Shelf" });

function renderSheet(
  destinations: DomainStorageLocation[],
  bottles: DomainBottle[],
  allBottles: DomainBottle[] = bottles,
) {
  const onDeliver = vi
    .fn()
    .mockResolvedValue({ delivered: bottles.map((b) => b.id), failed: [] });
  const r = render(
    <DeliverAllSheet
      bottles={bottles}
      wines={new Map([["w1", WINE]])}
      destinations={destinations}
      allBottles={allBottles}
      onCancel={vi.fn()}
      onDeliver={onDeliver}
    />,
  );
  return { ...r, onDeliver };
}

const deliverButton = () =>
  screen.getByRole("button", { name: /^deliver \d+ bottles?$/i }) as HTMLButtonElement;

// ═══════════════════════════════════════════════════════════════════════════
// 1 — UNPOSITIONED DESTINATION IS UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

describe("unpositioned destination needs no extra step", () => {
  it("Deliver is enabled immediately", () => {
    renderSheet([UNPOSITIONED], [bottle("b1"), bottle("b2")]);
    expect(deliverButton().disabled).toBe(false);
  });

  it("shows NO slot picker", () => {
    renderSheet([UNPOSITIONED], [bottle("b1")]);
    expect(screen.queryByText(/needs a slot/i)).toBeNull();
    expect(screen.queryByText(/slots in/i)).toBeNull();
  });

  it("delivers with NULL positions", async () => {
    const { onDeliver } = renderSheet([UNPOSITIONED], [bottle("b1"), bottle("b2")]);
    fireEvent.click(deliverButton());
    await waitFor(() => expect(onDeliver).toHaveBeenCalled());

    const [selected, destId, positions] = onDeliver.mock.calls[0]!;
    expect(selected).toHaveLength(2);
    expect(destId).toBe("shelf");
    expect(positions).toEqual([null, null]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 & 3 — POSITIONED DESTINATIONS REQUIRE SLOTS
// ═══════════════════════════════════════════════════════════════════════════

describe("a positioned destination cannot be confirmed without slots", () => {
  for (const dest of [GRID, STAIRCASE]) {
    it(`${dest.layoutType}: Deliver is DISABLED until every bottle has a slot`, () => {
      renderSheet([dest], [bottle("b1"), bottle("b2")]);
      expect(deliverButton().disabled).toBe(true);
    });

    it(`${dest.layoutType}: says how many bottles still need a slot`, () => {
      renderSheet([dest], [bottle("b1"), bottle("b2")]);
      expect(screen.getByText(/2 bottles still need a slot/i)).toBeTruthy();
    });

    it(`${dest.layoutType}: explains why a slot is needed`, () => {
      renderSheet([dest], [bottle("b1")]);
      expect(screen.getByText(/uses fixed positions/i)).toBeTruthy();
    });

    it(`${dest.layoutType}: offers bulk fill for several bottles`, () => {
      renderSheet([dest], [bottle("b1"), bottle("b2"), bottle("b3")]);
      // Reused from PositionPicker — a twelve-bottle delivery is one tap.
      expect(
        screen.getByRole("button", { name: /fill the next 3 free slots/i }),
      ).toBeTruthy();
    });

    it(`${dest.layoutType}: bulk fill assigns valid unique slots and enables Deliver`, async () => {
      const { onDeliver } = renderSheet([dest], [bottle("b1"), bottle("b2")]);
      fireEvent.click(screen.getByRole("button", { name: /fill the next 2 free slots/i }));
      await waitFor(() => expect(deliverButton().disabled).toBe(false));

      fireEvent.click(deliverButton());
      await waitFor(() => expect(onDeliver).toHaveBeenCalled());

      const positions = onDeliver.mock.calls[0]![2] as (Record<string, number> | null)[];
      expect(positions).toHaveLength(2);
      expect(positions.every((p) => p !== null)).toBe(true);

      // Unique.
      const keys = positions.map((p) => JSON.stringify(p));
      expect(new Set(keys).size).toBe(2);
    });
  }

  it("staircase positions use the staircase shape, not a grid shape", async () => {
    // Two bottles: the bulk-fill control only appears for more than one,
    // which is PositionPicker's existing behaviour.
    const { onDeliver } = renderSheet([STAIRCASE], [bottle("b1"), bottle("b2")]);
    fireEvent.click(screen.getByRole("button", { name: /fill the next 2 free slots/i }));
    await waitFor(() => expect(deliverButton().disabled).toBe(false));
    fireEvent.click(deliverButton());
    await waitFor(() => expect(onDeliver).toHaveBeenCalled());

    const position = (onDeliver.mock.calls[0]![2] as Record<string, number>[])[0]!;
    expect(Object.keys(position).sort()).toEqual(["col", "row"]);
  });

  it("grid positions use the grid shape", async () => {
    const { onDeliver } = renderSheet([GRID], [bottle("b1"), bottle("b2")]);
    fireEvent.click(screen.getByRole("button", { name: /fill the next 2 free slots/i }));
    await waitFor(() => expect(deliverButton().disabled).toBe(false));
    fireEvent.click(deliverButton());
    await waitFor(() => expect(onDeliver).toHaveBeenCalled());

    const position = (onDeliver.mock.calls[0]![2] as Record<string, number>[])[0]!;
    expect(Object.keys(position).sort()).toEqual(["x", "y"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 & 5 — OCCUPIED AND DUPLICATE SLOTS
// ═══════════════════════════════════════════════════════════════════════════

describe("occupied and duplicate slots", () => {
  it("an occupied slot is excluded from the free count", () => {
    // Fill 5 of the 6 grid slots.
    const occupants = ["x1y1", "x2y1", "x3y1", "x1y2", "x2y2"].map((key, i) =>
      bottle(`occ${i}`, { storageLocationId: "grid", positionKey: key }),
    );
    renderSheet([GRID], [bottle("b1")], [bottle("b1"), ...occupants]);
    expect(screen.getByText(/1 of 6 slots free/i)).toBeTruthy();
  });

  it("bulk fill cannot exceed the free slots", async () => {
    const occupants = ["x1y1", "x2y1", "x3y1", "x1y2", "x2y2"].map((key, i) =>
      bottle(`occ${i}`, { storageLocationId: "grid", positionKey: key }),
    );
    const bottles = [bottle("b1"), bottle("b2")];
    const { onDeliver } = renderSheet([GRID], bottles, [...bottles, ...occupants]);

    fireEvent.click(screen.getByRole("button", { name: /fill the next 2 free slots/i }));
    // Only one slot free, so one bottle remains unassigned and Deliver stays off.
    await waitFor(() => expect(deliverButton().disabled).toBe(true));
    expect(onDeliver).not.toHaveBeenCalled();
  });

  it("assigned slots are unique across the pending delivery", async () => {
    const { onDeliver } = renderSheet([GRID], [bottle("b1"), bottle("b2"), bottle("b3")]);
    fireEvent.click(screen.getByRole("button", { name: /fill the next 3 free slots/i }));
    await waitFor(() => expect(deliverButton().disabled).toBe(false));
    fireEvent.click(deliverButton());
    await waitFor(() => expect(onDeliver).toHaveBeenCalled());

    const positions = onDeliver.mock.calls[0]![2] as Record<string, number>[];
    expect(new Set(positions.map((p) => JSON.stringify(p))).size).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 & 7 — PARTIAL SUCCESS AND TRUTHFUL MESSAGING
// ═══════════════════════════════════════════════════════════════════════════

describe("partial success is reported honestly", () => {
  async function deliverWith(result: {
    delivered: string[];
    failed: { bottleId: string; error: string }[];
  }) {
    const onDeliver = vi.fn().mockResolvedValue(result);
    render(
      <DeliverAllSheet
        bottles={[bottle("b1"), bottle("b2"), bottle("b3")]}
        wines={new Map([["w1", WINE]])}
        destinations={[UNPOSITIONED]}
        allBottles={[bottle("b1"), bottle("b2"), bottle("b3")]}
        onCancel={vi.fn()}
        onDeliver={onDeliver}
      />,
    );
    fireEvent.click(deliverButton());
    await waitFor(() => expect(onDeliver).toHaveBeenCalled());
  }

  it("reports successes and failures separately", async () => {
    await deliverWith({
      delivered: ["b1", "b2"],
      failed: [{ bottleId: "b3", error: "version conflict" }],
    });
    expect(await screen.findByText(/2 bottles delivered/i)).toBeTruthy();
    expect(screen.getByText(/1 bottle could not be delivered/i)).toBeTruthy();
  });

  it("NEVER claims failures are queued or will retry", async () => {
    await deliverWith({
      delivered: [],
      failed: [
        { bottleId: "b1", error: "requires a position" },
        { bottleId: "b2", error: "requires a position" },
        { bottleId: "b3", error: "requires a position" },
      ],
    });
    const text = document.body.textContent?.toLowerCase() ?? "";
    // The original wording was false: nothing enqueued them.
    expect(text).not.toContain("queued");
    expect(text).not.toContain("will retry");
  });

  it("says where failed bottles remain", async () => {
    await deliverWith({
      delivered: ["b1"],
      failed: [{ bottleId: "b2", error: "conflict" }],
    });
    expect(screen.getByText(/remains at/i)).toBeTruthy();
  });

  it("does not claim a success count when nothing succeeded", async () => {
    await deliverWith({
      delivered: [],
      failed: [{ bottleId: "b1", error: "conflict" }],
    });
    expect(screen.queryByText(/0 bottles delivered/i)).toBeNull();
  });
});

describe("failure reasons are human, never raw SQL", () => {
  it("translates each known failure", () => {
    expect(humaniseFailure("A staircase location requires a position")).toMatch(
      /slot is no longer available/i,
    );
    expect(humaniseFailure("version conflict: expected 1, got 2")).toMatch(
      /changed on another device/i,
    );
    expect(humaniseFailure("duplicate key value violates unique constraint")).toMatch(
      /just been taken/i,
    );
    expect(humaniseFailure("new row violates row-level security policy")).toMatch(
      /do not have permission/i,
    );
  });

  it("falls back without leaking internals", () => {
    const out = humaniseFailure("ERROR 23514: constraint bottles_position_key_check");
    expect(out).toBe("Could not be delivered.");
    expect(out).not.toMatch(/23514|constraint|ERROR/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 & 9 — DELIVERY SEMANTICS AND REUSE
// ═══════════════════════════════════════════════════════════════════════════

describe("delivery semantics and geometry reuse", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src/features/storage/DeliverAllSheet.tsx"),
    "utf8",
  );

  it("reuses PositionPicker rather than reimplementing geometry", () => {
    expect(SRC).toMatch(/import \{ PositionPicker \} from "\.\/StoragePickers"/);
    expect(SRC).toMatch(/<PositionPicker/);
  });

  it("contains NO layout geometry of its own", () => {
    expect(SRC).not.toMatch(/enumeratePositions|validatePosition|heights|chamfer/);
    expect(SRC).not.toMatch(/\bcol\b\s*[:=]|\brow\b\s*[:=]/);
  });

  it("hard-codes no capacity or rack shape", () => {
    expect(SRC).not.toMatch(/\b130\b/);
    expect(SRC).not.toMatch(/\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7/);
  });

  it("delivery still goes through deliverBottles with isDelivery", () => {
    const mut = readFileSync(
      join(process.cwd(), "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(mut).toMatch(/deliverBottles[\s\S]{0,900}isDelivery: true/);
    expect(mut).toMatch(/isDelivery \? "delivered" : "moved"/);
  });

  it("each bottle still gets its own operation id — no atomic bulk RPC", () => {
    const mut = readFileSync(
      join(process.cwd(), "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(mut).toMatch(/deliverBottles[\s\S]{0,900}this\.moveBottle\(/);
    expect(mut).not.toMatch(/"bulk_move|"deliver_bottles"/);
  });

  it("positions are passed through to moveBottle", () => {
    const mut = readFileSync(
      join(process.cwd(), "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(mut).toMatch(/position: positions\?\.\[i\] \?\? null/);
  });
});

describe("mobile safety", () => {
  it("controls meet the touch target", () => {
    renderSheet([GRID], [bottle("b1")]);
    for (const b of screen.getAllByRole("button")) {
      const min = Number.parseInt((b as HTMLElement).style.minHeight, 10);
      if (!Number.isNaN(min)) expect(min).toBeGreaterThanOrEqual(36);
    }
  });

  it("handles having nowhere to deliver to", () => {
    renderSheet([], [bottle("b1")]);
    expect(screen.getByRole("alert").textContent).toMatch(/nowhere to deliver/i);
  });
});
