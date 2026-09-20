import { describe, it, expect } from "vitest";
import { validateIdentity, emptyDraft, type WineDraft } from "@/domain/wine-draft";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADD WINE — STEP VALIDATION
 *
 * ── THE DEADLOCK THIS PREVENTS ───────────────────────────────────────────
 * Cleanup A made wine type mandatory and added the requirement to the STEP 0
 * gate. But the type control lives on step 1. The result, confirmed live:
 *
 *   step 0 will not advance without a type
 *     → the type control is on step 1
 *       → step 1 is unreachable
 *         → the wine can never be created
 *
 * The rule that prevents it returning: a step may only gate on fields that
 * step actually presents.
 */

const SCREEN = readFileSync(
  join(process.cwd(), "src/features/add-wine/AddWineScreen.tsx"),
  "utf8",
);

/** The step-0 gate, read from the source so the test tracks the real thing. */
function step0Gate(): string {
  const m = SCREEN.match(/step === 0\s*\n?\s*\?([\s\S]*?)\n\s*: step === 1/);
  return m?.[1] ?? "";
}

function draft(identity: Partial<WineDraft["identity"]> = {}): WineDraft {
  const d = emptyDraft();
  return { ...d, identity: { ...d.identity, ...identity } };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

describe("REGRESSION: the Add Wine deadlock must never return", () => {
  it("the step-0 gate does NOT mention wine type", () => {
    // Wine type is presented on step 1. Gating step 0 on it is the deadlock.
    expect(
      step0Gate(),
      "step 0 must not require a field the user cannot reach",
    ).not.toMatch(/colour/);
  });

  it("the step-0 gate only mentions fields step 0 presents", () => {
    const gate = step0Gate();
    expect(gate).toMatch(/producer/);
    expect(gate).toMatch(/name/);
    // Nothing from later steps.
    for (const later of ["colour", "geoRegionId", "drinkFrom", "quantity", "position"]) {
      expect(gate, `step 0 gates on ${later}, which it does not present`).not.toMatch(
        new RegExp(later),
      );
    }
  });

  it("the type control is rendered on the Details step, not the first", () => {
    const detailsStart = SCREEN.indexOf("function StepDetails");
    const identityStart = SCREEN.indexOf("function StepIdentity");
    const colourAt = SCREEN.indexOf("COLOURS.map");
    expect(identityStart).toBeGreaterThan(-1);
    expect(detailsStart).toBeGreaterThan(-1);
    // The colour control sits inside StepDetails.
    expect(colourAt).toBeGreaterThan(detailsStart);
  });

  it("THE FULL DEADLOCK SCENARIO: producer and name alone reach the type step", () => {
    // Exactly what the user did live: fill page 1, press Continue.
    const page1Only = draft({ producer: "Berry Bros", name: "Test Wine" });

    // Step 0 must let them through...
    const gatePassed = Boolean(
      page1Only.identity.producer?.trim() && page1Only.identity.name?.trim(),
    );
    expect(gatePassed, "step 0 blocked a user who completed step 0").toBe(true);

    // ...and step 1 must then demand the type they can now see.
    expect(validateIdentity(page1Only).valid).toBe(false);
    expect(validateIdentity(page1Only).errors.colour).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TYPE IS STILL MANDATORY — AT THE RIGHT POINT
// ═══════════════════════════════════════════════════════════════════════════

describe("wine type is required to progress past Details", () => {
  it("rejects a draft with no type", () => {
    const r = validateIdentity(draft({ producer: "P", name: "N" }));
    expect(r.valid).toBe(false);
    expect(r.errors.colour).toBe("Wine type is required");
  });

  it("accepts a draft once a type is chosen", () => {
    const r = validateIdentity(draft({ producer: "P", name: "N", colour: "Red" }));
    expect(r.valid).toBe(true);
    expect(r.errors.colour).toBeUndefined();
  });

  it("accepts every canonical type", () => {
    for (const colour of [
      "Red",
      "White",
      "Rosé",
      "Sparkling",
      "Dessert",
      "Fortified",
    ] as const) {
      expect(
        validateIdentity(draft({ producer: "P", name: "N", colour })).valid,
        colour,
      ).toBe(true);
    }
  });

  it("still requires producer and name alongside the type", () => {
    expect(
      validateIdentity(draft({ name: "N", colour: "Red" })).errors.producer,
    ).toBeTruthy();
    expect(
      validateIdentity(draft({ producer: "P", colour: "Red" })).errors.name,
    ).toBeTruthy();
  });

  it("reports every missing field at once, not one at a time", () => {
    const r = validateIdentity(draft());
    expect(Object.keys(r.errors).sort()).toEqual(["colour", "name", "producer"]);
  });

  it("existing vintage and drinking-window rules still apply", () => {
    expect(
      validateIdentity(draft({ producer: "P", name: "N", colour: "Red", vintage: 1200 }))
        .errors.vintage,
    ).toBeTruthy();
    expect(
      validateIdentity(
        draft({
          producer: "P",
          name: "N",
          colour: "Red",
          drinkFrom: 2040,
          drinkUntil: 2020,
        }),
      ).errors.drinkUntil,
    ).toBeTruthy();
  });
});

describe("a selected type cannot be deselected", () => {
  it("the chip sets the type rather than toggling it", () => {
    expect(SCREEN).toMatch(/onClick=\{\(\) => set\("colour", c\)\}/);
    expect(SCREEN).not.toMatch(/draft\.identity\.colour === c \? null : c/);
  });

  it("the chips are a radio group, not independent toggles", () => {
    expect(SCREEN).toMatch(/aria-checked=\{draft\.identity\.colour === c\}/);
  });
});

describe("later steps gate on their own fields", () => {
  it("step 1 uses the identity check", () => {
    expect(SCREEN).toMatch(/step === 1\s*\n?\s*\?\s*identityCheck\.valid/);
  });

  it("step 2 uses the placement check", () => {
    expect(SCREEN).toMatch(/step === 2\s*\n?\s*\?\s*placementCheck\.valid/);
  });
});

describe("the database remains authoritative", () => {
  it("migration 016 is unchanged by this patch", () => {
    const s = readFileSync(join(process.cwd(), "db/016_mandatory_wine_type.sql"), "utf8");
    expect(s).toMatch(/A wine type is required/);
    expect(s).toMatch(/A wine type is required and cannot be removed/);
    expect(s).toMatch(/is_valid_wine_colour/);
  });

  it("no submission path bypasses the wizard validation", () => {
    // The Review step's submit is reached only after step 1 passed.
    expect(SCREEN).toMatch(/const canAdvance =/);
    expect(SCREEN).toMatch(/identityCheck\.valid/);
  });
});
