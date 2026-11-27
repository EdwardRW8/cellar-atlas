// @vitest-environment jsdom

/**
 * NO MUTATION MAY BE ATTEMPTED WHILE OFFLINE
 *
 * There is no offline queue in Phase 12.1: a change that cannot be sent is
 * simply lost. So every control that changes data is disabled while offline,
 * and the app says why rather than hiding the control.
 *
 * These render the real components. A source-level check could not tell
 * whether a control is actually reachable and disabled.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { OFFLINE_REASON } from "@/hooks/useCellar";
import type { DomainBottle, DomainWine } from "@/domain/types";

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

let cellar: Record<string, unknown>;
vi.mock("@/hooks/useCellar", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/useCellar")>("@/hooks/useCellar");
  return { ...actual, useCellar: () => cellar };
});

const { EditWineForm } = await import("@/features/cellar/EditWineForm");
const { RecordValuationSheet } = await import("@/features/cellar/RecordValuationSheet");
const { DeliverAllSheet } = await import("@/features/storage/DeliverAllSheet");
const { BottleActionSheet } = await import("@/features/cellar/BottleActions");
const { default: GeographyFixScreen } = await import("@/features/atlas/GeographyFixScreen");

afterEach(cleanup);

const WINE: DomainWine = {
  id: "w1",
  producer: "P",
  name: "W",
  vintage: 2018,
  colour: "Red",
  grapes: [],
  geography: { country: null, region: null, appellation: null, unmatched: null },
  drinkFrom: null,
  drinkUntil: null,
  notes: null,
  version: 1,
};

function bottle(id = "b1"): DomainBottle {
  return {
    id,
    wineDefinitionId: "w1",
    acquisitionItemId: null,
    bottleSize: "750ml",
    storageLocationId: "loc1",
    position: null,
    positionKey: null,
    status: "in_cellar",
    statusChangedAt: null,
    currentValue: null,
    currentValueAt: null,
    notes: null,
    version: 1,
    isActive: true,
  };
}

function setCellar(canMutate: boolean) {
  cellar = {
    state: "ready",
    error: null,
    wines: [],
    bottles: [bottle()],
    locations: [{ id: "loc1", name: "Cellar", isExternal: false, isPositioned: false }],
    profile: null,
    costs: new Map(),
    valuations: new Map(),
    pending: [],
    conflicts: [],
    failed: [],
    online: canMutate,
    canMutate,
    // Added by the first-cellar hotfix; a consumer may read any of these.
    role: canMutate ? "owner" : "viewer",
    // The permission check SUCCEEDED in these cases: what varies is
    // connectivity and role, so a screen explaining why a control is off
    // must say "offline" or "view-only" here, never "checking".
    permissionState: "known",
    recheckPermission: vi.fn(),
    errorKind: "unknown",
    creatingCellar: false,
    createCellar: vi.fn(),
    repository: { loadValuations: vi.fn().mockResolvedValue([]) },
    run: vi.fn().mockResolvedValue({ ok: true }),
    runBatch: vi.fn(),
    refresh: vi.fn(),
    dismissFailed: vi.fn(),
    dismissConflict: vi.fn(),
  };
}

const enabled = (name: RegExp) =>
  !(screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

describe("child forms refuse to submit when the parent says offline", () => {
  it.each([
    [
      "EditWineForm — Save changes",
      (can: boolean) =>
        render(
          <MemoryRouter>
            <EditWineForm wine={WINE} canMutate={can} onCancel={vi.fn()} onSave={vi.fn()} />
          </MemoryRouter>,
        ),
      /save changes/i,
    ],
    [
      "RecordValuationSheet — Record valuation",
      (can: boolean) =>
        render(
          <RecordValuationSheet
            wine={WINE}
            activeBottles={[bottle()]}
            canMutate={can}
            onCancel={vi.fn()}
            onSubmit={vi.fn()}
          />,
        ),
      /record valuation/i,
    ],
    [
      "DeliverAllSheet — Deliver",
      (can: boolean) =>
        render(
          <DeliverAllSheet
            bottles={[bottle()]}
            wines={new Map([["w1", WINE]])}
            destinations={[
              {
                id: "d1",
                name: "Home",
                kind: "home",
                layoutId: null,
                layoutType: null,
                layoutConfig: null,
                capacity: null,
                isExternal: false,
                isPositioned: false,
                occupied: 0,
                version: 1,
              },
            ]}
            allBottles={[bottle()]}
            canMutate={can}
            onCancel={vi.fn()}
            onDeliver={vi.fn()}
          />,
        ),
      /deliver \d+ bottle/i,
    ],
  ])("%s", (_label, renderIt, name) => {
    // Some of these buttons have their own preconditions (an amount, a
    // destination). Satisfy them first, so the only thing under test is the
    // offline gate.
    const satisfyPreconditions = () => {
      const amount = screen.queryByLabelText(/value per bottle/i);
      if (amount) fireEvent.change(amount, { target: { value: "90" } });
    };

    setCellar(true);
    renderIt(true);
    satisfyPreconditions();
    expect(enabled(name), "should be usable online").toBe(true);
    cleanup();

    setCellar(false);
    renderIt(false);
    satisfyPreconditions();
    expect(enabled(name), "must be disabled offline").toBe(false);
  });
});

describe("bottle actions are all disabled offline", () => {
  const open = (canMutate: boolean) => {
    setCellar(canMutate);
    render(
      <MemoryRouter>
        <BottleActionSheet bottle={bottle()} wineName="W" onClose={vi.fn()} />
      </MemoryRouter>,
    );
  };

  it("every action in the menu is still SHOWN offline, not hidden", () => {
    open(false);
    expect(screen.getByRole("button", { name: /consume this bottle/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^record tasting$/i })).toBeTruthy();
  });

  it("the tasting form cannot be submitted offline", () => {
    open(false);
    fireEvent.click(screen.getByRole("button", { name: /^record tasting$/i }));
    expect(enabled(/save tasting/i)).toBe(false);
  });

  it("…but can be online", () => {
    open(true);
    fireEvent.click(screen.getByRole("button", { name: /^record tasting$/i }));
    expect(enabled(/save tasting/i)).toBe(true);
  });
});

describe("the gate is centralised, not reimplemented per screen", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("every mutating screen takes canMutate from useCellar", () => {
    for (const f of [
      "src/features/profile/ProfileScreen.tsx",
      "src/features/cellar/WineDetailScreen.tsx",
      "src/features/cellar/BottleActions.tsx",
      "src/features/add-wine/AddWineScreen.tsx",
      "src/features/atlas/GeographyFixScreen.tsx",
      "src/features/storage/StorageDetailScreen.tsx",
      "src/features/storage/StorageScreen.tsx",
      "src/features/sync/SyncStatusBar.tsx",
      "src/features/import/ImportScreen.tsx",
      "src/features/tasting/TastingLogScreen.tsx",
    ]) {
      expect(read(f), `${f} does not read canMutate`).toMatch(/canMutate/);
    }
  });

  it("no screen checks connectivity for itself", () => {
    for (const f of [
      "src/features/profile/ProfileScreen.tsx",
      "src/features/add-wine/AddWineScreen.tsx",
      "src/features/import/ImportScreen.tsx",
    ]) {
      expect(read(f), `${f} reads navigator.onLine directly`).not.toMatch(
        /navigator\.onLine/,
      );
    }
  });

  it("every parent passes the gate down to its child form", () => {
    expect(read("src/features/cellar/WineDetailScreen.tsx")).toMatch(
      /canMutate=\{canMutate\}/,
    );
    expect(read("src/features/storage/StorageDetailScreen.tsx")).toMatch(
      /canMutate=\{canMutate\}/,
    );
    expect(read("src/features/cellar/BottleActions.tsx")).toMatch(
      /canMutate=\{canMutate\}/,
    );
  });

  it("GeographyFixScreen gates the function AND the picker", () => {
    const src = read("src/features/atlas/GeographyFixScreen.tsx");
    /*
      B2: it must SAY why, not return silently.

      This previously required the literal `setFailed(OFFLINE_REASON)`, which
      pinned the defect the 12.1 audit found: an online viewer, and a user
      whose permission check had failed, were both told they were offline.
      The requirement is unchanged — state a reason — but it must now be the
      reason that APPLIES, so the assertion is on `blockedReason`, which
      resolves to the offline wording only when actually offline.
    */
    expect(src, "apply() must state a reason").toMatch(
      /if \(!canMutate\) \{[\s\S]{0,260}setFailed\(blockedReason/,
    );
    expect(src, "the reason must be derived, not hard-coded as offline").toMatch(
      /mutationBlockMessage\(\{ online, permissionState, role \}\)/,
    );
    expect(src, "the picker must not be live offline").toMatch(/canMutate \? \(/);
  });

  it("conflict resolution is treated as a mutation", () => {
    expect(read("src/features/sync/SyncStatusBar.tsx")).toMatch(
      /!conflict\.canRebase \|\| !canMutate/,
    );
  });

  it("the offline reason is shown, and is the shared wording", () => {
    expect(OFFLINE_REASON).toBeTruthy();
    expect(read("src/features/sync/SyncStatusBar.tsx")).toMatch(/\{OFFLINE_REASON\}/);
  });
});

