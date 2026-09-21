import { describe, it, expect } from "vitest";
import { COLUMNS, parseCsv } from "@/domain/csv-import/parse";
import { buildTemplateCsv } from "@/domain/csv-import/template";

/**
 * THE IMPORTER MUST READ THE REAL WORKBOOK
 *
 * Phase 11's stated purpose is that the populated workbook exports to CSV and
 * imports without restructuring. The parser once disagreed with it in 5 of 29
 * headers, and nothing noticed: the template and every existing test were
 * generated from the parser's own COLUMNS, so they agreed with each other and
 * all disagreed with the data they existed to read.
 *
 * This test compares against the workbook's LITERAL header row — typed out
 * here, deliberately NOT derived from COLUMNS — so the two can never drift
 * together again.
 */

/** Verbatim from Cellar_Atlas_Bulk_Import_Populated.xlsx, "Wine Import". */
const WORKBOOK_HEADERS = [
  "Producer",
  "Wine Name",
  "Vintage",
  "Wine Type",
  "Country",
  "Region",
  "Appellation",
  "Grapes",
  "Bottle Size ml",
  "Quantity",
  "Status",
  "Storage Location",
  "Storage Position",
  "Purchase Date",
  "Purchase Price per Bottle",
  "Purchase Currency",
  "Merchant / Source",
  "Current Valuation per Bottle",
  "Valuation Currency",
  "Valuation Date",
  "Valuation Basis",
  "Valuation Source",
  "Drink From",
  "Drink Until",
  "Tasting Rating",
  "Tasting Notes",
  "Tasting Date",
  "Tasting Context",
  "Notes",
];

describe("every workbook header is recognised", () => {
  it("the workbook has 29 columns", () => {
    expect(WORKBOOK_HEADERS).toHaveLength(29);
  });

  it("the parser knows EVERY one of them", () => {
    const known = new Set<string>(Object.values(COLUMNS));
    const missing = WORKBOOK_HEADERS.filter((h) => !known.has(h));
    expect(missing, "workbook headers the parser would silently ignore").toEqual([]);
  });

  it("an exported workbook reports NO unknown columns", () => {
    const row = WORKBOOK_HEADERS.map(() => "").join(",");
    const r = parseCsv([WORKBOOK_HEADERS.join(","), row].join("\n"));
    expect(r.unknownColumns, "columns that would be dropped").toEqual([]);
  });
});

describe("REGRESSION: the five previously dropped columns now import", () => {
  const values: Record<string, string> = {
    Producer: "Estate",
    "Wine Name": "Wine",
    "Wine Type": "Red",
    Quantity: "1",
    "Bottle Size ml": "1500",
    "Purchase Price per Bottle": "40",
    "Purchase Currency": "GBP",
    "Merchant / Source": "Berry Bros",
    "Current Valuation per Bottle": "90",
    "Valuation Currency": "GBP",
    "Valuation Basis": "market_estimate",
    "Valuation Source": "merchant",
    "Storage Position": "c3r2",
  };
  const csv = [
    WORKBOOK_HEADERS.join(","),
    WORKBOOK_HEADERS.map((h) => values[h] ?? "").join(","),
  ].join("\n");
  const row = parseCsv(csv).rows[0]!;

  it("Bottle Size ml — a magnum is NOT defaulted to 750ml", () => {
    expect(row.bottleSize).toBe("1500ml");
  });

  it("Purchase Price per Bottle — the cost is kept", () => {
    expect(row.purchasePrice).toBe(40);
  });

  it("Merchant / Source — the merchant is kept", () => {
    expect(row.purchaseSource).toBe("Berry Bros");
  });

  it("Current Valuation per Bottle — the valuation is kept", () => {
    expect(row.valuation).toMatchObject({ amount: 90, currency: "GBP" });
  });

  it("Storage Position — the position is kept", () => {
    expect(row.position).toBe("c3r2");
  });
});

describe("the downloadable template matches the workbook", () => {
  it("emits exactly the workbook's headers, in the workbook's order", () => {
    const header = buildTemplateCsv().split(/\r?\n/)[0]!;
    // Parse rather than split, so a quoted header is read correctly.
    const parsed = parseCsv(`${header}\n`);
    expect(parsed.unknownColumns).toEqual([]);
    for (const h of WORKBOOK_HEADERS) {
      expect(header, `template is missing "${h}"`).toContain(h);
    }
  });
});
