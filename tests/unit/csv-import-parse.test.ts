import { describe, it, expect } from "vitest";
import { parseCsv, validateRow, COLUMNS } from "@/domain/csv-import/parse";
import {
  mapWineType,
  mapBottleSize,
  mapStatus,
  mapValuationBasis,
  mapValuationSource,
  mapCurrency,
  isRejected,
} from "@/domain/csv-import/mappings";

const HEADERS = [
  COLUMNS.producer,
  COLUMNS.wineName,
  COLUMNS.vintage,
  COLUMNS.wineType,
  COLUMNS.grapes,
  COLUMNS.bottleSize,
  COLUMNS.quantity,
  COLUMNS.purchasePrice,
  COLUMNS.purchaseCurrency,
  COLUMNS.currentValue,
  COLUMNS.valuationCurrency,
  COLUMNS.valuationBasis,
  COLUMNS.valuationSource,
  COLUMNS.status,
  COLUMNS.notes,
].join(",");

const csv = (...rows: string[]) => [HEADERS, ...rows].join("\n");

const row = (over: Record<string, string> = {}) =>
  validateRow(
    { producer: "P", wineName: "W", wineType: "Red", quantity: "1", ...over },
    2,
    {},
  );

// ═══════════════════════════════════════════════════════════════════════════
// PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe("parsing handles real wine data", () => {
  it("a QUOTED COMMA inside a producer name survives", () => {
    const r = parseCsv(
      csv('"Léoville-Barton, Grand Vin",Saint-Julien,2016,Red,,,1,,,,,,,,'),
    );
    expect(r.rows[0]!.producer).toBe("Léoville-Barton, Grand Vin");
  });

  it("accents and apostrophes survive", () => {
    const r = parseCsv(csv("Château d'Yquem,Sauternes,2011,Sweet,,,1,,,,,,,,"));
    expect(r.rows[0]!.producer).toBe("Château d'Yquem");
  });

  it("a BOM does not corrupt the first header", () => {
    const r = parseCsv("\uFEFF" + csv("P,W,2016,Red,,,1,,,,,,,,"));
    expect(r.fatalError).toBeNull();
    expect(r.rows[0]!.producer).toBe("P");
  });

  it("CRLF line endings parse", () => {
    const r = parseCsv(csv("P,W,2016,Red,,,1,,,,,,,,").replace(/\n/g, "\r\n"));
    expect(r.rows).toHaveLength(1);
  });

  it("an EMBEDDED NEWLINE in notes survives", () => {
    const r = parseCsv(csv('P,W,2016,Red,,,1,,,,,,,,"Line one\nLine two"'));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.notes).toContain("Line one");
  });

  it("semicolon-separated grapes split correctly", () => {
    const r = parseCsv(csv('P,W,2016,Red,"Cabernet Sauvignon; Merlot",,1,,,,,,,,'));
    expect(r.rows[0]!.grapes).toEqual(["Cabernet Sauvignon", "Merlot"]);
  });

  it("blank lines are skipped", () => {
    const r = parseCsv(csv("P,W,2016,Red,,,1,,,,,,,,", "", "P2,W2,2017,Red,,,1,,,,,,,,"));
    expect(r.rows).toHaveLength(2);
  });

  it("line numbers match what a spreadsheet shows", () => {
    const r = parseCsv(csv("P,W,2016,Red,,,1,,,,,,,,", "P2,W2,2017,Red,,,1,,,,,,,,"));
    expect(r.rows.map((x) => x.lineNumber)).toEqual([2, 3]);
  });
});

