import { describe, it, expect } from "vitest";
import {
  emptyDraft,
  setField,
  applySuggestions,
  fieldsNeedingReview,
  setQuantity,
  setLocation,
  setPosition,
  validateIdentity,
  validatePlacement,
  toCommitPayload,
  isLargeTransaction,
  type WineDraft,
} from "@/domain/wine-draft";

describe("WineDraft — the common ingestion contract", () => {
  it("starts empty with one bottle", () => {
    const d = emptyDraft();
    expect(d.quantity).toBe(1);
    expect(d.placement.positions).toEqual([null]);
    expect(d.provenance).toEqual({});
  });

  it("records user input as authoritative — no confidence score", () => {
    const d = setField(emptyDraft(), "producer", "Test Estate");
    expect(d.identity.producer).toBe("Test Estate");
    expect(d.provenance.producer?.source).toBe("user");
    expect(d.provenance.producer?.confidence).toBeNull();
  });

  it("records automated suggestions with their confidence", () => {
    const d = applySuggestions(
      emptyDraft(),
      { producer: "AI Guess", countryCode: "FR" },
      "ai",
      0.72,
    );
    expect(d.provenance.producer?.source).toBe("ai");
    expect(d.provenance.producer?.confidence).toBe(0.72);
  });

  it("PRESERVES what AI proposed when the user overrides it", () => {
    // This is the training signal Phase 10 needs.
    let d = applySuggestions(emptyDraft(), { producer: "Chateau Guess" }, "ai", 0.6);
    d = setField(d, "producer", "Château Margaux");
    expect(d.identity.producer).toBe("Château Margaux");
    expect(d.provenance.producer?.source).toBe("user");
    expect(d.provenance.producer?.original).toBe("Chateau Guess");
  });

  it("never lets automation overwrite something the user typed", () => {
    let d = setField(emptyDraft(), "producer", "User Typed");
    d = applySuggestions(d, { producer: "AI Override" }, "ai", 0.99);
    expect(d.identity.producer).toBe("User Typed");
    expect(d.provenance.producer?.source).toBe("user");
  });

  it("flags low-confidence automated fields for review", () => {
    const d = applySuggestions(
      emptyDraft(),
      { producer: "Maybe", name: "Probably" },
      "photo",
      0.5,
    );
    expect(fieldsNeedingReview(d).sort()).toEqual(["name", "producer"]);
  });

  it("does not flag high-confidence fields", () => {
    const d = applySuggestions(emptyDraft(), { producer: "Certain" }, "barcode", 0.98);
    expect(fieldsNeedingReview(d)).toEqual([]);
  });
});

describe("quantity and placement", () => {
  it("resizes positions to match quantity", () => {
    const d = setQuantity(emptyDraft(), 12);
    expect(d.quantity).toBe(12);
    expect(d.placement.positions).toHaveLength(12);
  });

  it("preserves chosen positions when growing", () => {
    let d = setQuantity(emptyDraft(), 2);
    d = setPosition(d, 0, { col: 1, row: 1 });
    d = setQuantity(d, 4);
    expect(d.placement.positions[0]).toEqual({ col: 1, row: 1 });
    expect(d.placement.positions[3]).toBeNull();
  });

  it("clears positions when the location changes", () => {
    let d = setQuantity(emptyDraft(), 2);
    d = setPosition(d, 0, { col: 1, row: 1 });
    d = setLocation(d, "new-location");
    expect(d.placement.positions).toEqual([null, null]);
  });

  it("clamps quantity to a sane range", () => {
    expect(setQuantity(emptyDraft(), 0).quantity).toBe(1);
    expect(setQuantity(emptyDraft(), 999).quantity).toBe(120);
  });
});

