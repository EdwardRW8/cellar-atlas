// @vitest-environment jsdom

/**
 * TASTING ↔ CONSUMPTION WORKFLOWS
 *
 * Rendered interaction tests driving the real BottleActionSheet, because the
 * thing that matters here is what a person can actually reach and what the
 * buttons actually do.
 *
 * ── THE DOMAIN PRINCIPLE UNDER TEST ──────────────────────────────────────
 * A tasting and a consumption are SEPARATE mutations. They are offered
 * together for convenience, never merged. Either can succeed while the other
 * fails, and a failure of one must never undo the other.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { DomainBottle, BottleStatus } from "@/domain/types";

let cellarState: Record<string, unknown>;
vi.mock("@/hooks/useCellar", () => ({ useCellar: () => cellarState }));

const { BottleActionSheet } = await import("@/features/cellar/BottleActions");

afterEach(cleanup);

/** Records every mutation the sheet issues, in order. */
let calls: { label: string; kind: string; args: Record<string, unknown> }[];

function bottle(over: Partial<DomainBottle> = {}): DomainBottle {
  return {
    id: "b1",
    wineDefinitionId: "w1",
    acquisitionItemId: null,
    bottleSize: "750ml",
    storageLocationId: "loc1",
    position: null,
    positionKey: null,
    status: "in_cellar" as BottleStatus,
    statusChangedAt: null,
    currentValue: null,
    currentValueAt: null,
    notes: null,
    version: 4,
    isActive: true,
    ...over,
  };
}

/**
 * `outcomes` lets a test make a specific mutation fail, so partial-success
 * behaviour can be exercised honestly.
 */
function renderSheet(
  b: DomainBottle = bottle(),
  outcomes: { tasting?: boolean; status?: boolean } = {},
) {
  calls = [];
  const onClose = vi.fn();

  const mutator = {
    recordTasting: vi.fn(async (args: Record<string, unknown>) => {
      calls.push({ label: "recordTasting", kind: "tasting", args });
      return { ok: outcomes.tasting !== false };
    }),
    changeStatus: vi.fn(async (args: Record<string, unknown>) => {
      calls.push({ label: "changeStatus", kind: "status", args });
      return { ok: outcomes.status !== false };
    }),
    recordValuation: vi.fn(async () => ({ ok: true })),
    moveBottle: vi.fn(async () => ({ ok: true })),
  };

  const run = vi.fn(async (_label: string, fn: (m: unknown) => Promise<unknown>) =>
    fn(mutator),
  );

  cellarState = {
    state: "ready",
    locations: [{ id: "loc1", name: "Cellar", isExternal: false, isPositioned: false }],
    bottles: [b],
    wines: [],
    run,
  };

  const r = render(<BottleActionSheet bottle={b} wineName="Test Wine" onClose={onClose} />);
  return { ...r, onClose, mutator };
}

const btn = (name: RegExp) => screen.getByRole("button", { name });
const findBtn = (name: RegExp) => screen.findByRole("button", { name });

