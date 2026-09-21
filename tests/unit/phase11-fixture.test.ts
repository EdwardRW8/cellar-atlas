import { describe, it, expect } from "vitest";
import { parseCsv } from "@/domain/csv-import/parse";
import { buildPhase11Csv, PHASE11_COLUMNS } from "../e2e/fixtures/phase11-csv";

/**
 * The live acceptance spec asserts specific counts and messages. This proves
 * those expectations hold for the EXACT CSV it uploads — through the real
 * parser — before the spec ever touches a database.
 */

const { csv, producers } = buildPhase11Csv("P11-unit");
const parsed = parseCsv(csv);
const [a, b, c, d] = parsed.rows;

describe("the fixture itself is well-formed", () => {
  it("has exactly the workbook's 29 columns", () => {
    expect(PHASE11_COLUMNS).toHaveLength(29);
  });

  it("parses with no fatal error and no unknown columns", () => {
    expect(parsed.fatalError).toBeNull();
    expect(parsed.unknownColumns).toEqual([]);
  });

  it("yields exactly four rows", () => {
    expect(parsed.rows).toHaveLength(4);
  });

  it("no row is invalid, so nothing blocks the import", () => {
    expect(parsed.rows.every((r) => r.severity !== "invalid")).toBe(true);
  });
});

describe("row A — normal active wine", () => {
  it("survives UTF-8 and an embedded comma intact", () => {
    expect(a!.producer).toBe(producers.a);
    expect(a!.wineName).toBe("Château Test, Grand Vin");
  });

  it("carries quantity 2, cost and currency", () => {
    expect(a!.wineType).toBe("Red");
    expect(a!.quantity).toBe(2);
    expect(a!.purchasePrice).toBe(42.5);
    // EUR on purpose: the live spec checks the acquisition keeps it.
    expect(a!.purchaseCurrency).toBe("EUR");
  });

  it("carries a SUPPORTED valuation with its provenance", () => {
    expect(a!.valuation).toMatchObject({
      amount: 75,
      currency: "GBP",
      basis: "market_estimate",
      source: "merchant",
      valuedOn: "2025-01-15",
    });
  });

  it("carries a tasting", () => {
    expect(a!.tasting).toMatchObject({
      rating: 4,
      notes: "Lovely structure",
      tastedOn: "2025-02-01",
      context: "With dinner",
    });
  });

  it("splits grapes on semicolons", () => {
    expect(a!.grapes).toEqual(["Merlot", "Cabernet Franc"]);
  });
});

describe("row B — the Sweet alias", () => {
  it("maps Sweet to the canonical Dessert", () => {
    expect(b!.wineType).toBe("Dessert");
  });

  it("SAYS so, in exactly the words the live spec looks for", () => {
    expect(
      b!.issues.some((i) => /"Sweet" will be recorded as "Dessert"/.test(i.message)),
    ).toBe(true);
  });

  it("is a warning, so confirmation requires acknowledgement", () => {
    expect(b!.severity).toBe("warning");
  });

  it("has no tasting, so none may be created", () => {
    expect(b!.tasting).toBeNull();
  });

  it("maps 375 to the canonical 375ml", () => {
    expect(b!.bottleSize).toBe("375ml");
  });
});

describe("row C — the unsupported insurance valuation", () => {
  it("imports the wine and bottle", () => {
    expect(c!.severity).not.toBe("invalid");
    expect(c!.quantity).toBe(1);
  });

  it("does NOT carry the valuation forward", () => {
    expect(c!.valuation).toBeNull();
  });

  it("SAYS the valuation will be skipped, as the live spec expects", () => {
    expect(c!.issues.some((i) => /The valuation will be skipped/.test(i.message))).toBe(
      true,
    );
  });
});

describe("the totals the live spec asserts", () => {
  it("6 bottles in total", () => {
    expect(parsed.rows.reduce((n, r) => n + r.quantity, 0)).toBe(6);
  });

  it("2 of them leave the cellar", () => {
    expect(
      parsed.rows
        .filter((r) => r.status !== "in_cellar")
        .reduce((n, r) => n + r.quantity, 0),
    ).toBe(2);
  });

  it("exactly one valuation will be recorded", () => {
    expect(parsed.rows.filter((r) => r.valuation !== null)).toHaveLength(1);
  });

  it("exactly one tasting will be recorded", () => {
    expect(parsed.rows.filter((r) => r.tasting !== null)).toHaveLength(1);
  });

  it("every run is unique, so nothing matches a previous run", () => {
    const x = buildPhase11Csv("run-1");
    const y = buildPhase11Csv("run-2");
    expect(x.csv).not.toBe(y.csv);
    expect(x.producers.a).not.toBe(y.producers.a);
  });
});

describe("row D — consumed, quantity 2", () => {
  it("is Consumed with quantity 2", () => {
    expect(d!.status).toBe("consumed");
    expect(d!.quantity).toBe(2);
  });

  it("is not blocked", () => {
    expect(d!.severity).not.toBe("invalid");
  });
});

describe("the fixture passes the pre-write integrity checks", () => {
  it("no status conflict", async () => {
    const { applyImportIntegrityChecks } = await import("@/domain/csv-import/status");
    expect(
      applyImportIntegrityChecks(parsed.rows).every((r) => r.severity !== "invalid"),
    ).toBe(true);
  });

  it("forms THREE acquisition groups: EUR, GBP, and unknown provenance", async () => {
    const { groupKeyOf, identityOf } = await import("@/domain/csv-import/acquisitions");
    expect(new Set(parsed.rows.map(groupKeyOf)).size).toBe(3);
    const currencies = parsed.rows.map((r) => identityOf(r).currency);
    expect(currencies).toContain("EUR");
    expect(currencies).toContain("GBP");
  });
});
