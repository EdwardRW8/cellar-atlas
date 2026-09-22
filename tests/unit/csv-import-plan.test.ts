// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  planImport,
  wineKey,
  canConfirm,
  fingerprintCsv,
  stableOperationId,
  type ExistingLocation,
} from "@/domain/csv-import/plan";
import { validateRow } from "@/domain/csv-import/parse";
import { buildTemplateCsv, escapeCsvValue } from "@/domain/csv-import/template";
import { parseCsv } from "@/domain/csv-import/parse";

let counter = 0;
const newId = () => `wine-${++counter}`;

function row(over: Record<string, string> = {}, line = 2) {
  return validateRow(
    { producer: "P", wineName: "W", wineType: "Red", quantity: "1", ...over },
    line,
    {},
  );
}

function location(over: Partial<ExistingLocation> = {}): ExistingLocation {
  return {
    id: "loc1",
    name: "Cellar",
    isPositioned: true,
    occupiedKeys: new Set<string>(),
    isValidKey: (k) => /^c\d+r\d+$/.test(k),
    ...over,
  };
}

const plan = (rows: ReturnType<typeof row>[], over: Record<string, unknown> = {}) =>
  planImport({
    rows,
    attemptId: "attempt-1",
    fingerprint: "fp",
    existingWines: [],
    geography: new Map(),
    locations: [],
    newId,
    parsePositionKey: (_l, key) => {
      const m = /^c(\d+)r(\d+)$/.exec(key);
      return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
    },
    ...over,
  });

// ═══════════════════════════════════════════════════════════════════════════
// DEDUPLICATION — THE DATABASE'S OWN RULE
// ═══════════════════════════════════════════════════════════════════════════

describe("wine identity matches the unique index", () => {
  it("is case-insensitive on producer and name", () => {
    expect(wineKey("Château X", "Grand Vin", 2016)).toBe(
      wineKey("château x", "GRAND VIN", 2016),
    );
  });

  it("treats a missing vintage as the index does", () => {
    // coalesce(vintage, -1): two NV wines of one name ARE the same wine.
    expect(wineKey("P", "W", null)).toBe(wineKey("P", "W", null));
    expect(wineKey("P", "W", null)).not.toBe(wineKey("P", "W", 2016));
  });

  it("different vintages are different wines", () => {
    expect(wineKey("P", "W", 2015)).not.toBe(wineKey("P", "W", 2016));
  });
});

