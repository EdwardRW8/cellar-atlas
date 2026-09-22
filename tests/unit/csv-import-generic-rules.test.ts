import { describe, it, expect } from "vitest";
import { parseCsv, COLUMNS } from "@/domain/csv-import/parse";
import {
  planImport,
  resolveLocation,
  type ExistingLocation,
} from "@/domain/csv-import/plan";
import { planAcquisitions } from "@/domain/csv-import/acquisitions";
import { applyImportIntegrityChecks } from "@/domain/csv-import/status";
import {
  mapValuationSource,
  mapValuationBasis,
  mapBottleSize,
  mapStatus,
} from "@/domain/csv-import/mappings";
import { buildTemplateCsv, FIELD_GUIDE } from "@/domain/csv-import/template";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * GENERIC IMPORT RULES
 *
 * The importer is built from the Cellar Atlas domain model outward; any one
 * person's spreadsheet is an acceptance case, never the specification.
 */

const loc = (id: string, name: string, isPositioned = false): ExistingLocation => ({
  id,
  name,
  isPositioned,
  occupiedKeys: new Set(),
  isValidKey: () => true,
});

async function plan(csv: string, locations: ExistingLocation[] = []) {
  const rows = applyImportIntegrityChecks(parseCsv(csv).rows);
  const p = await planImport({
    rows,
    attemptId: "a",
    fingerprint: "f".repeat(64),
    existingWines: [],
    locations,
    newId: () => crypto.randomUUID(),
    parsePositionKey: () => ({ col: 1, row: 1 }),
  });
  const groups = await planAcquisitions({
    plan: p,
    rows,
    attemptId: "a",
    fileFingerprint: "f".repeat(64),
  });
  return { rows, plan: p, groups };
}

const H =
  "Producer,Wine Name,Vintage,Wine Type,Quantity,Status,Storage Location,Storage Position";

describe("storage location: generic, tolerant, never guessed or invented", () => {
  const locs = [loc("L1", "Cellar"), loc("L2", "Garage Rack")];

  it("exact match", () => {
    expect(resolveLocation("Cellar", locs)).toEqual({ location: locs[0] });
  });
  it("whitespace is trimmed", () => {
    expect(resolveLocation("  Cellar  ", locs)).toEqual({ location: locs[0] });
  });
  it("a UNIQUE case-insensitive match is accepted", () => {
    expect(resolveLocation("cellar", locs)).toEqual({ location: locs[0] });
    expect(resolveLocation("GARAGE RACK", locs)).toEqual({ location: locs[1] });
  });
  it("exact beats case-insensitive when both exist", () => {
    const two = [loc("A", "cellar"), loc("B", "Cellar")];
    expect(resolveLocation("Cellar", two)).toEqual({ location: two[1] });
  });
  it("several case-insensitive matches → ambiguous, never guessed", () => {
    const two = [loc("A", "cellar"), loc("B", "CELLAR")];
    expect(resolveLocation("Cellar", two)).toEqual({ reason: "ambiguous-location" });
  });
  it("no match → unresolved, never invented", () => {
    expect(resolveLocation("Loft", locs)).toEqual({ reason: "no-such-location" });
  });

  it("a location WITHOUT a position still places the bottle there", async () => {
    const { plan: p } = await plan(
      [H, "E,W,2018,Red,2,In cellar,Cellar,"].join("\n"),
      locs,
    );
    expect(p.items[0]!.storageLocationId).toBe("L1");
    expect(p.items[0]!.positions).toEqual([null, null]);
  });
  it("a blank location → unlocated and unpositioned, with no warning", async () => {
    const { plan: p } = await plan([H, "E,W,2018,Red,1,In cellar,,"].join("\n"), locs);
    expect(p.items[0]!.storageLocationId).toBeNull();
    expect(p.positions).toEqual([]);
  });
  it("an unknown location is surfaced and needs acknowledgement", async () => {
    const { plan: p } = await plan([H, "E,W,2018,Red,1,In cellar,Loft,"].join("\n"), locs);
    expect(p.items[0]!.storageLocationId).toBeNull();
    expect(p.positions).toMatchObject([{ resolved: false, reason: "no-such-location" }]);
    expect(p.counts.unresolvedPositions).toBe(1);
  });
  it("a position is validated against the RESOLVED location's own layout", async () => {
    const positioned = [
      { ...loc("P", "Rack", true), isValidKey: (k: string) => k === "s1" },
    ];
    const good = await plan([H, "E,W,2018,Red,1,In cellar,rack,s1"].join("\n"), positioned);
    expect(good.plan.positions).toMatchObject([{ resolved: true }]);
    const bad = await plan([H, "E,W,2018,Red,1,In cellar,rack,zz"].join("\n"), positioned);
    expect(bad.plan.positions).toMatchObject([
      { resolved: false, reason: "invalid-for-layout" },
    ]);
  });
  it("an occupied position is never overwritten", async () => {
    const full = [{ ...loc("P", "Rack", true), occupiedKeys: new Set(["s1"]) }];
    const r = await plan([H, "E,W,2018,Red,1,In cellar,Rack,s1"].join("\n"), full);
    expect(r.plan.positions).toMatchObject([{ resolved: false, reason: "occupied" }]);
    expect(r.plan.items[0]!.positions).toEqual([null]);
  });
});