describe("validation", () => {
  it("requires producer and name", () => {
    const r = validateIdentity(emptyDraft());
    expect(r.valid).toBe(false);
    expect(r.errors.producer).toBeDefined();
    expect(r.errors.name).toBeDefined();
  });

  it("accepts a minimal valid identity", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    // Wine type became mandatory in Cleanup A — a minimal VALID identity now
    // includes one. The check is not weakened; the fixture is completed.
    d = setField(d, "colour", "Red");
    expect(validateIdentity(d).valid).toBe(true);
  });

  it("rejects an identity with no wine type", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    expect(validateIdentity(d).valid).toBe(false);
    expect(validateIdentity(d).errors.colour).toBeTruthy();
  });

  it("allows a non-vintage wine", () => {
    let d = setField(emptyDraft(), "producer", "Krug");
    d = setField(d, "name", "Grande Cuvée");
    d = setField(d, "vintage", null);
    d = setField(d, "colour", "Sparkling");
    expect(validateIdentity(d).valid).toBe(true);
  });

  it("rejects an impossible vintage", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    d = setField(d, "vintage", 1500);
    expect(validateIdentity(d).errors.vintage).toBeDefined();
  });

  it("rejects a window that ends before it starts", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    d = setField(d, "drinkFrom", 2030);
    d = setField(d, "drinkUntil", 2020);
    expect(validateIdentity(d).errors.drinkUntil).toBeDefined();
  });

  it("requires a position for every bottle in positioned storage", () => {
    let d = setQuantity(emptyDraft(), 3);
    d = setLocation(d, "loc");
    const r = validatePlacement(d, "staircase");
    expect(r.valid).toBe(false);
    expect(Object.keys(r.errors)).toHaveLength(3);
  });

  it("requires NO position for unpositioned storage", () => {
    let d = setQuantity(emptyDraft(), 6);
    d = setLocation(d, "merchant");
    expect(validatePlacement(d, "external").valid).toBe(true);
    expect(validatePlacement(d, "unpositioned").valid).toBe(true);
  });

  it("rejects two bottles in the same slot", () => {
    let d = setQuantity(emptyDraft(), 2);
    d = setLocation(d, "loc");
    d = setPosition(d, 0, { col: 1, row: 1 });
    d = setPosition(d, 1, { col: 1, row: 1 });
    const r = validatePlacement(d, "staircase");
    expect(r.valid).toBe(false);
    expect(r.errors.position_1).toMatch(/Same position as bottle 1/);
  });

  it("detects duplicates regardless of key order", () => {
    let d = setQuantity(emptyDraft(), 2);
    d = setLocation(d, "loc");
    d = setPosition(d, 0, { col: 1, row: 2 });
    d = setPosition(d, 1, { row: 2, col: 1 });
    expect(validatePlacement(d, "staircase").valid).toBe(false);
  });
});

describe("commit payload", () => {
  it("produces an ITEMS ARRAY even for one wine — mixed acquisitions need no rework", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    const payload = toCommitPayload(d);
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items).toHaveLength(1);
  });

  it("computes the line total from unit price and quantity", () => {
    let d = setField(emptyDraft(), "producer", "P");
    d = setField(d, "name", "N");
    d = setQuantity(d, 12);
    d.acquisition = {
      purchasedOn: "2026-01-01",
      source: "Merchant",
      reference: null,
      unitPrice: 50,
      currency: "GBP",
      format: "case_12",
      dutyPaid: true,
    };
    const payload = toCommitPayload(d);
    expect(payload.acquisition.total_amount).toBe(600);
    expect(payload.items[0]!.line_total).toBe(600);
  });

  it("sends no wine when adding to an existing definition", () => {
    const d: WineDraft = { ...emptyDraft(), existingWineId: "abc" };
    const payload = toCommitPayload(d);
    expect(payload.wine).toBeNull();
    expect(payload.wineDefinitionId).toBe("abc");
  });
});

describe("large-transaction detection (amendment 3)", () => {
  it("a single unpositioned bottle of an existing wine is NOT large", () => {
    const d: WineDraft = { ...emptyDraft(), existingWineId: "abc" };
    expect(isLargeTransaction(d)).toBe(false);
  });

  it("a new wine IS large — it creates a definition", () => {
    expect(isLargeTransaction(emptyDraft())).toBe(true);
  });

  it("multiple bottles ARE large", () => {
    const base: WineDraft = { ...emptyDraft(), existingWineId: "abc" };
    const d = setQuantity(base, 12);
    expect(isLargeTransaction(d)).toBe(true);
  });

  it("positioned bottles ARE large", () => {
    let d: WineDraft = { ...emptyDraft(), existingWineId: "abc" };
    d = setPosition(d, 0, { col: 1, row: 1 });
    expect(isLargeTransaction(d)).toBe(true);
  });
});