describe("deduplication", () => {
  it("TWO ROWS of the same wine create ONE definition", async () => {
    const p = await plan([row({ quantity: "6" }, 2), row({ quantity: "6" }, 3)]);
    expect(p.counts.winesToCreate).toBe(1);
    expect(p.counts.bottlesToCreate).toBe(12);
    expect(p.winesToCreate[0]!.lineNumbers).toEqual([2, 3]);
  });

  it("REUSES an existing wine rather than duplicating it", async () => {
    const p = await plan([row()], {
      existingWines: [{ id: "existing", producer: "P", name: "W", vintage: null }],
    });
    expect(p.counts.winesToCreate).toBe(0);
    expect(p.counts.winesReused).toBe(1);
    expect(p.winesReused[0]!.id).toBe("existing");
  });

  it("matches an existing wine case-insensitively", async () => {
    const p = await plan([row({ producer: "château x", wineName: "grand vin" })], {
      existingWines: [{ id: "e", producer: "Château X", name: "Grand Vin", vintage: null }],
    });
    expect(p.counts.winesReused).toBe(1);
  });

  it("SURFACES a near match rather than guessing", async () => {
    const p = await plan([row({ vintage: "2016" })], {
      existingWines: [{ id: "e", producer: "P", name: "W", vintage: 2015 }],
    });
    expect(p.counts.winesToCreate).toBe(1);
    expect(p.ambiguous).toHaveLength(1);
    expect(p.ambiguous[0]!.candidates[0]).toMatch(/2015/);
  });

  it("does not flag an exact match as ambiguous", async () => {
    const p = await plan([row()], {
      existingWines: [{ id: "e", producer: "P", name: "W", vintage: null }],
    });
    expect(p.ambiguous).toEqual([]);
  });
});
describe("geography resolution", () => {
  it("resolves a canonical region supplied as a CSV appellation", async () => {
    const geography = new Map([
      [
        "napa-id",
        {
          id: "napa-id",
          parent_id: "us-id",
          level: "region",
          name: "Napa Valley",
          country_code: "US",
        },
      ],
      [
        "us-id",
        {
          id: "us-id",
          parent_id: null,
          level: "country",
          name: "United States",
          country_code: "US",
        },
      ],
    ]);

    const p = await plan(
      [
        row({
          producer: "Duckhorn",
          wineName: "Chardonnay",
          country: "USA",
          region: "California",
          appellation: "Napa Valley",
        }),
      ],
      { geography },
    );

    expect(p.winesToCreate).toHaveLength(1);
    expect(p.winesToCreate[0]!.wine.geo_region_id).toBe("napa-id");
    expect(p.winesToCreate[0]!.wine.country_code).toBe("US");
    expect(p.winesToCreate[0]!.wine.region_text).toBeNull();
  });
  it("resolves Mount Veeder to canonical Mt. Veeder", async () => {
    const geography = new Map([
      [
        "mt-veeder-id",
        {
          id: "mt-veeder-id",
          parent_id: "napa-id",
          level: "appellation",
          name: "Mt. Veeder",
          country_code: "US",
        },
      ],
    ]);

    const p = await plan(
      [
        row({
          country: "USA",
          region: "California",
          appellation: "Mount Veeder",
        }),
      ],
      { geography },
    );

    expect(p.winesToCreate[0]!.wine.geo_region_id).toBe("mt-veeder-id");
    expect(p.winesToCreate[0]!.wine.country_code).toBe("US");
    expect(p.winesToCreate[0]!.wine.region_text).toBeNull();
  });

  it("resolves Sonoma County to canonical Sonoma", async () => {
    const geography = new Map([
      [
        "sonoma-id",
        {
          id: "sonoma-id",
          parent_id: "california-id",
          level: "region",
          name: "Sonoma",
          country_code: "US",
        },
      ],
    ]);

    const p = await plan(
      [
        row({
          country: "USA",
          region: "California",
          appellation: "Sonoma County",
        }),
      ],
      { geography },
    );

    expect(p.winesToCreate[0]!.wine.geo_region_id).toBe("sonoma-id");
    expect(p.winesToCreate[0]!.wine.country_code).toBe("US");
    expect(p.winesToCreate[0]!.wine.region_text).toBeNull();
  });

});
// ═══════════════════════════════════════════════════════════════════════════
// BOTTLE-PER-ROW
// ═══════════════════════════════════════════════════════════════════════════