describe("status: generic rules", () => {
  it("case and spacing variants of a recognised status resolve canonically", () => {
    for (const v of ["In cellar", "In Cellar", "in cellar", "  IN CELLAR "]) {
      expect(mapStatus(v).value, v).toBe("in_cellar");
    }
    expect(mapStatus("Consumed").value).toBe("consumed");
    expect(mapStatus("consumed").value).toBe("consumed");
  });
  it("a BLANK status means In cellar — a CSV row brings a bottle IN", () => {
    expect(mapStatus("").value).toBe("in_cellar");
  });
  it("an unknown NONBLANK status blocks", () => {
    const [r] = parseCsv([H, "E,W,2018,Red,1,Maybe drunk,,"].join("\n")).rows;
    expect(r!.severity).toBe("invalid");
  });
  it("a case variant is NOT reported as a mapping", () => {
    const [r] = parseCsv([H, "E,W,2018,Red,1,In Cellar,,"].join("\n")).rows;
    expect(r!.issues.filter((i) => i.column === COLUMNS.status)).toEqual([]);
  });
  it("a SEMANTIC alias IS reported as a mapping", () => {
    const [r] = parseCsv([H, "E,W,2018,Red,1,drunk,,"].join("\n")).rows;
    expect(
      r!.issues.some((i) => /"drunk" will be recorded as "consumed"/.test(i.message)),
    ).toBe(true);
  });
});

describe("bottle size: blank is not the same as invalid", () => {
  it("blank uses the documented default", () => {
    expect(mapBottleSize("").value).toBe("750ml");
  });
  it("an INVALID size BLOCKS and names the supplied value", () => {
    const m = mapBottleSize("0");
    expect(m.value).toBeNull();
    expect(m.value === null && m.rejected.reason).toMatch(/"0"/);
  });
  it("an INVALID size is NEVER silently turned into 750ml", () => {
    const [r] = parseCsv(
      ["Producer,Wine Name,Wine Type,Quantity,Bottle Size ml", "E,W,Red,1,abc"].join("\n"),
    ).rows;
    expect(r!.severity).toBe("invalid");
  });
  it("an uncommon but legitimate size is accepted, e.g. 200", () => {
    expect(mapBottleSize("200").value).toBe("200ml");
  });
  it("every canonical size is accepted", () => {
    for (const ml of ["375", "750", "1500", "3000", "6000"])
      expect(mapBottleSize(ml).value).toBe(`${ml}ml`);
  });
});

