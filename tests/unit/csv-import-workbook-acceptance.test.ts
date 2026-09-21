import { describe, it, expect, beforeAll } from "vitest";
import { parseCsv, COLUMNS } from "@/domain/csv-import/parse";
import {
  planImport,
  canConfirm,
  type ExistingLocation,
  type ImportPlan,
} from "@/domain/csv-import/plan";
import {
  planAcquisitions,
  summariseAcquisitions,
  type PlannedAcquisition,
} from "@/domain/csv-import/acquisitions";
import { applyImportIntegrityChecks } from "@/domain/csv-import/status";
import type { ParsedRow } from "@/domain/csv-import/parse";

/**
 * ACCEPTANCE FIXTURE — the shape of one real populated workbook.
 *
 * The real file was not available, so this reconstructs it from its known
 * characteristics. It is a TEST FIXTURE: every name below lives here and
 * nowhere in production code. The importer is generic; this proves the generic
 * rules produce the right outcome for one real-world case.
 *
 *   73 rows · 177 bottles · 73 valuations · 0 tastings · 0 consumed/removed
 *   purchase date, price, currency and merchant: blank on every row
 *   valuations: GBP, dated 2026-09-19, source a URL
 *   basis: 54 × "Estimated current UK retail/market value"
 *          19 × "Current UK retail listing"
 *   status: 59 recognised in-cellar (mixed case) · 14 blank
 *   storage: 57 Cellar · 7 The Wine Society · 5 BBR · 2 cellar · 2 blank
 *   sizes: 66 × 750 · 2 × 1500 · 2 × 375 · 2 × 3000 · 1 × 200
 */

const HEADERS = Object.values(COLUMNS);
// The 200ml row sits on an ordinary "In cellar" / "Cellar" row, so that the
// blank-status and blank-storage groups are not disturbed by excluding it.
// (The real row's status and storage were not supplied; this is a fixture
// choice, stated rather than hidden.)
const PELLAR = 0;

