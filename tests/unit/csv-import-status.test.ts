import { describe, it, expect } from "vitest";
import { parseCsv } from "@/domain/csv-import/parse";
import {
  markStatusConflicts,
  applyImportIntegrityChecks,
  resolveStatusTargets,
  itemSignature,
  IMPORT_REMOVAL_REASON,
} from "@/domain/csv-import/status";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HEADER =
  "Producer,Wine Name,Vintage,Wine Type,Quantity,Status,Bottle Size ml," +
  "Purchase Price per Bottle,Purchase Currency,Purchase Date,Merchant / Source";

const rowsOf = (...lines: string[]) => parseCsv([HEADER, ...lines].join("\n")).rows;

describe("identical bottles with different statuses are BLOCKED before writing", () => {
  it("same wine, quantity, size and price, mixed status → both rows invalid", () => {
    const rows = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,,",
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,,",
      ),
    );
    expect(rows.every((r) => r.severity === "invalid")).toBe(true);
    expect(rows[0]!.issues.some((i) => /cannot\s+be told apart/.test(i.message))).toBe(
      true,
    );
  });

  it("names both conflicting lines so the user can find them", () => {
    const [r] = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,,",
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,,",
      ),
    );
    expect(r!.issues.at(-1)!.message).toMatch(/Rows 2, 3/);
  });

  it("same wine but DIFFERENT quantity is distinguishable → not blocked", () => {
    const rows = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,,",
        "Estate,Wine,2018,Red,2,Consumed,750,30,GBP,,",
      ),
    );
    expect(rows.every((r) => r.severity !== "invalid")).toBe(true);
  });

  it("same wine, same signature, SAME status → not blocked (no crossing possible)", () => {
    const rows = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,,",
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,,",
      ),
    );
    expect(rows.every((r) => r.severity !== "invalid")).toBe(true);
  });

  it("different vintages are different wines → not blocked", () => {
    const rows = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,,",
        "Estate,Wine,2019,Red,1,Consumed,750,30,GBP,,",
      ),
    );
    expect(rows.every((r) => r.severity !== "invalid")).toBe(true);
  });

  it("price is compared in pennies — 30 and 30.00 are the same signature", () => {
    expect(itemSignature("w", 1, "750ml", 30)).toBe(
      itemSignature("w", 1, "750ml", "30.00"),
    );
    expect(itemSignature("w", 1, "750ml", null)).not.toBe(
      itemSignature("w", 1, "750ml", 0),
    );
  });

  it("is idempotent and never mutates its input", () => {
    const input = rowsOf(
      "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,,",
      "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,,",
    );
    const before = JSON.stringify(input);
    const once = markStatusConflicts(input);
    const twice = markStatusConflicts(once);
    expect(JSON.stringify(input)).toBe(before);
    expect(twice[0]!.issues.length).toBe(once[0]!.issues.length);
  });
});

describe("REVERSED DECISION: a mixed-currency file is now VALID", () => {
  // One acquisition per purchase identity means GBP and EUR purchases become
  // separate acquisitions. The former whole-file block is gone.
  it("GBP and EUR rows are not blocked", () => {
    const rows = applyImportIntegrityChecks(
      rowsOf(
        "A,One,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "B,Two,2018,Red,1,In cellar,750,40,EUR,2023-09-12,Caves Legrand",
      ),
    );
    expect(rows.every((r) => r.severity !== "invalid")).toBe(true);
  });

  it("a price WITHOUT a currency still blocks", () => {
    const [r] = applyImportIntegrityChecks(rowsOf("A,One,2018,Red,1,In cellar,750,30,,,"));
    expect(r!.severity).toBe("invalid");
  });

  it("an unknown price stays NULL — never zero", () => {
    const [r] = rowsOf("A,One,2018,Red,1,In cellar,750,,,,");
    expect(r!.purchasePrice).toBeNull();
  });
});

describe("identical rows in DIFFERENT acquisitions are distinguishable", () => {
  it("same wine/qty/size/price but different purchase dates → NOT blocked", () => {
    const rows = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,2023-09-12,Berry Bros",
      ),
    );
    expect(rows.every((r) => r.severity !== "invalid")).toBe(true);
  });

  it("same everything, same acquisition, mixed status → still BLOCKED", () => {
    const rows = markStatusConflicts(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,2022-05-01,Berry Bros",
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,2022-05-01,Berry Bros",
      ),
    );
    expect(rows.every((r) => r.severity === "invalid")).toBe(true);
  });
});