describe("valuation source: a type or a reference, never forced", () => {
  it("a recognised type stays that type", () => {
    expect(mapValuationSource("merchant")).toEqual({ value: "merchant" });
    expect(mapValuationSource("Auction House").value).toBe("auction_house");
  });
  it("a URL is a REFERENCE, not a type", () => {
    const m = mapValuationSource("https://merchant.example/wine/123");
    expect(m.value).toBe("import");
    expect(m.value !== null && m.reference).toBe("https://merchant.example/wine/123");
  });
  it("a name or a sale is a REFERENCE too", () => {
    for (const v of ["A Wine Merchant", "An auction, June 2026", "Personal estimate"]) {
      const m = mapValuationSource(v);
      expect(m.value !== null && m.reference, v).toBe(v);
    }
  });
  it("blank is fine: a valuation needs no reference", () => {
    const m = mapValuationSource("");
    expect(m.value).toBe("import");
    expect(m.value !== null && m.reference).toBeUndefined();
  });
  it("the reference reaches the planned valuation, and the row still imports", async () => {
    const csv = [
      "Producer,Wine Name,Wine Type,Quantity,Current Valuation per Bottle,Valuation Currency,Valuation Basis,Valuation Source",
      "E,W,Red,1,90,GBP,market_estimate,https://merchant.example/x",
    ].join("\n");
    const { rows, plan: p } = await plan(csv);
    expect(rows[0]!.severity).not.toBe("invalid");
    expect(p.valuations[0]).toMatchObject({
      source: "import",
      reference: "https://merchant.example/x",
    });
  });
});

describe("valuation basis: canonical, plus explicit legacy aliases only", () => {
  it("canonical bases pass through", () => {
    for (const b of [
      "market_estimate",
      "merchant_retail",
      "auction_estimate",
      "realised_sale",
      "manual_estimate",
    ]) {
      expect(mapValuationBasis(b)).toEqual({ value: b });
    }
  });
  it("the two legacy phrases map explicitly — and say so", () => {
    expect(mapValuationBasis("Estimated current UK retail/market value")).toMatchObject({
      value: "market_estimate",
      alias: { to: "market_estimate" },
    });
    expect(mapValuationBasis("Current UK retail listing")).toMatchObject({
      value: "merchant_retail",
      alias: { to: "merchant_retail" },
    });
  });
  it("a legacy mapping is PREVIEWED on the row", () => {
    const csv = [
      "Producer,Wine Name,Wine Type,Quantity,Current Valuation per Bottle,Valuation Currency,Valuation Basis",
      "E,W,Red,1,90,GBP,Current UK retail listing",
    ].join("\n");
    const [r] = parseCsv(csv).rows;
    expect(
      r!.issues.some((i) => /will be recorded as "merchant_retail"/.test(i.message)),
    ).toBe(true);
  });
  it("an unknown basis is never guessed: the valuation is skipped", () => {
    const csv = [
      "Producer,Wine Name,Wine Type,Quantity,Current Valuation per Bottle,Valuation Currency,Valuation Basis",
      "E,W,Red,1,90,GBP,roughly what I reckon",
    ].join("\n");
    const [r] = parseCsv(csv).rows;
    expect(r!.valuation).toBeNull();
    expect(r!.severity).not.toBe("invalid");
  });
});

describe("the template teaches canonical values only", () => {
  const csv = buildTemplateCsv();
  it("never uses legacy wording", () => {
    for (const legacy of [
      "Sweet",
      "retail_price",
      "insurance_value",
      "Estimated current UK",
      "Current UK retail listing",
    ]) {
      expect(csv, legacy).not.toContain(legacy);
      expect(JSON.stringify(FIELD_GUIDE), legacy).not.toContain(legacy);
    }
  });
  it("teaches no particular storage layout", () => {
    expect(csv).not.toMatch(/c13r16/);
    expect(JSON.stringify(FIELD_GUIDE)).not.toMatch(/c13r16|staircase/i);
  });
});

describe("tastings: only when meaningful data is supplied", () => {
  it("blank tasting columns create no tasting", async () => {
    const { plan: p } = await plan([H, "E,W,2018,Red,1,In cellar,,"].join("\n"));
    expect(p.tastings).toEqual([]);
  });
});

describe("NO OVERFITTING: production code knows no particular cellar", () => {
  const files = [
    ...readdirSync("src/domain/csv-import").map((f) => join("src/domain/csv-import", f)),
    "src/features/import/ImportScreen.tsx",
  ];
  const code = (f: string) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("no producer, merchant, location, URL or row count from any one workbook", () => {
    for (const f of files) {
      for (const term of [
        /Pellar/i,
        /Icewine/i,
        /Wine Society/i,
        /\bBBR\b/,
        /Berry Bros/i,
        /2026-09-19/,
        /\b73\b/,
        /\b177\b/,
        /chatgpt/i,
        /c13r16/,
      ]) {
        expect(code(f), `${f} contains ${term}`).not.toMatch(term);
      }
    }
  });
});