// ═══════════════════════════════════════════════════════════════════════════
// A — CONTEXT AT CREATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Context is available when first recording a tasting", () => {
  beforeEach(() => {
    renderSheet();
    fireEvent.click(btn(/^record tasting$/i));
  });

  it("the Context field is on the create form", () => {
    expect(screen.getByLabelText(/context/i)).toBeTruthy();
  });

  it("reuses the SAME control and wording as Edit Tasting", () => {
    const field = screen.getByLabelText(/context/i) as HTMLInputElement;
    // Free text with the existing placeholder — not a second taxonomy.
    expect(field.placeholder).toBe("With dinner, at the estate…");
  });

  it("Context persists through the normal tasting mutation", async () => {
    fireEvent.change(screen.getByLabelText(/context/i), {
      target: { value: "With Sunday lunch" },
    });
    fireEvent.click(btn(/save tasting/i));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.context).toBe("With Sunday lunch");
  });

  it("Context stays optional", async () => {
    fireEvent.click(btn(/save tasting/i));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.context).toBeUndefined();
  });

  it("the tasting is attached to the exact bottle", async () => {
    fireEvent.click(btn(/save tasting/i));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.bottleId).toBe("b1");
    expect(calls[0]!.args.wineId).toBe("w1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B — TASTING → OPTIONAL CONSUME
// ═══════════════════════════════════════════════════════════════════════════

describe("recording a tasting offers to consume the bottle", () => {
  async function recordTasting(b?: DomainBottle, outcomes = {}) {
    const r = renderSheet(b, outcomes);
    fireEvent.click(btn(/^record tasting$/i));
    fireEvent.click(btn(/save tasting/i));
    return r;
  }

  it("prompts after a successful tasting", async () => {
    await recordTasting();
    expect(await screen.findByText(/consume this bottle\?/i)).toBeTruthy();
  });

  it("offers explicit Yes and No, not an ambiguous close", async () => {
    await recordTasting();
    expect(await findBtn(/yes, consume it/i)).toBeTruthy();
    expect(btn(/no, keep it/i)).toBeTruthy();
  });

  it("NO leaves the bottle alone — only the tasting was written", async () => {
    const { onClose } = await recordTasting();
    fireEvent.click(await findBtn(/no, keep it/i));

    expect(calls.map((c) => c.kind)).toEqual(["tasting"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("YES runs the NORMAL consumption workflow, not a shortcut", async () => {
    await recordTasting();
    fireEvent.click(await findBtn(/yes, consume it/i));

    // The ordinary consume form, with its own confirm.
    expect(await screen.findByRole("button", { name: /consume/i })).toBeTruthy();
    // Nothing consumed yet — still an explicit decision.
    expect(calls.map((c) => c.kind)).toEqual(["tasting"]);
  });

  it("completing it issues TWO separate mutations in order", async () => {
    await recordTasting();
    fireEvent.click(await findBtn(/yes, consume it/i));
    fireEvent.click(await findBtn(/^consume$/i));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.kind)).toEqual(["tasting", "status"]);
    expect(calls[1]!.args.status).toBe("consumed");
    expect(calls[1]!.args.bottleId).toBe("b1");
  });

  it("a FAILED consumption does NOT roll back the tasting", async () => {
    await recordTasting(bottle(), { status: false });
    fireEvent.click(await findBtn(/yes, consume it/i));
    fireEvent.click(await findBtn(/^consume$/i));

    await waitFor(() => expect(calls).toHaveLength(2));
    // The tasting was written and stays written. No compensating delete.
    expect(calls[0]!.kind).toBe("tasting");
    expect(calls.some((c) => c.label.includes("delete"))).toBe(false);
  });

  it("an INELIGIBLE bottle is never offered consumption", async () => {
    const consumed = bottle({ status: "consumed", isActive: false });
    const { onClose } = renderSheet(consumed);
    fireEvent.click(btn(/^record tasting$/i));
    fireEvent.click(btn(/save tasting/i));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/consume this bottle\?/i)).toBeNull();
    expect(calls.map((c) => c.kind)).toEqual(["tasting"]);
  });

  it("a FAILED tasting offers no consumption at all", async () => {
    await recordTasting(bottle(), { tasting: false });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByText(/consume this bottle\?/i)).toBeNull();
    expect(calls.map((c) => c.kind)).toEqual(["tasting"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — CONSUME → OPTIONAL TASTING
// ═══════════════════════════════════════════════════════════════════════════

describe("consuming offers to record a tasting first", () => {
  function startConsume(b?: DomainBottle, outcomes = {}) {
    const r = renderSheet(b, outcomes);
    fireEvent.click(btn(/consume this bottle/i));
    return r;
  }

  it("asks before anything is committed", async () => {
    startConsume();
    expect(
      await screen.findByText(/would you like to add a tasting for this bottle\?/i),
    ).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("NO goes straight to the normal consumption form", async () => {
    startConsume();
    fireEvent.click(await findBtn(/no, just consume/i));
    expect(await findBtn(/^consume$/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("YES opens the tasting form for THAT bottle — no reselection", async () => {
    startConsume();
    fireEvent.click(await findBtn(/yes, add a tasting/i));

    const save = await findBtn(/save tasting for test wine/i);
    expect(save).toBeTruthy();
    // No bottle or wine picker appears.
    expect(screen.queryByLabelText(/choose a bottle/i)).toBeNull();
  });

  it("saving the tasting continues into the pending consumption", async () => {
    startConsume();
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/save tasting/i));

    // Straight to the consume form.
    expect(await findBtn(/^consume$/i)).toBeTruthy();
    expect(calls.map((c) => c.kind)).toEqual(["tasting"]);
  });

  it("THE REVERSE PROMPT IS SUPPRESSED — no redundant question", async () => {
    startConsume();
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/save tasting/i));
    await findBtn(/^consume$/i);

    // They already said they wanted to consume. Asking again would be absurd.
    expect(screen.queryByText(/consume this bottle\?/i)).toBeNull();
  });

  it("completes with two separate mutations, tasting first", async () => {
    startConsume();
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/save tasting/i));
    fireEvent.click(await findBtn(/^consume$/i));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.kind)).toEqual(["tasting", "status"]);
  });

  it("NO PROMPT LOOP: the whole flow asks at most one question each way", async () => {
    startConsume();
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/save tasting/i));
    await findBtn(/^consume$/i);

    expect(
      screen.queryByText(/would you like to add a tasting/i),
      "the add-tasting question returned",
    ).toBeNull();
    expect(
      screen.queryByText(/consume this bottle\?/i),
      "the consume question appeared after a consume-initiated tasting",
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — CANCELLATION AND FAILURE
// ═══════════════════════════════════════════════════════════════════════════

describe("consumption never happens by accident", () => {
  it("CANCELLING the tasting does NOT consume the bottle", async () => {
    renderSheet();
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/^back$/i));

    expect(calls, "a cancelled tasting consumed the bottle").toHaveLength(0);
  });

  it("cancelling returns to the decision, not to nowhere", async () => {
    renderSheet();
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/^back$/i));

    expect(
      await screen.findByText(/would you like to add a tasting for this bottle\?/i),
    ).toBeTruthy();
  });

  it("the user can still consume without a tasting after cancelling", async () => {
    renderSheet();
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/^back$/i));
    fireEvent.click(await findBtn(/no, just consume/i));
    fireEvent.click(await findBtn(/^consume$/i));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.kind).toBe("status");
  });

  it("a FAILED tasting during a pending consume does NOT consume", async () => {
    renderSheet(bottle(), { tasting: false });
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/yes, add a tasting/i));
    fireEvent.click(await findBtn(/save tasting/i));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls.map((c) => c.kind)).toEqual(["tasting"]);
    // Still on the tasting form; no consumption queued behind it.
    expect(screen.queryByRole("button", { name: /^consume$/i })).toBeNull();
  });

  it("cancelling the add-tasting DECISION does not consume", async () => {
    const { onClose } = renderSheet();
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/^cancel$/i));

    expect(calls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("consumption always needs a final explicit confirmation", async () => {
    renderSheet();
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/no, just consume/i));

    // Reaching the form is not consuming.
    expect(calls).toHaveLength(0);
    fireEvent.click(await findBtn(/^consume$/i));
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E — ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════════════

describe("tasting and consumption stay separate", () => {
  it("each uses its OWN mutation — never a combined one", async () => {
    const { mutator } = renderSheet();
    fireEvent.click(btn(/^record tasting$/i));
    fireEvent.click(btn(/save tasting/i));
    fireEvent.click(await findBtn(/yes, consume it/i));
    fireEvent.click(await findBtn(/^consume$/i));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(mutator.recordTasting).toHaveBeenCalledTimes(1);
    expect(mutator.changeStatus).toHaveBeenCalledTimes(1);
  });

  it("consumption uses the existing status semantics", async () => {
    renderSheet();
    fireEvent.click(btn(/consume this bottle/i));
    fireEvent.click(await findBtn(/no, just consume/i));
    fireEvent.click(await findBtn(/^consume$/i));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.status).toBe("consumed");
    expect(calls[0]!.args.version).toBe(4);
  });

  it("recording a tasting never changes bottle status", async () => {
    renderSheet();
    fireEvent.click(btn(/^record tasting$/i));
    fireEvent.click(btn(/save tasting/i));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls.every((c) => c.kind !== "status")).toBe(true);
  });

  it("every mutation goes through the repository, never a table", async () => {
    const src = (await import("node:fs")).readFileSync(
      "src/features/cellar/BottleActions.tsx",
      "utf8",
    );
    expect(src).not.toMatch(/\.from\(|getSupabase|\.rpc\(/);
  });

  it("no workflow state is persisted anywhere", async () => {
    const src = (await import("node:fs")).readFileSync(
      "src/features/cellar/BottleActions.tsx",
      "utf8",
    );
    // The origin is component state only.
    expect(src).toMatch(/useState<TastingOrigin>/);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });
});