function workbookCsv(): string {
  const sizes = [
    "200",
    ...Array(66).fill("750"),
    "1500",
    "1500",
    "375",
    "375",
    "3000",
    "3000",
  ];
  const bases = [
    ...Array(54).fill("Estimated current UK retail/market value"),
    ...Array(19).fill("Current UK retail listing"),
  ];
  const statuses = [
    ...Array(50).fill("In cellar"),
    ...Array(5).fill("In Cellar"),
    ...Array(4).fill("in cellar"),
    ...Array(14).fill(""),
  ];
  const storage = [
    ...Array(57).fill("Cellar"),
    ...Array(7).fill("The Wine Society"),
    ...Array(5).fill("BBR"),
    "cellar",
    "cellar",
    "",
    "",
  ];

  const lines = [HEADERS.join(",")];
  for (let i = 0; i < 73; i++) {
    const v: Record<string, string> = {
      [COLUMNS.producer]: i === PELLAR ? "Pellar Estates" : `Producer ${i}`,
      [COLUMNS.wineName]: i === PELLAR ? "Icewine Cabernet Franc" : `Wine ${i}`,
      [COLUMNS.vintage]: i === PELLAR ? "2018" : String(2000 + (i % 20)),
      [COLUMNS.wineType]: i === PELLAR ? "Sweet" : "Red",
      [COLUMNS.bottleSize]: sizes[i]!,
      // 31 × 3 + 42 × 2 = 177
      [COLUMNS.quantity]: i < 31 ? "3" : "2",
      [COLUMNS.status]: statuses[i]!,
      [COLUMNS.storageLocation]: storage[i]!,
      [COLUMNS.currentValue]: String(20 + i),
      [COLUMNS.valuationCurrency]: "GBP",
      [COLUMNS.valuationDate]: "2026-09-19",
      [COLUMNS.valuationBasis]: bases[i]!,
      [COLUMNS.valuationSource]: `https://merchant.example/wine/${i}`,
    };
    lines.push(
      HEADERS.map((h) => {
        const s = v[h] ?? "";
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","),
    );
  }
  return lines.join("\r\n");
}

const LOCATIONS: ExistingLocation[] = [
  {
    id: "cellar",
    name: "Cellar",
    isPositioned: true,
    occupiedKeys: new Set(),
    isValidKey: () => true,
  },
  {
    id: "tws",
    name: "The Wine Society",
    isPositioned: false,
    occupiedKeys: new Set(),
    isValidKey: () => false,
  },
  {
    id: "bbr",
    name: "BBR",
    isPositioned: false,
    occupiedKeys: new Set(),
    isValidKey: () => false,
  },
];

let rows: ParsedRow[];
let plan: ImportPlan;
let groups: PlannedAcquisition[];

beforeAll(async () => {
  const parsed = parseCsv(workbookCsv());
  expect(parsed.fatalError).toBeNull();
  rows = applyImportIntegrityChecks(parsed.rows);
  plan = await planImport({
    rows,
    attemptId: "wb",
    fingerprint: "e".repeat(64),
    existingWines: [],
    locations: LOCATIONS,
    newId: () => crypto.randomUUID(),
    parsePositionKey: () => null,
  });
  groups = await planAcquisitions({
    plan,
    rows,
    attemptId: "wb",
    fileFingerprint: "e".repeat(64),
  });
});

describe("the workbook is read in full", () => {
  it("73 rows, 177 bottles supplied", () => {
    expect(rows).toHaveLength(73);
    expect(rows.reduce((n, r) => n + r.quantity, 0)).toBe(177);
  });
  it("no unknown columns", () => {
    expect(parseCsv(workbookCsv()).unknownColumns).toEqual([]);
  });
});

describe("THE 200ml ROW BLOCKS the import — deliberately", () => {
  const invalid = () => rows.filter((r) => r.severity === "invalid");

  it("exactly ONE blocking row", () => {
    expect(invalid()).toHaveLength(1);
  });
  it("it is the 200ml row, and the message names the value", () => {
    const [r] = invalid();
    expect(r!.producer).toBe("Pellar Estates");
    expect(r!.issues.some((i) => /"200"/.test(i.message))).toBe(true);
  });
  it("it is NOT silently converted to 750ml", () => {
    expect(invalid()[0]!.issues.some((i) => i.column === COLUMNS.bottleSize)).toBe(true);
  });
  it("confirmation is refused until it is resolved", () => {
    expect(canConfirm(plan)).toBe(false);
  });
});

describe("the 72 importable rows", () => {
  const ok = () => rows.filter((r) => r.severity !== "invalid");

  it("create 174 bottles (177 less the blocked row's 3)", () => {
    expect(plan.counts.bottlesToCreate).toBe(174);
  });
  it("carry 72 valuations, every basis canonical", () => {
    expect(plan.valuations).toHaveLength(72);
    const bases = new Set(plan.valuations.map((v) => v.basis));
    expect([...bases].sort()).toEqual(["market_estimate", "merchant_retail"]);
  });
  it("keep 54/19 legacy wording mapped explicitly, not dropped", () => {
    const m = plan.valuations.filter((v) => v.basis === "market_estimate").length;
    const r = plan.valuations.filter((v) => v.basis === "merchant_retail").length;
    // the blocked 200ml row carried the first, "Estimated…" basis
    expect([m, r]).toEqual([53, 19]);
  });
  it("keep every URL as a REFERENCE, never as a source type", () => {
    for (const v of plan.valuations) {
      expect(v.source).toBe("import");
      expect(v.reference).toMatch(/^https:\/\/merchant\.example\/wine\/\d+$/);
    }
  });
  it("keep currency GBP and the stated valuation date", () => {
    expect(
      plan.valuations.every((v) => v.currency === "GBP" && v.valuedOn === "2026-09-19"),
    ).toBe(true);
  });
  it("create ZERO tastings and ZERO status changes", () => {
    expect(plan.tastings).toEqual([]);
    expect(plan.statusChanges).toEqual([]);
  });
  it("treat the 14 blank statuses as In cellar", () => {
    const blank = ok().filter((r) => !(r.raw[COLUMNS.status] ?? "").trim());
    expect(blank).toHaveLength(14);
    expect(blank.every((r) => r.status === "in_cellar")).toBe(true);
  });
  it("resolve every case variant of In cellar canonically", () => {
    expect(ok().every((r) => r.status === "in_cellar")).toBe(true);
  });
});

describe("storage: generic matching gives the right result", () => {
  const where = (id: string | null) =>
    plan.items.filter((i) => i.storageLocationId === id).length;
  it("Cellar + cellar resolve to the same location (56 + 2)", () => {
    expect(where("cellar")).toBe(58);
  });
  it("The Wine Society and BBR resolve", () => {
    expect(where("tws")).toBe(7);
    expect(where("bbr")).toBe(5);
  });
  it("the 2 blank rows are unlocated", () => {
    expect(where(null)).toBe(2);
  });
  it("nothing is positioned and nothing is unresolved", () => {
    expect(plan.items.every((i) => i.positions.every((p) => p === null))).toBe(true);
    expect(plan.counts.unresolvedPositions).toBe(0);
  });
});

describe("NO PURCHASE HISTORY IS FABRICATED", () => {
  it("every row forms ONE unknown-provenance acquisition, not 72", () => {
    expect(groups).toHaveLength(1);
    expect(groups[0]!.identity).toEqual({
      purchasedOn: null,
      merchant: null,
      currency: null,
    });
  });
  it("no cost exists in ANY currency", () => {
    const s = summariseAcquisitions(groups, rows);
    expect(s.costByCurrency).toEqual([]);
    expect(groups[0]!.cost).toBeNull();
  });
  it("every price stays unknown, never zero", () => {
    expect(plan.items.every((i) => i.unitPrice === null)).toBe(true);
  });
  it("the preview counts every row's missing purchase facts", () => {
    const s = summariseAcquisitions(groups, rows);
    expect(s.rowsWithUnknownDate).toBe(72);
    expect(s.rowsWithUnknownMerchant).toBe(72);
    expect(s.rowsWithUnknownPrice).toBe(72);
  });
});