describe("offline, the geography picker says why instead of failing silently", () => {
  // Selecting a region saves immediately, so a silent return would look to the
  // user exactly like a change that was accepted.
  // The screen lists entries shaped { wine, activeBottles } and only shows
  // wines with an active bottle and no resolved country.
  const unresolved = {
    wine: {
      ...WINE,
      geography: { country: null, region: null, appellation: null, unmatched: "Napa" },
    },
    activeBottles: 1,
  };

  it("shows the offline reason in place of the picker", () => {
    setCellar(false);
    cellar.wines = [unresolved];
    render(
      <MemoryRouter>
        <GeographyFixScreen />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(OFFLINE_REASON).length).toBeGreaterThan(0);
  });

  it("apply() states the reason rather than returning silently", () => {
    const src = readFileSync("src/features/atlas/GeographyFixScreen.tsx", "utf8");
    const apply = src.slice(src.indexOf("const apply = async"));
    expect(apply.slice(0, 900)).toMatch(/setFailed\(blockedReason/);
    expect(apply.slice(0, 900), "must not return silently").not.toMatch(
      /if \(!canMutate\) return;/,
    );
  });

  /**
   * The behavioural counterpart to the two source checks above, and the
   * finding itself: this user has a working connection. Telling them to
   * check it would send them after a fault that does not exist.
   */
  it("an ONLINE viewer is told they are view-only, not that they are offline", () => {
    setCellar(false);
    cellar.online = true;
    cellar.role = "viewer";
    cellar.permissionState = "known";
    cellar.wines = [unresolved];
    render(
      <MemoryRouter>
        <GeographyFixScreen />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/view-only/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(OFFLINE_REASON)).toEqual([]);
  });
});

describe("ONLINE failure: the RPC rejects and the UI says nothing was saved", () => {
  it("shows NOT_SAVED and leaves no optimistic state behind", async () => {
    const { NOT_SAVED } = await import("@/hooks/useCellar");
    setCellar(true); // online — the gate allows the attempt
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: null });

    render(
      <MemoryRouter>
        <EditWineForm canMutate wine={WINE} onCancel={vi.fn()} onSave={onSave} />
      </MemoryRouter>,
    );

    const name = screen.getByLabelText("Wine");
    fireEvent.change(name, { target: { value: "Changed Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await screen.findByText(NOT_SAVED);
    expect(onSave, "the attempt was made").toHaveBeenCalledTimes(1);

    // No optimistic state: the form is still open, still editable, and still
    // holds the unsaved edit — nothing pretends the change was applied.
    expect((screen.getByLabelText("Wine") as HTMLInputElement).value).toBe("Changed Name");
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy();
    // No claim that the change was kept. (A plain /saved/ match would hit
    // NOT_SAVED itself, which is the message we WANT.)
    expect(screen.queryByText(/\bqueued\b|will sync|saved on this device/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(NOT_SAVED);
  });
});