describe("quantity becomes bottle rows, never an inventory count", () => {
  it("6 bottles means 6 rows", async () => {
    const p = await plan([row({ quantity: "6" })]);
    expect(p.counts.bottlesToCreate).toBe(6);
    expect(p.items[0]!.positions).toHaveLength(6);
  });

  it("totals across rows", async () => {
    const p = await plan([
      row({ quantity: "6" }, 2),
      row({ producer: "Q", quantity: "3" }, 3),
    ]);
    expect(p.counts.bottlesToCreate).toBe(9);
  });

  it("the plan no longer models one acquisition per import", async () => {
    // REVERSED DECISION: acquisitions are grouped per purchase by
    // planAcquisitions(). The single-acquisition fields were dead code and
    // are gone, so nothing can quietly depend on them.
    const p = await plan([row({ quantity: "6" }, 2), row({ producer: "Q" }, 3)]);
    expect("acquisitions" in p.counts).toBe(false);
    expect("acquisitionOperationId" in p).toBe(false);
  });

  it("a missing price stays null on the item", async () => {
    const p = await plan([row()]);
    expect(p.items[0]!.unitPrice).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STABLE OPERATION IDS
// ═══════════════════════════════════════════════════════════════════════════

describe("operation ids are stable within an attempt", () => {
  it("the SAME attempt produces the SAME ids — replay is harmless", async () => {
    const rows = [
      row({
        currentValue: "95",
        valuationCurrency: "GBP",
        valuationBasis: "market_estimate",
        valuationSource: "manual",
      }),
    ];
    counter = 0;
    const a = await plan(rows);
    counter = 0;
    const b = await plan(rows);

    expect(a.winesToCreate[0]!.operationId, "id must exist").toMatch(/^[0-9a-f-]{36}$/);
    expect(b.winesToCreate[0]!.operationId).toBe(a.winesToCreate[0]!.operationId);
    expect(b.valuations[0]!.operationId).toBe(a.valuations[0]!.operationId);
  });

  it("a DIFFERENT attempt produces different ids", async () => {
    counter = 0;
    const a = await plan([row()]);
    counter = 0;
    const b = await plan([row()], { attemptId: "attempt-2" });
    expect(a.winesToCreate[0]!.operationId, "id must exist").toBeTruthy();
    expect(b.winesToCreate[0]!.operationId).not.toBe(a.winesToCreate[0]!.operationId);
  });

  it("each action gets its own id", async () => {
    const p = await plan([
      row({
        currentValue: "95",
        valuationCurrency: "GBP",
        valuationBasis: "market_estimate",
        valuationSource: "manual",
        tastingRating: "4",
      }),
    ]);
    const ids = [
      p.winesToCreate[0]!.operationId,
      p.valuations[0]!.operationId,
      p.tastings[0]!.operationId,
    ];
    // Every id must genuinely exist — an undefined once counted as "distinct".
    expect(ids.every((id) => typeof id === "string" && id.length === 36)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it("ids are valid UUIDs, as every operation column requires", async () => {
    const id = await stableOperationId("a", "b");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("fingerprints survive cosmetic differences", () => {
  it("trailing whitespace and CRLF do not change it", async () => {
    const a = await fingerprintCsv("a,b\n1,2\n");
    const b = await fingerprintCsv("a,b  \r\n1,2\r\n");
    expect(b).toBe(a);
  });

  it("a BOM does not change it", async () => {
    expect(await fingerprintCsv("\uFEFFa,b\n1,2")).toBe(await fingerprintCsv("a,b\n1,2"));
  });

  it("different content DOES change it", async () => {
    expect(await fingerprintCsv("a,b\n1,2")).not.toBe(await fingerprintCsv("a,b\n1,3"));
  });

  it("the reference marker is namespaced per file, then per purchase", async () => {
    const { importReferencePrefix, groupReference } =
      await import("@/domain/csv-import/acquisitions");
    expect(importReferencePrefix("abc")).toBe("import:abc:");
    const ref = await groupReference("abc", "group-key");
    expect(ref.startsWith("import:abc:")).toBe(true);
    expect(ref).toBe(await groupReference("abc", "group-key"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("positions are only sent when proven safe", () => {
  it("resolves a valid free slot", async () => {
    const p = await plan([row({ storageLocation: "Cellar", position: "c1r1" })], {
      locations: [location()],
    });
    expect(p.positions[0]!.resolved).toBe(true);
    expect(p.items[0]!.positions[0]).toEqual({ col: 1, row: 1 });
  });

  it("an OCCUPIED slot is never taken", async () => {
    const p = await plan([row({ storageLocation: "Cellar", position: "c1r1" })], {
      locations: [location({ occupiedKeys: new Set(["c1r1"]) })],
    });
    expect(p.positions[0]).toMatchObject({ resolved: false, reason: "occupied" });
    expect(p.items[0]!.positions[0]).toBeNull();
  });

  it("two rows cannot claim the SAME slot", async () => {
    const p = await plan(
      [
        row({ storageLocation: "Cellar", position: "c1r1" }, 2),
        row({ producer: "Q", storageLocation: "Cellar", position: "c1r1" }, 3),
      ],
      { locations: [location()] },
    );
    expect(p.positions[0]!.resolved).toBe(true);
    expect(p.positions[1]).toMatchObject({ resolved: false, reason: "claimed-in-file" });
  });

  it("an unknown location leaves the bottle unpositioned", async () => {
    const p = await plan([row({ storageLocation: "Nowhere", position: "c1r1" })], {
      locations: [location()],
    });
    expect(p.positions[0]!.reason).toBe("no-such-location");
    expect(p.items[0]!.positions[0]).toBeNull();
  });

  it("a key invalid for the layout is rejected, not guessed", async () => {
    const p = await plan([row({ storageLocation: "Cellar", position: "x9y9" })], {
      locations: [location()],
    });
    expect(p.positions[0]!.reason).toBe("invalid-for-layout");
  });

  it("unpositioned storage cannot take a position", async () => {
    const p = await plan([row({ storageLocation: "Shelf", position: "c1r1" })], {
      locations: [location({ name: "Shelf", isPositioned: false })],
    });
    expect(p.positions[0]!.reason).toBe("not-positioned");
  });

  it("only the FIRST bottle of a multi-bottle row takes the slot", async () => {
    const p = await plan(
      [row({ quantity: "6", storageLocation: "Cellar", position: "c1r1" })],
      {
        locations: [location()],
      },
    );
    expect(p.items[0]!.positions[0]).not.toBeNull();
    expect(p.items[0]!.positions.slice(1).every((x) => x === null)).toBe(true);
  });

  it("matches a location name case-insensitively", async () => {
    const p = await plan([row({ storageLocation: "cellar", position: "c1r1" })], {
      locations: [location()],
    });
    expect(p.positions[0]!.resolved).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVALID ROWS AND CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════

describe("invalid rows never reach a mutation", () => {
  it("an invalid row contributes no wine, bottle or valuation", async () => {
    const p = await plan([row({ wineType: "" })]);
    expect(p.counts.winesToCreate).toBe(0);
    expect(p.counts.bottlesToCreate).toBe(0);
    expect(p.items).toEqual([]);
  });

  it("CONFIRMATION IS BLOCKED while any row is invalid", async () => {
    const p = await plan([row(), row({ wineType: "" }, 3)]);
    expect(p.counts.invalidRows).toBe(1);
    expect(canConfirm(p)).toBe(false);
  });

  it("warnings alone do not block", async () => {
    const p = await plan([row({ status: "Consumed" })]);
    expect(p.counts.warningRows).toBe(1);
    expect(canConfirm(p)).toBe(true);
  });

  it("an empty plan cannot be confirmed", async () => {
    expect(canConfirm(await plan([]))).toBe(false);
  });

  it("counts reconcile with the plan exactly", async () => {
    const p = await plan([
      row({ quantity: "6" }, 2),
      row(
        {
          producer: "Q",
          quantity: "3",
          currentValue: "95",
          valuationCurrency: "GBP",
          valuationBasis: "market_estimate",
          valuationSource: "manual",
        },
        3,
      ),
      row({ wineType: "" }, 4),
    ]);
    expect(p.counts).toMatchObject({
      rows: 3,
      invalidRows: 1,
      winesToCreate: 2,
      bottlesToCreate: 9,
      valuations: 1,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════

describe("the template round-trips", () => {
  it("parses cleanly through the importer", () => {
    const r = parseCsv(buildTemplateCsv());
    expect(r.fatalError).toBeNull();
    expect(r.unknownColumns).toEqual([]);
    expect(r.rows).toHaveLength(1);
  });

  it("its example row is valid", () => {
    const r = parseCsv(buildTemplateCsv());
    expect(r.rows[0]!.severity).not.toBe("invalid");
  });

  it("the example survives its quoted comma and semicolons", () => {
    const r = parseCsv(buildTemplateCsv());
    expect(r.rows[0]!.grapes).toEqual(["Cabernet Sauvignon", "Merlot"]);
  });

  it("guards against FORMULA INJECTION for any future export", () => {
    expect(escapeCsvValue("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(escapeCsvValue("+1")).toBe("'+1");
    expect(escapeCsvValue("-1")).toBe("'-1");
    expect(escapeCsvValue("@cmd")).toBe("'@cmd");
  });

  it("quotes values containing commas or quotes", () => {
    expect(escapeCsvValue("a,b")).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  it("leaves ordinary values alone", () => {
    expect(escapeCsvValue("Château")).toBe("Château");
  });
});