describe("resolution after the RPC", () => {
  const created = [
    {
      id: "i1",
      wineDefinitionId: "w",
      quantity: 1,
      bottleSize: "750ml",
      unitPrice: "30.00",
    },
    {
      id: "i2",
      wineDefinitionId: "w",
      quantity: 2,
      bottleSize: "750ml",
      unitPrice: "30.00",
    },
  ];
  const bottles = [
    { id: "b1", version: 1, status: "in_cellar", acquisitionItemId: "i1" },
    { id: "b2", version: 1, status: "in_cellar", acquisitionItemId: "i2" },
    { id: "b3", version: 1, status: "in_cellar", acquisitionItemId: "i2" },
  ];

  it("targets exactly the Consumed row's bottles — never its sibling's", () => {
    const r = resolveStatusTargets({
      planned: [
        {
          lineNumber: 2,
          wineId: "w",
          quantity: 1,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "in_cellar",
        },
        {
          lineNumber: 3,
          wineId: "w",
          quantity: 2,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "consumed",
        },
      ],
      created,
      bottles,
    });
    expect(r.targets.map((t) => t.bottleId)).toEqual(["b2", "b3"]);
    expect(r.failures).toEqual([]);
  });

  it("a mixed-status group that slipped through is REFUSED, not guessed", () => {
    const r = resolveStatusTargets({
      planned: [
        {
          lineNumber: 2,
          wineId: "w",
          quantity: 1,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "in_cellar",
        },
        {
          lineNumber: 3,
          wineId: "w",
          quantity: 1,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "consumed",
        },
      ],
      created: [created[0]!, { ...created[0]!, id: "i9" }],
      bottles: [bottles[0]!, { ...bottles[0]!, id: "b9", acquisitionItemId: "i9" }],
    });
    expect(r.targets).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });

  it("a removed bottle carries the provenance reason the RPC requires", () => {
    const r = resolveStatusTargets({
      planned: [
        {
          lineNumber: 3,
          wineId: "w",
          quantity: 2,
          bottleSize: "750ml",
          unitPrice: 30,
          status: "removed",
        },
      ],
      created,
      bottles,
    });
    expect(r.targets.every((t) => t.reason === IMPORT_REMOVAL_REASON)).toBe(true);
  });

  it("targets come out in a stable order", () => {
    const planned = [
      {
        lineNumber: 3,
        wineId: "w",
        quantity: 2,
        bottleSize: "750ml",
        unitPrice: 30,
        status: "consumed",
      },
    ];
    const a = resolveStatusTargets({ planned, created, bottles });
    const b = resolveStatusTargets({ planned, created, bottles: [...bottles].reverse() });
    expect(a.targets.map((t) => t.bottleId)).toEqual(b.targets.map((t) => t.bottleId));
  });
});

describe("wiring in the import screen", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src/features/import/ImportScreen.tsx"),
    "utf8",
  );

  it("integrity checks run BEFORE planning", () => {
    const checks = SRC.indexOf("applyImportIntegrityChecks(raw.rows)");
    const plan = SRC.indexOf("await planImport(");
    // Presence first: indexOf returns -1 when absent, and -1 is "less than"
    // everything — which made an earlier version of this test pass against
    // code that never ran the checks at all.
    expect(checks, "integrity checks are never applied").toBeGreaterThan(-1);
    expect(plan, "planImport call not found").toBeGreaterThan(-1);
    expect(checks).toBeLessThan(plan);
  });

  it("statuses are joined to items by LINE NUMBER, never by wine", () => {
    expect(SRC).toMatch(/statusByLine\.get\(i\.lineNumber\)/);
  });

  it("each status change uses a stable, attempt-derived operation id", () => {
    expect(SRC).toMatch(
      /stableOperationId\(\s*plan\.attemptId,\s*statusAction\(t\.bottleId\)/,
    );
  });

  it("each acquisition sends ITS OWN group's currency", () => {
    expect(SRC).toMatch(/g\.identity\.currency \? \{ currency: g\.identity\.currency \}/);
  });

  it("unknown date and merchant are OMITTED, never defaulted", () => {
    expect(SRC).toMatch(/g\.identity\.purchasedOn \? \{ purchased_on:/);
    expect(SRC).toMatch(/g\.identity\.merchant \? \{ source: g\.identity\.merchant \}/);
    // The old invented merchant is gone.
    expect(SRC).not.toMatch(/source:\s*[^,]*"CSV import"/);
  });

  it("each group has its own operation id", () => {
    expect(SRC).toMatch(/operationId: g\.operationId/);
    expect(SRC).not.toMatch(/operationId: plan\.acquisitionOperationId/);
  });

  it("status is resolved PER ACQUISITION", () => {
    expect(SRC).toMatch(
      /for \(const g of groups\)[\s\S]{0,400}plannedStatusItems\(g\.items/,
    );
  });

  it("status is reported as its own step", () => {
    expect(SRC).toMatch(/Bottles moved out of the cellar/);
  });

  it("integrity checks compose", () => {
    const rows = applyImportIntegrityChecks(
      rowsOf(
        "Estate,Wine,2018,Red,1,In cellar,750,30,GBP,,",
        "Estate,Wine,2018,Red,1,Consumed,750,30,GBP,,",
      ),
    );
    expect(rows.every((r) => r.severity === "invalid")).toBe(true);
  });
});
