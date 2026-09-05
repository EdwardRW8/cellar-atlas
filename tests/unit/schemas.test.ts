import { describe, it, expect } from "vitest";
import {
  staircaseConfigSchema,
  valuationInputSchema,
  wineDefinitionInputSchema,
  parseLayoutConfig,
  toNumber,
} from "@/data/schemas";

describe("staircase config validation", () => {
  it("accepts the owner's rack", () => {
    const r = staircaseConfigSchema.safeParse({
      columns: 13,
      heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      chamfer: true,
      orientation: "ascending-right",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a heights array that does not match the column count", () => {
    const r = staircaseConfigSchema.safeParse({
      columns: 13,
      heights: [4, 5, 6],
      chamfer: true,
      orientation: "ascending-right",
    });
    expect(r.success).toBe(false);
  });

  it("rejects zero or negative heights", () => {
    expect(
      staircaseConfigSchema.safeParse({
        columns: 2,
        heights: [4, 0],
        chamfer: false,
        orientation: "ascending-right",
      }).success,
    ).toBe(false);
  });
});

describe("valuation input — basis is separate from source (amendment 6)", () => {
  it("accepts a realised auction sale", () => {
    const r = valuationInputSchema.safeParse({
      bottle_id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 450,
      valuation_basis: "realised_sale",
      source: "auction_house",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a merchant list price", () => {
    const r = valuationInputSchema.safeParse({
      wine_definition_id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 600,
      valuation_basis: "merchant_retail",
      source: "merchant",
    });
    expect(r.success).toBe(true);
  });

  it("requires exactly one target", () => {
    expect(
      valuationInputSchema.safeParse({
        amount: 100,
        valuation_basis: "manual_estimate",
      }).success,
    ).toBe(false);

    expect(
      valuationInputSchema.safeParse({
        wine_definition_id: "550e8400-e29b-41d4-a716-446655440000",
        bottle_id: "550e8400-e29b-41d4-a716-446655440001",
        amount: 100,
        valuation_basis: "manual_estimate",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown basis", () => {
    expect(
      valuationInputSchema.safeParse({
        bottle_id: "550e8400-e29b-41d4-a716-446655440000",
        amount: 100,
        valuation_basis: "vibes",
      }).success,
    ).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(
      valuationInputSchema.safeParse({
        bottle_id: "550e8400-e29b-41d4-a716-446655440000",
        amount: -5,
        valuation_basis: "manual_estimate",
      }).success,
    ).toBe(false);
  });
});

describe("wine definition input", () => {
  it("requires producer and name", () => {
    expect(wineDefinitionInputSchema.safeParse({ producer: "", name: "x" }).success).toBe(
      false,
    );
    expect(wineDefinitionInputSchema.safeParse({ producer: "x", name: "" }).success).toBe(
      false,
    );
  });

  it("allows a non-vintage wine", () => {
    const r = wineDefinitionInputSchema.safeParse({
      producer: "Krug",
      name: "Grande Cuvée",
      vintage: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an implausible vintage", () => {
    expect(
      wineDefinitionInputSchema.safeParse({ producer: "x", name: "y", vintage: 1500 })
        .success,
    ).toBe(false);
  });
});

describe("layout config dispatch", () => {
  it("validates each type against its own shape", () => {
    expect(() => parseLayoutConfig("grid", { rows: 5, columns: 5 })).not.toThrow();
    expect(() => parseLayoutConfig("shelving", { shelves: [10, 10] })).not.toThrow();
    expect(() => parseLayoutConfig("external", { merchant: "BBR" })).not.toThrow();
    expect(() => parseLayoutConfig("grid", { shelves: [10] })).toThrow();
    expect(() => parseLayoutConfig("nonsense", {})).toThrow();
  });
});

describe("numeric conversion at the boundary", () => {
  it("Postgres numerics arrive as strings", () => {
    expect(toNumber("450.00")).toBe(450);
    expect(toNumber(450)).toBe(450);
    expect(toNumber(null)).toBeNull();
    expect(toNumber("not a number")).toBeNull();
  });
});