describe("malformed input fails safely", () => {
  it("an empty file reports a fatal error", () => {
    expect(parseCsv("").fatalError).toMatch(/empty/i);
  });

  it("no headers reports a fatal error", () => {
    expect(parseCsv("\n\n").fatalError).toBeTruthy();
  });

  it("MISSING REQUIRED COLUMNS blocks the whole file", () => {
    const r = parseCsv("Producer,Wine Name\nP,W");
    expect(r.fatalError).toMatch(/missing required columns/i);
    expect(r.missingRequiredColumns).toContain(COLUMNS.wineType);
  });

  it("unknown columns are reported, not fatal", () => {
    const r = parseCsv(`${HEADERS},Cellar Tracker ID\nP,W,2016,Red,,,1,,,,,,,,,xyz`);
    expect(r.fatalError).toBeNull();
    expect(r.unknownColumns).toContain("Cellar Tracker ID");
  });

  it("headers match case- and space-insensitively", () => {
    const r = parseCsv("producer,WINE NAME,  Wine Type ,Quantity\nP,W,Red,1");
    expect(r.fatalError).toBeNull();
    expect(r.rows[0]!.producer).toBe("P");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MAPPINGS — CHECKED AGAINST THE REAL CONSTRAINTS
// ═══════════════════════════════════════════════════════════════════════════

describe("wine type respects the mandatory-type work", () => {
  it('"Sweet" maps to Dessert, and says so', () => {
    const m = mapWineType("Sweet");
    expect(m.value).toBe("Dessert");
    expect(m.alias).toMatchObject({ from: "Sweet", to: "Dessert" });
  });

  it("a canonical value carries NO alias", () => {
    expect(mapWineType("Red").alias).toBeUndefined();
  });

  it("Rosé is accepted with or without the accent", () => {
    expect(mapWineType("Rosé").value).toBe("Rosé");
    expect(mapWineType("Rose").value).toBe("Rosé");
  });

  it("a missing type is REJECTED, never defaulted", () => {
    const m = mapWineType("");
    expect(isRejected(m)).toBe(true);
  });

  it("an unknown type is rejected with the accepted list", () => {
    const m = mapWineType("Orange");
    expect(isRejected(m)).toBe(true);
    expect((m as { rejected: { reason: string } }).rejected.reason).toMatch(/Dessert/);
  });
});

describe("valuation basis and source", () => {
  it('"retail_price" maps to merchant_retail', () => {
    expect(mapValuationBasis("retail_price").value).toBe("merchant_retail");
  });

  it('"insurance_value" is REJECTED, not bent to manual_estimate', () => {
    const m = mapValuationBasis("insurance_value");
    expect(isRejected(m)).toBe(true);
    expect((m as { rejected: { reason: string } }).rejected.reason).toMatch(
      /not a basis Cellar Atlas can record truthfully/i,
    );
  });

  it('"retailer" maps to merchant — provenance preserved', () => {
    expect(mapValuationSource("retailer").value).toBe("merchant");
  });

  it('"insurance" is kept as a REFERENCE, never forced into the type enum', () => {
    const m = mapValuationSource("insurance");
    expect(m.value).toBe("import");
    expect(m.value === null ? null : m.reference).toBe("insurance");
    expect(m.alias?.note).toMatch(/not a source type/i);
  });

  it("a merchant source stays merchant — not rewritten to import", () => {
    const m = mapValuationSource("merchant");
    expect(m.value).toBe("merchant");
    expect(m.alias).toBeUndefined();
  });
});

describe("bottle size, status and currency", () => {
  it("millilitres map to the stored label", () => {
    expect(mapBottleSize("750").value).toBe("750ml");
    expect(mapBottleSize("1500").value).toBe("1500ml");
  });

  it("an unsupported size is rejected", () => {
    expect(isRejected(mapBottleSize("500"))).toBe(true);
  });

  it('"In cellar" maps to in_cellar', () => {
    expect(mapStatus("In cellar").value).toBe("in_cellar");
  });

  it("currency must be three letters and is never invented", () => {
    expect(mapCurrency("gbp").value).toBe("GBP");
    expect(isRejected(mapCurrency(""))).toBe(true);
    expect(isRejected(mapCurrency("pounds"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROW VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe("required fields", () => {
  it("a complete row is valid", () => {
    expect(row().severity).toBe("valid");
  });

  it("a missing producer is invalid", () => {
    expect(row({ producer: "" }).severity).toBe("invalid");
  });

  it("a missing wine type is invalid", () => {
    expect(row({ wineType: "" }).severity).toBe("invalid");
  });

  it("quantity must be a whole number of at least one", () => {
    expect(row({ quantity: "0" }).severity).toBe("invalid");
    expect(row({ quantity: "2.5" }).severity).toBe("invalid");
    expect(row({ quantity: "" }).severity).toBe("invalid");
  });

  it("an implausible quantity is caught", () => {
    expect(row({ quantity: "5000" }).severity).toBe("invalid");
  });
});

describe("absence is never zero", () => {
  it("a blank purchase price stays NULL", () => {
    expect(row({ purchasePrice: "" }).purchasePrice).toBeNull();
  });

  it("a PRICE WITHOUT A CURRENCY is invalid — never defaulted", () => {
    const r = row({ purchasePrice: "50", purchaseCurrency: "" });
    expect(r.severity).toBe("invalid");
    expect(r.issues.some((i) => /never assumed/i.test(i.message))).toBe(true);
  });

  it("a currency with no price warns and leaves cost unknown", () => {
    const r = row({ purchaseCurrency: "GBP" });
    expect(r.severity).toBe("warning");
    expect(r.purchasePrice).toBeNull();
  });

  it("a blank valuation stays null", () => {
    expect(row().valuation).toBeNull();
  });

  it("a VALUATION WITHOUT A CURRENCY is invalid", () => {
    expect(row({ currentValue: "95", valuationCurrency: "" }).severity).toBe("invalid");
  });

  it("an insurance_value valuation is SKIPPED but the wine still imports", () => {
    const r = row({
      currentValue: "95",
      valuationCurrency: "GBP",
      valuationBasis: "insurance_value",
      valuationSource: "manual",
    });
    expect(r.severity).toBe("warning");
    expect(r.valuation).toBeNull();
    expect(r.quantity).toBe(1);
  });

  it("a complete valuation is captured with its date", () => {
    const r = row({
      currentValue: "95",
      valuationCurrency: "GBP",
      valuationBasis: "market_estimate",
      valuationSource: "merchant",
    });
    expect(r.valuation).toMatchObject({
      amount: 95,
      currency: "GBP",
      basis: "market_estimate",
    });
  });
});

describe("dates and windows", () => {
  it("accepts ISO dates", () => {
    expect(row({ purchasePrice: "1", purchaseCurrency: "GBP" }).severity).not.toBe(
      "invalid",
    );
  });

  it("rejects a non-ISO date", () => {
    const r = validateRow(
      {
        producer: "P",
        wineName: "W",
        wineType: "Red",
        quantity: "1",
        purchaseDate: "03/11/2019",
      },
      2,
      {},
    );
    expect(r.severity).toBe("invalid");
  });

  it("rejects an impossible date", () => {
    const r = validateRow(
      {
        producer: "P",
        wineName: "W",
        wineType: "Red",
        quantity: "1",
        purchaseDate: "2019-02-31",
      },
      2,
      {},
    );
    expect(r.severity).toBe("invalid");
  });

  it("rejects an inverted drinking window", () => {
    expect(row({ drinkFrom: "2040", drinkUntil: "2020" }).severity).toBe("invalid");
  });

  it("accepts an open-ended window", () => {
    expect(row({ drinkFrom: "2030" }).severity).toBe("valid");
  });

  it("rejects an implausible vintage", () => {
    expect(row({ vintage: "1500" }).severity).toBe("invalid");
    expect(row({ vintage: "3000" }).severity).toBe("invalid");
  });

  it("allows a blank vintage for non-vintage wine", () => {
    const r = row({ vintage: "" });
    expect(r.severity).toBe("valid");
    expect(r.vintage).toBeNull();
  });
});

describe("status and tasting", () => {
  it("a consumed row warns that history shows both events", () => {
    const r = row({ status: "Consumed" });
    expect(r.severity).toBe("warning");
    expect(r.status).toBe("consumed");
  });

  it("a tasting on a multi-bottle row warns it is per wine", () => {
    const r = row({ quantity: "6", tastingRating: "4" });
    expect(r.issues.some((i) => /not once per bottle/i.test(i.message))).toBe(true);
  });

  it("a rating outside 1-5 is invalid", () => {
    expect(row({ tastingRating: "9" }).severity).toBe("invalid");
  });

  it("tasting notes alone still create a tasting", () => {
    const r = row({ tastingNotes: "Lovely" });
    expect(r.tasting).toMatchObject({ notes: "Lovely", rating: null });
  });
});

describe("storage warnings", () => {
  it("a position with no location warns", () => {
    const r = row({ position: "c13r16" });
    expect(r.severity).toBe("warning");
  });

  it("one position for many bottles warns that the rest are unpositioned", () => {
    const r = row({ quantity: "6", storageLocation: "Cellar", position: "c1r1" });
    expect(r.issues.some((i) => /the rest are unpositioned/i.test(i.message))).toBe(true);
  });
});
