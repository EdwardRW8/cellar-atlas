/**
 * The Phase 11 acceptance CSV.
 *
 * Built from arrays of exactly 29 values rather than hand-typed text, so a
 * miscounted comma cannot silently shift every column. A unit test parses the
 * EXACT bytes this produces through the real importer, which means the live
 * spec's expectations are verified before it ever runs against a database.
 */

export const PHASE11_COLUMNS = [
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
] as const;

type Column = (typeof PHASE11_COLUMNS)[number];

/** RFC 4180 quoting: wrap when needed, double any embedded quote. */
function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function row(values: Partial<Record<Column, string>>): string {
  return PHASE11_COLUMNS.map((c) => quote(values[c] ?? "")).join(",");
}

export interface Phase11Fixture {
  csv: string;
  producers: { a: string; b: string; c: string; d: string };
}

/**
 * Three rows, each proving one thing.
 *
 *   A  active wine, quantity 2, cost, a SUPPORTED valuation, a tasting.
 *      An accent and an embedded comma prove UTF-8 and quoting survive.
 *   B  "Sweet" — must show Sweet → Dessert and be stored as Dessert.
 *   C  insurance_value — valuation SKIPPED, wine and bottle still imported.
 *   D  Consumed, quantity 2 — BOTH bottles created, then moved out of the
 *      cellar, each with an added → consumed history.
 *
 * Three acquisitions result, one per truthful purchase identity:
 *   A           2024-03-01 · Test Merchant  · EUR   (42.50 × 2)
 *   B           2023-09-12 · Other Merchant · GBP   (18.00 × 1)
 *   C + D       unknown    · unknown        · none  (no prices)
 * A's EUR purchase proves the GBP fallback is gone; A and B prove costs in
 * different currencies are never mixed; C + D prove unknowns stay unknown.
 *
 * `run` makes every producer unique, so no row can match an earlier run's
 * wine, and the file fingerprint differs on every run.
 */
export function buildPhase11Csv(run: string): Phase11Fixture {
  const producers = {
    a: `[E2E-TEST] ${run} Estate A`,
    b: `[E2E-TEST] ${run} Estate B`,
    c: `[E2E-TEST] ${run} Estate C`,
    d: `[E2E-TEST] ${run} Estate D`,
  };

  const lines = [
    PHASE11_COLUMNS.join(","),
    row({
      Producer: producers.a,
      "Wine Name": "Château Test, Grand Vin",
      Vintage: "2018",
      "Wine Type": "Red",
      Country: "France",
      Region: "Bordeaux",
      Grapes: "Merlot;Cabernet Franc",
      "Bottle Size ml": "750",
      Quantity: "2",
      Status: "In cellar",
      "Purchase Date": "2024-03-01",
      "Purchase Price per Bottle": "42.50",
      "Purchase Currency": "EUR",
      "Merchant / Source": "Test Merchant",
      "Current Valuation per Bottle": "75",
      "Valuation Currency": "GBP",
      "Valuation Date": "2025-01-15",
      "Valuation Basis": "market_estimate",
      "Valuation Source": "merchant",
      "Drink From": "2025",
      "Drink Until": "2035",
      "Tasting Rating": "4",
      "Tasting Notes": "Lovely structure",
      "Tasting Date": "2025-02-01",
      "Tasting Context": "With dinner",
      Notes: "E2E fixture row A",
    }),
    row({
      Producer: producers.b,
      "Wine Name": "Rosé Doux",
      Vintage: "2020",
      "Wine Type": "Sweet",
      Country: "France",
      "Bottle Size ml": "375",
      Quantity: "1",
      Status: "In cellar",
      // A DIFFERENT purchase: other date, other merchant, other currency.
      "Purchase Date": "2023-09-12",
      "Purchase Price per Bottle": "18.00",
      "Purchase Currency": "GBP",
      "Merchant / Source": "Other Merchant",
      Notes: "E2E fixture row B",
    }),
    row({
      Producer: producers.c,
      "Wine Name": "Insured Cuvée",
      Vintage: "2019",
      "Wine Type": "White",
      Country: "France",
      "Bottle Size ml": "750",
      Quantity: "1",
      Status: "In cellar",
      "Current Valuation per Bottle": "120",
      "Valuation Currency": "GBP",
      "Valuation Date": "2025-01-15",
      "Valuation Basis": "insurance_value",
      "Valuation Source": "manual",
      Notes: "E2E fixture row C",
    }),
    row({
      Producer: producers.d,
      "Wine Name": "Already Drunk",
      Vintage: "2015",
      "Wine Type": "Red",
      Country: "France",
      "Bottle Size ml": "750",
      Quantity: "2",
      Status: "Consumed",
      Notes: "E2E fixture row D",
    }),
  ];

  // CRLF, as Excel writes it.
  return { csv: lines.join("\r\n"), producers };
}
