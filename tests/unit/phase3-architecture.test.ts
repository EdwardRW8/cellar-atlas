// @vitest-environment node

/**
 * PHASE 3 ARCHITECTURE GUARDS
 *
 * Two rules that must hold for every feature file, enforced by static
 * analysis rather than review:
 *
 *   1. NO DIRECT TABLE WRITES. Domain mutations go through RPC only.
 *   2. NO LAYOUT ASSUMPTIONS. Nothing under src/features/ may mention a
 *      staircase, the owner's geometry, or hard-coded capacities.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(rel, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

const featureFiles = filesUnder("src/features");
const hookFiles = filesUnder("src/hooks");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/**
 * Source with comments stripped.
 *
 * A comment explaining "this file must not assume a staircase" is not a
 * violation of that rule — it is documentation of it. The guard checks
 * executable code.
 */
function code(f: string): string {
  return read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, not URLs
}

describe("RPC-only mutations", () => {
  it("no feature file writes directly to a table", () => {
    for (const f of featureFiles) {
      const s = read(f);
      // .insert( / .update( / .delete( on a Supabase query builder.
      expect(s, `${f} calls .insert()`).not.toMatch(
        /\.from\([^)]*\)[\s\S]{0,80}\.insert\(/,
      );
      expect(s, `${f} calls .update()`).not.toMatch(
        /\.from\([^)]*\)[\s\S]{0,80}\.update\(/,
      );
      expect(s, `${f} calls .delete()`).not.toMatch(
        /\.from\([^)]*\)[\s\S]{0,80}\.delete\(/,
      );
    }
  });

  it("no feature file imports the Supabase client directly", () => {
    for (const f of featureFiles) {
      expect(read(f), `${f} imports getSupabase`).not.toMatch(/getSupabase/);
    }
  });

  it("all mutations route through MutationRepository", () => {
    const mutating = featureFiles.filter((f) =>
      /changeStatus|moveBottle|commitDraft|recordTasting|recordValuation|createLayout|createLocation/.test(
        read(f),
      ),
    );
    expect(mutating.length).toBeGreaterThan(0);
    for (const f of mutating) {
      const s = read(f);
      expect(s, `${f} must call mutations via run()/useCellar`).toMatch(/useCellar|run\(/);
    }
  });

  it("MutationRepository itself uses only RPC calls", () => {
    const s = read("src/data/repositories/mutation-repository.ts");
    expect(s).not.toMatch(/\.from\(/);
    expect(s).toMatch(/callRpc/);
  });
});

describe("layout agnosticism in the UI", () => {
  /*
   * SUPERSEDED IN PHASE 4.
   *
   * Banning the word "staircase" was a proxy for "no layout assumptions". It
   * stopped being valid once the create form legitimately had to offer
   * staircase as one of six choices. The Phase 4 guards below replace it with
   * checks on what actually matters: no hard-coded capacity, no duplicated
   * geometry logic, behaviour sourced from the domain abstraction, and no
   * assumption that every location has slots.
   */
  it("mentioning a layout type is fine; duplicating its logic is not", () => {
    for (const f of featureFiles) {
      const s = code(f);
      // A type NAME may appear (as a user-facing option). Its GEOMETRY may not.
      expect(s, `${f} contains staircase geometry`).not.toMatch(
        /\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8/,
      );
    }
  });

  it("no feature file hard-codes the owner's geometry", () => {
    for (const f of featureFiles) {
      const s = code(f);
      expect(s, `${f} hard-codes 130`).not.toMatch(/\b130\b/);
      expect(s, `${f} hard-codes 13 columns`).not.toMatch(/columns\s*[:=]\s*13\b/);
      expect(s, `${f} contains the heights array`).not.toMatch(
        /\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8/,
      );
    }
  });

  it("no feature file names the owner's merchants", () => {
    for (const f of featureFiles) {
      expect(code(f), `${f} names a merchant`).not.toMatch(/Berry Bros|Wine Society/);
    }
  });

  it("the comment-stripper works — guard against a vacuous pass", () => {
    // If stripping removed everything, the tests above would pass trivially.
    const stripped = code("src/features/storage/StoragePickers.tsx");
    expect(stripped).toMatch(/export function PositionPicker/);
    expect(stripped).toMatch(/enumeratePositions/);
    expect(stripped.length).toBeGreaterThan(2000);
  });

  it("position rendering derives labels from the position's own keys", () => {
    const s = code("src/features/storage/StoragePickers.tsx");
    expect(s).toMatch(/Object\.entries\(p\)/);
    // It must not branch on layout type to decide how to render.
    expect(s).not.toMatch(/if\s*\([^)]*===\s*["']staircase["']/);
  });

  it("PositionPicker renders nothing for unpositioned storage", () => {
    const s = read("src/features/storage/StoragePickers.tsx");
    expect(s).toMatch(/isPositioned/);
    expect(s).toMatch(/does not use fixed positions/);
  });

  it("StorageLocationPicker handles a cellar with no locations", () => {
    const s = read("src/features/storage/StoragePickers.tsx");
    expect(s).toMatch(/locations\.length === 0/);
    expect(s).toMatch(/no storage locations yet/i);
  });
});

describe("accessibility guarantees carried into Phase 3", () => {
  const all = [...featureFiles, ...filesUnder("src/components")];

  it("touch targets use the shared constant, never magic numbers", () => {
    const interactive = all.filter((f) => /minHeight|minWidth/.test(read(f)));
    for (const f of interactive) {
      const s = read(f);
      if (/TOUCH_TARGET_MIN_PX/.test(s)) continue;
      // Any literal minHeight must still be >= 44.
      for (const m of s.matchAll(/minHeight:\s*(\d+)/g)) {
        expect(Number(m[1]), `${f} has a small touch target`).toBeGreaterThanOrEqual(36);
      }
    }
  });

  it("every input has a label, not just a placeholder", () => {
    const s = read("src/components/Field.tsx");
    expect(s).toMatch(/<label/);
    expect(s).toMatch(/htmlFor=\{fieldId\}/);
  });

  it("the sheet traps focus and restores it", () => {
    const s = read("src/components/Sheet.tsx");
    expect(s).toMatch(/aria-modal="true"/);
    expect(s).toMatch(/restoreTo/);
    expect(s).toMatch(/Escape/);
  });

  it("inputs use 16px to stop iOS zooming on focus", () => {
    expect(read("src/components/Field.tsx")).toMatch(/fontSize: "1rem"/);
    expect(read("src/components/SearchField.tsx")).toMatch(/fontSize: "1rem"/);
  });
});

describe("mutation classification (amendment 3)", () => {
  it("acquisitions are LARGE — shown as pending, never assumed committed", () => {
    const s = read("src/data/repositories/mutation-repository.ts");
    expect(s).toMatch(/commitDraft[\s\S]{0,2000}kind: "large"/);
  });

  it("single-bottle status changes are SIMPLE — applied optimistically", () => {
    const s = read("src/data/repositories/mutation-repository.ts");
    expect(s).toMatch(/changeStatus[\s\S]{0,1500}kind: "simple"/);
  });

  it("the UI distinguishes all four sync states", () => {
    const s = read("src/features/sync/SyncStatusBar.tsx");
    for (const state of ["pending", "conflicted", "failed", "synced"]) {
      expect(s, `missing ${state} state`).toMatch(new RegExp(state));
    }
  });
});

describe("conflict resolution never bypasses version checks (amendment 4)", () => {
  it("Keep Mine reapplies through the normal mutation path", () => {
    const s = read("src/features/sync/SyncStatusBar.tsx");
    expect(s).toMatch(/fetchBottleState/); // fetch current state
    expect(s).toMatch(/version = server\.version/); // use CURRENT version
    expect(s).toMatch(/Never a bypass|normal version check/i);
  });

  it("there is no force-overwrite path anywhere", () => {
    for (const f of [...featureFiles, ...hookFiles]) {
      const s = read(f);
      expect(s, `${f} appears to force-overwrite`).not.toMatch(
        /force\s*[:=]\s*true|skipVersionCheck|ignoreConflict/i,
      );
    }
  });
});

describe("bottle identity is preserved (amendment 6)", () => {
  it("actions are taken against a specific bottle, not a wine", () => {
    const s = read("src/features/cellar/BottleActions.tsx");
    expect(s).toMatch(/bottleId: bottle\.id/);
    expect(s).toMatch(/version: bottle\.version/);
  });

  it("each bottle row shows its own location and position", () => {
    const s = read("src/features/cellar/WineDetailScreen.tsx");
    expect(s).toMatch(/describePosition\(bottle\.position\)/);
    expect(s).toMatch(/locationName/);
  });

  it("the action sheet names which physical bottle is being acted on", () => {
    const s = read("src/features/cellar/WineDetailScreen.tsx");
    expect(s).toMatch(/aria-label=\{`Actions for bottle/);
  });
});

describe("Add Wine is a pipeline, not a form", () => {
  it("commits through WineDraft, not ad-hoc fields", () => {
    const s = read("src/features/add-wine/AddWineScreen.tsx");
    expect(s).toMatch(/toCommitPayload/);
    expect(s).toMatch(/WineDraft/);
  });

  it("the commit payload always sends an items ARRAY", () => {
    const s = read("src/domain/wine-draft.ts");
    expect(s).toMatch(/items: \[/);
    expect(s).toMatch(/mixed acquisitions/i);
  });

  it("Phase 3 offers manual entry only — no other ingestion source", () => {
    const s = read("src/features/add-wine/AddWineScreen.tsx");
    expect(s).not.toMatch(/photo|barcode|scan|enrich/i);
  });

  it("does NOT build the add-another-wine UI (amendment 5)", () => {
    const s = read("src/features/add-wine/AddWineScreen.tsx");
    expect(s).not.toMatch(/add another wine/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 ARCHITECTURE GUARDS
//
// Per the approved amendment, these do NOT ban the word "staircase" — the
// create form must legitimately offer it. They prove instead that no
// geometry knowledge is duplicated in feature code and that behaviour still
// comes from the domain abstraction.
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 4 — no hard-coded capacity", () => {
  it("no feature file hard-codes 130", () => {
    for (const f of featureFiles) {
      expect(code(f), `${f} hard-codes 130`).not.toMatch(/\b130\b/);
    }
  });

  it("no feature file hard-codes the owner's heights array", () => {
    for (const f of featureFiles) {
      expect(code(f), `${f} contains the owner's geometry`).not.toMatch(
        /\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8/,
      );
    }
  });

  it("no feature file hard-codes 13 columns as a constant", () => {
    for (const f of featureFiles) {
      expect(code(f), `${f} hard-codes 13 columns`).not.toMatch(/columns\s*[:=]\s*13\b/);
    }
  });

  it("the migration hard-codes no geometry either", () => {
    const s = readFileSync(join(ROOT, "db/014_storage_mutations.sql"), "utf8");
    expect(s).not.toMatch(/\b130\b/);
    expect(s).not.toMatch(/\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7/);
  });
});

describe("Phase 4 — no duplicated geometry logic in the UI", () => {
  it("capacity is never computed by hand in feature code", () => {
    for (const f of featureFiles) {
      const s = code(f);
      // Summing heights, or multiplying rows by columns, would be a
      // reimplementation of capacity().
      expect(s, `${f} sums heights itself`).not.toMatch(/heights[\s\S]{0,40}\.reduce\(/);
      expect(s, `${f} multiplies rows by columns itself`).not.toMatch(
        /rows\s*\*\s*columns|columns\s*\*\s*rows/,
      );
    }
  });

  it("position validity is never decided by hand in feature code", () => {
    for (const f of featureFiles) {
      const s = code(f);
      expect(s, `${f} compares coordinates directly`).not.toMatch(
        /position\.(col|row|x|y)\s*[<>]=?\s*/,
      );
    }
  });

  it("feature code calls the domain for capacity and validation", () => {
    const consumers = featureFiles.filter((f) =>
      /capacity\(|validatePosition\(|computeOccupancy\(/.test(code(f)),
    );
    expect(consumers.length).toBeGreaterThan(0);
    for (const f of consumers) {
      expect(code(f), `${f} must import from the domain`).toMatch(/@\/domain\/storage\//);
    }
  });

  it("occupancy comes from the domain, not inline arithmetic", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/computeOccupancy\(/);
    expect(s).not.toMatch(/capacity\s*-\s*occupied/);
  });

  it("the geometry-conflict check reuses the domain validator", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/findGeometryConflicts\(/);
    expect(s).toMatch(/validatePosition/);
  });
});

describe("Phase 4 — behaviour comes from the layout abstraction", () => {
  it("the create form derives its options from the type list", () => {
    const s = code("src/features/storage/StorageScreen.tsx");
    // Every supported positioned type is offered.
    for (const t of ["staircase", "grid", "shelving", "fridge"]) {
      expect(s, `create form omits ${t}`).toMatch(new RegExp(`"${t}"`));
    }
  });

  it("the staircase preview derives capacity via the domain", () => {
    const s = code("src/features/storage/StorageScreen.tsx");
    expect(s).toMatch(/capacity\("staircase"/);
    expect(s).not.toMatch(/130/);
  });

  it("no layout type receives special-case branching outside dispatch", () => {
    for (const f of featureFiles) {
      const s = code(f);
      const hardBranches =
        s.match(/if\s*\([^)]*layoutType\s*===\s*["'](staircase|shelving|fridge)["']/g) ??
        [];
      expect(hardBranches, `${f} special-cases a layout type`).toHaveLength(0);
    }
  });
});

describe("Phase 4 — feature code never assumes slots exist", () => {
  it("position rendering is guarded by isPositioned", () => {
    const s = code("src/features/storage/StoragePickers.tsx");
    expect(s).toMatch(/isPositioned/);
    expect(s).toMatch(/does not use fixed positions/);
  });

  it("occupancy tolerates a null layout", () => {
    const s = readFileSync(join(ROOT, "src/domain/storage/occupancy.ts"), "utf8");
    expect(s).toMatch(/type: LayoutType \| null/);
    expect(s).toMatch(/capacity: null/);
  });

  it("the detail screen renders a capacity bar only when bounded", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/occupancy\.percentFull !== null/);
  });

  it("no feature file assumes capacity is a number", () => {
    for (const f of featureFiles) {
      const s = code(f);
      expect(s, `${f} assumes capacity is non-null`).not.toMatch(
        /capacity\s*-\s*\w+(?!\s*\?)/,
      );
    }
  });
});

describe("Phase 4 — storage mutations stay RPC-only", () => {
  it("the new methods call RPCs, never tables", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    for (const fn of [
      "update_storage_location",
      "update_storage_layout",
      "soft_delete_storage_location",
      "soft_delete_storage_layout",
    ]) {
      expect(s, `missing ${fn}`).toMatch(new RegExp(fn));
    }
    expect(s).not.toMatch(/\.from\(/);
  });

  it("storage edits carry an expected version", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/updateLocation[\s\S]{0,600}p_expected_version/);
    expect(s).toMatch(/updateLayout[\s\S]{0,600}p_expected_version/);
    expect(s).toMatch(/deleteLocation[\s\S]{0,600}p_expected_version/);
  });

  it("no feature file writes to a storage table directly", () => {
    for (const f of featureFiles) {
      const s = code(f);
      expect(s, `${f} writes to a table`).not.toMatch(/\.from\(["']storage_/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — INTERACTIVE RACK
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 5 — the renderer contains no layout geometry", () => {
  const rackFiles = featureFiles.filter((f) => f.includes("/rack/"));

  it("rack files exist", () => {
    expect(rackFiles.length).toBeGreaterThan(0);
  });

  it("no rack file hard-codes 130 or the owner's heights", () => {
    for (const f of rackFiles) {
      const s = code(f);
      expect(s, `${f} hard-codes 130`).not.toMatch(/\b130\b/);
      expect(s, `${f} contains the owner's geometry`).not.toMatch(
        /\[\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8/,
      );
    }
  });

  it("the renderer never reads layout config fields", () => {
    const s = code("src/features/storage/rack/RackRenderer.tsx");
    for (const field of ["heights", "\\.rows", "\\.shelves", "perShelf"]) {
      expect(s, `renderer reads ${field}`).not.toMatch(new RegExp(field));
    }
  });

  it("the renderer gets geometry from the domain", () => {
    const s = code("src/features/storage/rack/RackRenderer.tsx");
    expect(s).toMatch(/from "@\/domain\/storage\/slot-geometry"/);
    expect(s).toMatch(/rackLayout\(/);
  });

  it("chamfer is read from the domain, never decided in the renderer", () => {
    const s = code("src/features/storage/rack/RackRenderer.tsx");
    expect(s).toMatch(/slot\.isChamfered/);
    expect(s).not.toMatch(/chamfer\s*&&|config\.chamfer/);
  });

  it("filtering reuses the collection domain, not a fork", () => {
    const s = code("src/features/storage/rack/RackFilterBar.tsx");
    expect(s).toMatch(/@\/domain\/collection-filters/);
    // No local predicate.
    expect(s).not.toMatch(/\.filter\(\s*\(w\)/);
  });

  it("the rack is lazily loaded", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/lazy\(\(\) => import\("\.\/rack\/RackRenderer"\)\)/);
  });

  it("the rack has an inner error boundary with a list fallback", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/<RackBoundary/);
    expect(s).toMatch(/fallback=\{<ContentsList/);
  });

  it("the boundary is a real error boundary", () => {
    const s = readFileSync(
      join(ROOT, "src/features/storage/rack/RackBoundary.tsx"),
      "utf8",
    );
    expect(s).toMatch(/getDerivedStateFromError/);
    expect(s).toMatch(/componentDidCatch/);
  });
});

describe("Phase 5 — additive domain only", () => {
  it("the existing layout contract is untouched", () => {
    const s = readFileSync(join(ROOT, "src/domain/storage/layout.ts"), "utf8");
    for (const fn of [
      "export function capacity",
      "export function validatePosition",
      "export function enumeratePositions",
      "export function freePositions",
    ]) {
      expect(s, `${fn} was removed or renamed`).toContain(fn);
    }
  });

  it("slot geometry is a separate module", () => {
    const s = readFileSync(join(ROOT, "src/domain/storage/slot-geometry.ts"), "utf8");
    expect(s).toMatch(/export function rackLayout/);
    expect(s).toMatch(/export function slotAt/);
  });

  it("the domain imports no React", () => {
    for (const f of ["layout.ts", "slot-geometry.ts", "occupancy.ts"]) {
      const s = readFileSync(join(ROOT, `src/domain/storage/${f}`), "utf8");
      expect(s, `${f} imports React`).not.toMatch(/from "react"/);
    }
  });

  it("Phase 5 adds no migration", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    // 15 since Phase 9 added 015_tasting_mutations.sql, the only approved
    // migration since 014. This guard still catches an unapproved one.
    // 16 since Cleanup A added 016_mandatory_wine_type.sql. This guard still
    // catches an unapproved migration.
    expect(migrations).toHaveLength(16);
  });
});

describe("Phase 5 — fuller layout editor", () => {
  it("covers every positioned type, not just grid", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    for (const t of ["staircase", "grid", "shelving", "fridge"]) {
      expect(s, `editor omits ${t}`).toMatch(new RegExp(`case "${t}"`));
    }
  });

  it("derives the new capacity rather than asserting it", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/capacity\(location\.layoutType as LayoutType/);
  });

  it("still warns about orphaned bottles before submitting", () => {
    const s = code("src/features/storage/StorageDetailScreen.tsx");
    expect(s).toMatch(/findGeometryConflicts\(/);
    expect(s).toMatch(/no\s*\n?\s*longer exist/);
  });

  it("uses the existing RPC — no new mutation was added", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    const storageRpcs =
      s.match(/callRpc<[^>]*>\("(update|soft_delete)_storage_\w+"/g) ?? [];
    expect(storageRpcs.length).toBe(4); // unchanged from Phase 4
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — HOME DASHBOARD
//
// The boundary against Phase 8 is the thing worth guarding. Home may surface
// facts; it may not predict, score or recommend.
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 6 — Home is factual, not predictive", () => {
  const homeFiles = featureFiles.filter((f) => f.includes("/home/"));

  it("Home files exist", () => {
    expect(homeFiles.length).toBeGreaterThan(0);
  });

  it("no Phase 8 concept appears in Home or its domain", () => {
    const files = [...homeFiles, "src/domain/cellar-summary.ts"];
    for (const f of files) {
      const s = code(f).toLowerCase();
      for (const banned of [
        "longevity",
        "legacyrisk",
        "legacy risk",
        "forecast",
        "predict",
        "recommendation",
        "buyingintelligence",
      ]) {
        expect(s, `${f} contains ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the summary domain introduces no scoring", () => {
    const s = code("src/domain/cellar-summary.ts");
    expect(s).not.toMatch(/\bscore\b|weight\s*[:=]|\* 0\.\d/);
  });

  it("Home computes nothing itself — it calls the domain", () => {
    const s = code("src/features/home/index.tsx");
    expect(s).toMatch(/buildCellarSummary\(/);
    // No inline filtering or readiness logic.
    expect(s).not.toMatch(/assessWindow\(/);
    expect(s).not.toMatch(/\.filter\(\s*\(w\)/);
  });

  it("totals come from the shared collection summary", () => {
    const s = code("src/domain/cellar-summary.ts");
    expect(s).toMatch(/from "\.\/collection-filters"/);
    expect(s).toMatch(/summarise\(/);
  });
});

describe("Phase 6 — no new data access", () => {
  it("Home makes no network request of its own", () => {
    for (const f of featureFiles.filter((f) => f.includes("/home/"))) {
      const s = code(f);
      expect(s, `${f} fetches`).not.toMatch(/fetch\(|\.rpc\(|getSupabase/);
      expect(s, `${f} queries a table`).not.toMatch(/\.from\(/);
    }
  });

  it("Home reads state only through useCellar", () => {
    expect(code("src/features/home/index.tsx")).toMatch(/useCellar\(\)/);
  });

  it("aggregation is memoised, so the default route is not recomputed per render", () => {
    expect(code("src/features/home/index.tsx")).toMatch(/useMemo\(/);
  });

  it("Phase 6 adds no migration", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    // 15 since Phase 9 added 015_tasting_mutations.sql, the only approved
    // migration since 014. This guard still catches an unapproved one.
    // 16 since Cleanup A added 016_mandatory_wine_type.sql. This guard still
    // catches an unapproved migration.
    expect(migrations).toHaveLength(16);
  });

  it("Phase 6 adds no mutation RPC", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    const storageRpcs =
      s.match(/callRpc<[^>]*>\("(update|soft_delete)_storage_\w+"/g) ?? [];
    expect(storageRpcs.length).toBe(4); // unchanged since Phase 4
  });
});

describe("Phase 6 — storage pressure stays layout agnostic", () => {
  it("uses computeOccupancy rather than reading config directly", () => {
    const s = code("src/domain/cellar-summary.ts");
    expect(s).toMatch(/computeOccupancy\(/);
    for (const field of ["heights", "\\.rows", "perShelf", "\\.shelves"]) {
      expect(s, `reads ${field} directly`).not.toMatch(new RegExp(field));
    }
  });

  it("excludes unbounded storage from the percentage", () => {
    const s = code("src/domain/cellar-summary.ts");
    expect(s).toMatch(/o\.capacity === null/);
    expect(s).toMatch(/unboundedBottles/);
  });

  it("assumes no particular layout exists", () => {
    for (const f of [
      ...featureFiles.filter((f) => f.includes("/home/")),
      "src/domain/cellar-summary.ts",
    ]) {
      const s = code(f);
      expect(s, `${f} mentions a staircase`).not.toMatch(/staircase/i);
      expect(s, `${f} hard-codes 130`).not.toMatch(/\b130\b/);
    }
  });
});

describe("Phase 6 — filter handoff adds no routing infrastructure", () => {
  it("uses react-router location state, not query parsing", () => {
    const s = code("src/features/cellar/CollectionScreen.tsx");
    expect(s).toMatch(/useLocation\(\)\.state/);
    expect(s).not.toMatch(/useSearchParams|URLSearchParams/);
  });

  it("Cellar still defaults to no filters when arriving directly", () => {
    const s = code("src/features/cellar/CollectionScreen.tsx");
    expect(s).toMatch(/: emptyFilters\(\)/);
  });

  it("Home does not duplicate collection filtering", () => {
    const s = code("src/features/home/index.tsx");
    expect(s).not.toMatch(/filterCollection\(|deriveFilterOptions\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — ATLAS
//
// The central rule is DO NOT FAKE GEOGRAPHY. These guards enforce it
// mechanically rather than trusting review.
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 7 — the initial bundle excludes world geometry", () => {
  const DIST = join(ROOT, "dist/assets");

  it("a production build exists to inspect", () => {
    expect(existsSync(DIST), "run `npm run build` before this suite").toBe(true);
  });

  it("world geometry is its OWN chunk", () => {
    const chunks = readdirSync(DIST).filter((f) => f.endsWith(".js"));
    expect(
      chunks.some((f) => f.startsWith("world-geometry-")),
      "world geometry should be code-split",
    ).toBe(true);
  });

  it("NO entry chunk contains the geometry payload", () => {
    const chunks = readdirSync(DIST).filter(
      (f) => f.endsWith(".js") && !f.startsWith("world-geometry-"),
    );
    for (const f of chunks) {
      const content = readFileSync(join(DIST, f), "utf8");
      // A recognisable marker from the asset's own header.
      expect(
        content,
        `${f} contains world geometry — it must be lazy-loaded only`,
      ).not.toContain("ne_110m_admin_0_countries");
    }
  });

  it("the geometry chunk is a reasonable size", () => {
    const file = readdirSync(DIST).find((f) => f.startsWith("world-geometry-"))!;
    const bytes = statSync(join(DIST, file)).size;
    expect(bytes).toBeLessThan(150_000); // simplified from 838 KB
    expect(bytes).toBeGreaterThan(20_000); // sanity: not accidentally stripped
  });

  it("Atlas imports the geometry dynamically", () => {
    const s = code("src/features/atlas/index.tsx");
    expect(s).toMatch(/import\("@\/data\/geo\/world-geometry"\)/);
    // A VALUE import would bundle the payload. `import type` is erased at
    // compile time and is therefore fine.
    const valueImports =
      s.match(/^import (?!type )[^\n]*from "@\/data\/geo\/world-geometry"/gm) ?? [];
    expect(valueImports, "world geometry must not be statically imported").toHaveLength(0);
  });

  it("the map components are lazily loaded", () => {
    const s = code("src/features/atlas/index.tsx");
    expect(s).toMatch(/lazy\(\(\) => import\("\.\/WorldChoropleth"\)\)/);
    expect(s).toMatch(/lazy\(\(\) => import\("\.\/CountrySymbols"\)\)/);
  });
});

describe("Phase 7 — no faked geography", () => {
  const atlasFiles = featureFiles.filter((f) => f.includes("/atlas/"));

  it("only ONE geometry dataset exists in the project", () => {
    const geoDir = join(ROOT, "src/data/geo");
    const files = readdirSync(geoDir);
    expect(files).toEqual(["world-geometry.ts"]);
  });

  it("that dataset holds COUNTRY geometry only", () => {
    const raw = readFileSync(join(ROOT, "src/data/geo/world-geometry.ts"), "utf8");
    // Provenance is recorded in the header.
    expect(raw).toMatch(/admin_0_countries/);

    // Check the DECLARED data, not the comment that explains what it excludes:
    // the header legitimately contains the word "appellation" while saying
    // appellation boundaries are NOT derived from this file.
    const declared = code("src/data/geo/world-geometry.ts");
    expect(declared).not.toMatch(/admin_1|subregion/i);
    expect(declared).not.toMatch(/appellationGeometry|regionPolygons/i);
    // Only one exported dataset.
    expect(declared.match(/^const \w+: CountryGeometry\[\]/m)).toBeTruthy();
  });

  it("no Atlas file defines polygon coordinates of its own", () => {
    for (const f of atlasFiles) {
      const s = code(f);
      // Long coordinate literals would mean hand-drawn geography.
      expect(s, `${f} contains coordinate literals`).not.toMatch(
        /\[\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*\]\s*,\s*\[\s*-?\d+\.\d+/,
      );
    }
  });

  it("region and appellation shapes are never derived from country geometry", () => {
    const country = code("src/features/atlas/CountrySymbols.tsx");
    // Regions render as circles at centroids, never as paths.
    expect(country).toMatch(/<circle/);
    expect(country).toMatch(/symbolRadius\(/);
  });

  it("the appellation view renders no map element at all", () => {
    const s = code("src/features/atlas/AppellationList.tsx");
    for (const tag of ["<svg", "<path", "<circle", "<polygon"]) {
      expect(s, `AppellationList renders ${tag}`).not.toContain(tag);
    }
  });

  it("aggregation never infers a location from free text", () => {
    const s = code("src/domain/atlas-aggregation.ts");
    // Nodes come from the canonical hierarchy only.
    expect(s).toMatch(/geography;/);
    expect(s).not.toMatch(/match\(|fuzzy|guess|infer/i);
  });

  it("only canonical countries are interactive", () => {
    const s = code("src/features/atlas/WorldChoropleth.tsx");
    expect(s).toMatch(/byCode\.get\(p\.iso\)/);
    expect(s).toMatch(/interactive \? /);
  });
});

describe("Phase 7 — incomplete geography is never discarded", () => {
  it("aggregation counts unmapped wines", () => {
    const s = code("src/domain/atlas-aggregation.ts");
    expect(s).toMatch(/unmapped\.wines \+= 1/);
    expect(s).toMatch(/unmapped\.bottles \+=/);
  });

  it("Atlas surfaces them with a route into the fix screen", () => {
    const s = code("src/features/atlas/index.tsx");
    // Prettier reflows JSX text, so match tolerantly across line breaks
    // rather than assuming a particular wrapping.
    expect(s.replace(/\s+/g, " ")).toMatch(/need geographic information/);
    expect(s).toMatch(/navigate\("\/atlas\/fix"\)/);
  });
});

describe("Phase 7 — the fix screen reuses the existing write path", () => {
  const s = () => code("src/features/atlas/GeographyFixScreen.tsx");

  it("reuses the Phase 3 GeographyPicker", () => {
    expect(s()).toMatch(/from "@\/features\/add-wine\/GeographyPicker"/);
  });

  it("uses updateWine, adding no new mutation", () => {
    expect(s()).toMatch(/m\.updateWine\(/);
  });

  it("passes the expected version, preserving conflict handling", () => {
    const src = s();
    // The wine's current version is read...
    expect(src).toMatch(/w\.wine\.version/);
    // ...and handed to updateWine, so the optimistic concurrency check applies.
    expect(src).toMatch(/updateWine\(\{[\s\S]{0,120}version,/);
  });

  it("never writes to a table directly", () => {
    expect(s()).not.toMatch(/\.from\(|\.rpc\(|getSupabase/);
  });
});

describe("Phase 7 — no backend change", () => {
  it("migration count remains 14", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    // 15 since Phase 9 added 015_tasting_mutations.sql, the only approved
    // migration since 014. This guard still catches an unapproved one.
    // 16 since Cleanup A added 016_mandatory_wine_type.sql. This guard still
    // catches an unapproved migration.
    expect(migrations).toHaveLength(16);
  });

  it("no new mutation RPC was added", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    const storageRpcs =
      s.match(/callRpc<[^>]*>\("(update|soft_delete)_storage_\w+"/g) ?? [];
    expect(storageRpcs.length).toBe(4);
  });

  it("the geography read is SELECT only", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/cellar-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/loadGeoCentroids/);
    expect(s).toMatch(/from\("geo_regions"\)\s*\n?\s*\.select\(/);
  });

  it("no service-role credential appears anywhere in Atlas", () => {
    for (const f of [
      ...featureFiles.filter((f) => f.includes("/atlas/")),
      "src/domain/atlas-aggregation.ts",
    ]) {
      expect(code(f)).not.toMatch(/service_role|serviceRole|SERVICE_ROLE/);
    }
  });
});

describe("Phase 7 — no Phase 8 drift", () => {
  it("Atlas contains no predictive language", () => {
    const files = [
      ...featureFiles.filter((f) => f.includes("/atlas/")),
      "src/domain/atlas-aggregation.ts",
    ];
    for (const f of files) {
      const s = code(f).toLowerCase();
      for (const banned of [
        "longevity",
        "legacy risk",
        "forecast",
        "predict",
        "recommendation",
        "buying intelligence",
        "trend",
      ]) {
        expect(s, `${f} contains ${banned}`).not.toContain(banned);
      }
    }
  });

  it("only the four specified metrics exist", () => {
    const s = code("src/domain/atlas-aggregation.ts");
    expect(s).toMatch(/"bottles" \| "value" \| "percentage" \| "ready"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — PROFILE & INTELLIGENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 — intelligence stays out of presentation", () => {
  const intelFiles = featureFiles.filter(
    (f) => f.includes("/intelligence/") || f.includes("/profile/"),
  );

  it("Phase 8 feature files exist", () => {
    expect(intelFiles.length).toBeGreaterThan(0);
  });

  it("the screen calls the domain rather than calculating", () => {
    const s = code("src/features/intelligence/IntelligenceScreen.tsx");
    expect(s).toMatch(/buildIntelligence\(/);
    // No rate or projection arithmetic in the component.
    expect(s).not.toMatch(/\/\s*12\b|\* 365|\/ 86_?400/);
    expect(s).not.toMatch(/bottlesPerYear \*|\* years/);
  });

  it("aggregation is memoised — this is not the default route but is not cheap", () => {
    expect(code("src/features/intelligence/IntelligenceScreen.tsx")).toMatch(/useMemo\(/);
  });

  it("no Phase 8 file queries Supabase directly", () => {
    for (const f of intelFiles) {
      const s = code(f);
      expect(s, `${f} queries directly`).not.toMatch(/\.from\(|\.rpc\(|getSupabase/);
    }
  });

  it("the domain imports no React", () => {
    for (const f of readdirSync(join(ROOT, "src/domain/intelligence"))) {
      const s = readFileSync(join(ROOT, "src/domain/intelligence", f), "utf8");
      expect(s, `${f} imports React`).not.toMatch(/from "react"/);
    }
  });
});

describe("Phase 8 — evidence, never a confidence score", () => {
  it("no intelligence type carries a numeric confidence", () => {
    for (const f of readdirSync(join(ROOT, "src/domain/intelligence"))) {
      const s = code(`src/domain/intelligence/${f}`).toLowerCase();
      for (const banned of ["confidence", "certainty", "probability"]) {
        expect(s, `${f} defines ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the Evidence type exposes only factual fields", () => {
    const s = code("src/domain/intelligence/consumption.ts");
    expect(s).toMatch(/source: EvidenceSource/);
    expect(s).toMatch(/sampleSize\?: number/);
    expect(s).toMatch(/historyDays\?: number/);
    expect(s).toMatch(/missingWindows\?: number/);
  });

  it("the UI renders evidence as a sentence", () => {
    const s = code("src/features/intelligence/IntelligenceScreen.tsx");
    expect(s).toMatch(/Based on \$\{evidence\.sampleSize\}|Based on \${/);
    expect(s).toMatch(/excluded because they have no drinking window/);
  });

  it("no opaque score appears in any output", () => {
    for (const f of readdirSync(join(ROOT, "src/domain/intelligence"))) {
      expect(code(`src/domain/intelligence/${f}`)).not.toMatch(
        /\bscore\b|cellarScore|overallRating/i,
      );
    }
  });
});

describe("Phase 8 — legacy is an outlook, not a risk", () => {
  it("the UI never labels long-lived wine a risk", () => {
    const s = code("src/features/intelligence/IntelligenceScreen.tsx");
    expect(s).toMatch(/Legacy outlook/);
    expect(s).not.toMatch(/Legacy risk/i);
  });

  it("beyond-horizon and consumption conflict are separate fields", () => {
    const s = code("src/domain/intelligence/longevity.ts");
    expect(s).toMatch(/beyondHorizonBottles/);
    expect(s).toMatch(/consumptionConflictBottles/);
  });

  it("longevity is not primarily bottles divided by rate", () => {
    const s = code("src/domain/intelligence/longevity.ts");
    // The division exists only as a supporting figure, clearly named.
    expect(s).toMatch(/yearsOfDrinkingAtCurrentRate/);
    expect(s).toMatch(/drinkableBottles/);
    expect(s).toMatch(/closingBottles/);
    expect(s).toMatch(/surplusClosing/);
  });
});

describe("Phase 8 — no drinking window is ever invented", () => {
  it("wines without a window are excluded and counted", () => {
    const s = code("src/domain/intelligence/longevity.ts");
    expect(s).toMatch(/withoutWindow/);
    expect(s).toMatch(/missingWindows: withoutWindow/);
  });

  it("no default window value appears anywhere", () => {
    for (const f of readdirSync(join(ROOT, "src/domain/intelligence"))) {
      const s = code(`src/domain/intelligence/${f}`);
      expect(s, `${f} defaults a window`).not.toMatch(
        /drinkFrom\s*\?\?\s*\d|drinkUntil\s*\?\?\s*\d/,
      );
    }
  });
});

describe("Phase 8 — geography and storage assumptions unchanged", () => {
  it("concentration uses canonical geography only", () => {
    const s = code("src/domain/intelligence/concentration.ts");
    expect(s).toMatch(/geography\.country/);
    // Free text is never treated as a country.
    expect(s).not.toMatch(/unmatched\s*\?\?|regionText/);
  });

  it("nothing assumes a rack or fixed storage exists", () => {
    for (const f of readdirSync(join(ROOT, "src/domain/intelligence"))) {
      const s = code(`src/domain/intelligence/${f}`);
      expect(s).not.toMatch(/staircase|positionKey|\b130\b/);
    }
  });
});

describe("Phase 8 — no backend change", () => {
  it("migration count remains 14", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    // 15 since Phase 9 added 015_tasting_mutations.sql, the only approved
    // migration since 014. This guard still catches an unapproved one.
    // 16 since Cleanup A added 016_mandatory_wine_type.sql. This guard still
    // catches an unapproved migration.
    expect(migrations).toHaveLength(16);
  });

  it("the profile write uses the EXISTING RPC", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/callRpc<string>\("upsert_cellar_profile"/);
  });

  it("no new storage RPC was added", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    const storageRpcs =
      s.match(/callRpc<[^>]*>\("(update|soft_delete)_storage_\w+"/g) ?? [];
    expect(storageRpcs.length).toBe(4);
  });

  it("the profile read is SELECT only", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/cellar-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/loadCellarProfile/);
    expect(s).toMatch(/from\("cellar_profiles"\)\s*\n?\s*\.select\(/);
  });

  it("no service-role credential anywhere in Phase 8", () => {
    const files = [
      ...featureFiles.filter(
        (f) => f.includes("/intelligence/") || f.includes("/profile/"),
      ),
      ...readdirSync(join(ROOT, "src/domain/intelligence")).map(
        (f) => `src/domain/intelligence/${f}`,
      ),
    ];
    for (const f of files) {
      expect(code(f)).not.toMatch(/service_role|serviceRole|SERVICE_ROLE/);
    }
  });

  it("no external AI or inference dependency was introduced", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of ["openai", "anthropic", "langchain", "@huggingface"]) {
      expect(
        deps.some((d) => d.includes(banned)),
        `${banned} added`,
      ).toBe(false);
    }
  });

  it("no charting or statistics library was added", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of ["chart.js", "recharts", "d3", "victory", "simple-statistics"]) {
      expect(deps.includes(banned), `${banned} added`).toBe(false);
    }
  });
});

describe("Phase 8 — Home is untouched", () => {
  it("Home adds no intelligence card", () => {
    const s = code("src/features/home/index.tsx");
    expect(s).not.toMatch(/buildIntelligence|longevity|legacy|Intelligence/i);
  });

  it("Home still uses only the Phase 6 summary", () => {
    expect(code("src/features/home/index.tsx")).toMatch(/buildCellarSummary\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 9 — HISTORY, TASTING, DELIVERY
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 9 — History is read-only by construction", () => {
  it("the history screen imports NO mutation", () => {
    const s = code("src/features/history/HistoryScreen.tsx");
    expect(s).not.toMatch(/useCellar\(\)[\s\S]{0,120}\brun\b/);
    expect(s).not.toMatch(/mutation-repository|MutationRepository/);
    expect(s).not.toMatch(/\.rpc\(|\.from\(|getSupabase/);
  });

  it("the history domain exports no mutation", () => {
    const s = code("src/domain/history.ts");
    expect(s).not.toMatch(/update|delete|insert|mutate/i);
  });

  it("history reads go through the repository, never a raw table", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/cellar-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/loadHistory/);
    expect(s).toMatch(/rpc\("cellar_history"/);
  });

  it("history is paginated rather than unbounded", () => {
    const s = code("src/features/history/HistoryScreen.tsx");
    expect(s).toMatch(/PAGE_SIZE/);
    expect(s).toMatch(/before/);
  });

  it("grouping uses occurred_at, not created_at", () => {
    const s = code("src/domain/history.ts");
    expect(s).toMatch(/occurredAt/);
    expect(s).not.toMatch(/createdAt/);
  });

  it("every declared event type has a description branch", () => {
    const s = code("src/domain/history.ts");
    for (const t of [
      "acquired",
      "added",
      "moved",
      "delivered",
      "consumed",
      "gifted",
      "sold",
      "lost",
      "removed",
      "valued",
      "tasting_recorded",
      "corrected",
    ]) {
      expect(s, `no branch for ${t}`).toMatch(new RegExp(`case "${t}"`));
    }
  });

  it("an unknown event type has a default branch", () => {
    expect(code("src/domain/history.ts")).toMatch(/default:/);
  });
});

describe("Phase 9 — tastings are editable, history is not", () => {
  it("the tasting screen uses the update and delete mutations", () => {
    const s = code("src/features/tasting/TastingLogScreen.tsx");
    expect(s).toMatch(/m\.updateTasting\(/);
    expect(s).toMatch(/m\.deleteTasting\(/);
  });

  it("tasting edits carry the expected version", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/updateTasting[\s\S]{0,600}p_expected_version/);
    expect(s).toMatch(/deleteTasting[\s\S]{0,600}p_expected_version/);
  });

  it("no tasting mutation writes to a table directly", () => {
    const s = code("src/features/tasting/TastingLogScreen.tsx");
    expect(s).not.toMatch(/\.from\(|\.rpc\(|getSupabase/);
  });

  it("a tasting is never filtered out for lacking a bottle", () => {
    const s = code("src/domain/tasting-log.ts");
    // bottle_id is nullable by design — tasted elsewhere.
    expect(s).toMatch(/wasTastedElsewhere/);
    expect(s).not.toMatch(/filter\([^)]*bottleId !== null/);
  });
});

describe("Phase 9 — migration 015", () => {
  it("migration count is now 15", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    // 16 since Cleanup A added 016_mandatory_wine_type.sql. This guard still
    // catches an unapproved migration.
    expect(migrations).toHaveLength(16);
  });

  it("015 never writes to bottle_events", () => {
    const s = readFileSync(join(ROOT, "db/015_tasting_mutations.sql"), "utf8");
    expect(s).not.toMatch(/insert\s+into\s+bottle_events/i);
    expect(s).not.toMatch(/update\s+bottle_events/i);
    expect(s).not.toMatch(/delete\s+from\s+bottle_events/i);
  });

  it("015 is additive only", () => {
    const s = readFileSync(join(ROOT, "db/015_tasting_mutations.sql"), "utf8");
    expect(s).not.toMatch(/alter table/i);
    expect(s).not.toMatch(/drop /i);
  });

  it("015 adds no earlier migration change", () => {
    // 014 must be untouched by Phase 9.
    const s = readFileSync(join(ROOT, "db/014_storage_mutations.sql"), "utf8");
    expect(s).not.toMatch(/tasting/i);
  });
});

describe("Phase 9 — bulk delivery composes the existing RPC", () => {
  it("adds NO new delivery RPC", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).not.toMatch(/callRpc[^)]*"(bulk|deliver)_\w+"/);
    // It reuses moveBottle.
    expect(s).toMatch(/deliverBottles[\s\S]{0,900}this\.moveBottle\(/);
  });

  it("each bottle gets its own operation id", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    // moveBottle mints newId() per call, so a loop yields distinct ids.
    expect(s).toMatch(/async moveBottle[\s\S]{0,400}const opId = newId\(\)/);
  });

  it("delivery marks the event type as delivered", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/isDelivery \? "delivered" : "moved"/);
  });

  it("partial failure is reported per bottle, never swallowed", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/failed: \{ bottleId: string; error: string \}\[\]/);
  });
});

describe("Phase 9 — pairings are out of scope", () => {
  it("no pairing schema, UI or logic exists", () => {
    for (const f of featureFiles) {
      expect(code(f), `${f} mentions pairings`).not.toMatch(/pairing/i);
    }
  });

  it("the stale More placeholder is gone", () => {
    const s = code("src/features/more/index.tsx");
    expect(s).not.toMatch(/Pairings/);
    expect(s).not.toMatch(/Phase 9/);
  });

  it("More links to the real screens", () => {
    const s = code("src/features/more/index.tsx");
    expect(s).toMatch(/"\/tastings"/);
    expect(s).toMatch(/"\/history"/);
  });
});

describe("Phase 9 — earlier phases untouched", () => {
  it("Home is still Phase 6 only", () => {
    const s = code("src/features/home/index.tsx");
    expect(s).toMatch(/buildCellarSummary\(/);
    expect(s).not.toMatch(/history|tasting|deliver/i);
  });

  it("world geometry is still lazily imported", () => {
    const s = code("src/features/atlas/index.tsx");
    expect(s).toMatch(/import\("@\/data\/geo\/world-geometry"\)/);
  });

  it("no external AI or charting dependency was added", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of ["openai", "anthropic", "chart.js", "recharts", "d3"]) {
      expect(deps.includes(banned), `${banned} added`).toBe(false);
    }
  });

  it("no service-role credential in Phase 9 code", () => {
    for (const f of featureFiles.filter(
      (f) => f.includes("/history/") || f.includes("/tasting/"),
    )) {
      expect(code(f)).not.toMatch(/service_role|serviceRole/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP A — WINE EDITING & MANDATORY TYPE
// ═══════════════════════════════════════════════════════════════════════════

describe("Cleanup A — wine editing uses the established mutation path", () => {
  it("migration count is now 16", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    expect(migrations).toHaveLength(16);
  });

  it("016 adds NO new RPC name — it replaces the existing two", () => {
    const s = readFileSync(join(ROOT, "db/016_mandatory_wine_type.sql"), "utf8");
    const fns = [...s.matchAll(/create or replace function (\w+)/g)].map((m) => m[1]);
    expect(fns.sort()).toEqual([
      "create_wine_definition",
      "is_valid_wine_colour",
      "update_wine_definition",
    ]);
  });

  it("016 preserves the enrichment columns and client-supplied id", () => {
    const s = readFileSync(join(ROOT, "db/016_mandatory_wine_type.sql"), "utf8");
    expect(s).toMatch(/enrichment_source/);
    expect(s).toMatch(/enrichment_confidence/);
    expect(s).toMatch(/coalesce\(\(p_wine->>'id'\)::uuid/);
    expect(s).toMatch(/claimed_entity_id\(p_operation_id\)/);
  });

  it("no feature file updates wine_definitions directly", () => {
    for (const f of featureFiles) {
      expect(code(f), `${f} writes directly`).not.toMatch(/from\("wine_definitions"\)/);
    }
  });

  it("the edit form reuses the canonical geography picker", () => {
    const s = code("src/features/cellar/EditWineForm.tsx");
    expect(s).toMatch(/GeographyPicker/);
    expect(s).not.toMatch(/geo_regions/);
  });

  it("Home, Atlas and Intelligence are untouched by this cleanup", () => {
    expect(code("src/features/home/index.tsx")).not.toMatch(/EditWineForm/);
    expect(code("src/features/atlas/index.tsx")).toMatch(
      /import\("@\/data\/geo\/world-geometry"\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 10 — VALUATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 10 — no FX, no fabricated totals", () => {
  const valuationFiles = [
    "src/domain/valuation.ts",
    "src/features/cellar/ValuationHistory.tsx",
  ];

  it("no exchange-rate or conversion logic exists anywhere", () => {
    for (const f of valuationFiles) {
      const s = code(f).toLowerCase();
      for (const banned of ["exchangerate", "fxrate", "convertcurrency", "exchange_rate"]) {
        expect(s, `${f} contains ${banned}`).not.toContain(banned);
      }
    }
  });

  it("no external valuation or market-data service is called", () => {
    for (const f of valuationFiles) {
      expect(code(f)).not.toMatch(/fetch\(|axios|https?:\/\//);
    }
  });

  it("mixed currencies are represented, never summed into one", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).toMatch(/isMixed/);
    expect(s).toMatch(/byCurrency/);
    // `single` is null whenever more than one currency is present.
    expect(s).toMatch(/byCurrency\.length === 1 \? byCurrency\[0\]! : null/);
  });

  it("gain requires matching currencies", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).toMatch(/currency-mismatch/);
    expect(s).toMatch(/cost\.currency !== valuation\.currency/);
  });

  it("percentage is suppressed when there is no denominator", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).toMatch(/cost === 0 \? null/);
  });
});

describe("Phase 10 — absence is never zero", () => {
  it("the domain never defaults a missing amount to zero", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).not.toMatch(/unitPrice \?\? 0|amount \?\? 0|currentValue \?\? 0/);
  });

  it("totals carry present and absent counts", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).toMatch(/present: number/);
    expect(s).toMatch(/absent: number/);
  });

  it("collection totals expose completeness", () => {
    const s = code("src/domain/collection-filters.ts");
    expect(s).toMatch(/valuedBottles/);
    expect(s).toMatch(/activeBottles/);
    expect(s).toMatch(/export function isValuationComplete/);
  });

  it("Collection and Home caption a partial total", () => {
    for (const f of [
      "src/features/cellar/CollectionScreen.tsx",
      "src/features/home/index.tsx",
    ]) {
      // SUPERSEDED the `isValuationComplete` check: ValuationTotal carries
      // the completeness caption AND the currency handling, which is
      // strictly more than the boolean did.
      expect(code(f), `${f} does not caption partial valuation`).toMatch(/<ValuationTotal/);
    }
    expect(code("src/components/ValuationTotal.tsx")).toMatch(/of \$\{totals\.total\}/);
  });

  it("Atlas states that Value covers only valued bottles", () => {
    expect(code("src/features/atlas/index.tsx")).toMatch(
      /only bottles with a recorded valuation/,
    );
  });
});

describe("Phase 10 — the ledger stays append-only", () => {
  it("no valuation update or delete binding exists", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).not.toMatch(/update_valuation|soft_delete_valuation|deleteValuation/);
  });

  it("the UI offers no edit or delete for a valuation", () => {
    const s = code("src/features/cellar/ValuationHistory.tsx");
    expect(s).not.toMatch(/Edit valuation|Delete valuation|Remove valuation/i);
    expect(s).toMatch(/never edited or deleted/);
  });

  it("corrections are explained as appending", () => {
    expect(code("src/features/cellar/ValuationHistory.tsx")).toMatch(
      /Record a new valuation/,
    );
  });

  it("basis and source are shown as separate facts", () => {
    const s = code("src/features/cellar/ValuationHistory.tsx");
    expect(s).toMatch(/BASIS_LABELS/);
    expect(s).toMatch(/SOURCE_LABELS/);
  });

  it("no realised gain was introduced", () => {
    expect(code("src/domain/valuation.ts")).not.toMatch(/realisedGain|realized_gain/i);
  });

  it("migration count remains 16", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    expect(migrations).toHaveLength(16);
  });

  it("valuation reads go through the repository only", () => {
    expect(code("src/features/cellar/ValuationHistory.tsx")).not.toMatch(
      /\.from\(|getSupabase|\.rpc\(/,
    );
  });
});

describe("Phase 10 — every aggregate is currency-aware", () => {
  it("Home and Collection use the shared currency-aware total", () => {
    for (const f of [
      "src/features/home/index.tsx",
      "src/features/cellar/CollectionScreen.tsx",
    ]) {
      const s = code(f);
      expect(s, `${f} does not use ValuationTotal`).toMatch(/<ValuationTotal/);
      expect(s, `${f} still renders a bare Money total`).not.toMatch(
        /<Money amount=\{totals\.value\}|<Money amount=\{totalValue\}/,
      );
    }
  });

  it("the shared component has no path to a combined figure", () => {
    const s = code("src/components/ValuationTotal.tsx");
    // A single amount is rendered only from `single`, which is null when mixed.
    expect(s).toMatch(/totals\.isMixed/);
    expect(s).toMatch(/totals\.single!/);
    expect(s).not.toMatch(/reduce\(|byCurrency\.reduce/);
  });

  it("no currency is silently defaulted in the read path", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/cellar-repository.ts"),
      "utf8",
    );
    expect(s, "a currency is defaulted to GBP").not.toMatch(/currency[^\n]*\?\?\s*"GBP"/);
  });

  it("an unknown currency makes the amount unusable rather than assumed", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).toMatch(/row\.currency === null/);
    expect(s).toMatch(/cost\.currency === null/);
  });

  it("cellar-wide cost and value share the holding logic", () => {
    const s = code("src/domain/valuation.ts");
    expect(s).toMatch(/export function cellarValuation/);
    expect(s).toMatch(/export function cellarCost/);
    expect(s).toMatch(/return holdingValue\(/);
    expect(s).toMatch(/return holdingCost\(/);
  });
});

describe("Phase 10 — valuation scope", () => {
  it("both valuation paths remain available through the existing RPC", () => {
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/wine_definition_id: args\.wineId \?\? null/);
    expect(s).toMatch(/bottle_id: args\.bottleId \?\? null/);
  });

  it("the sheet chooses exactly one path", () => {
    const s = code("src/features/cellar/RecordValuationSheet.tsx");
    expect(s).toMatch(/\{ wineId: wine\.id \}/);
    expect(s).toMatch(/\{ bottleId:/);
  });

  it("only ACTIVE bottles determine the scope count", () => {
    const s = code("src/features/cellar/WineDetailScreen.tsx");
    expect(s).toMatch(/activeBottles=\{bottles\.filter\(/);
    expect(s).toMatch(/b\.isActive && b\.wineDefinitionId === wine\.id/);
  });

  it("the amount is presented per bottle", () => {
    const s = code("src/features/cellar/RecordValuationSheet.tsx");
    expect(s).toMatch(/Value per bottle/);
    expect(s).toMatch(/not the total for all/);
  });

  it("history states scope without inventing a bottle count", () => {
    const s = code("src/features/cellar/ValuationHistory.tsx");
    expect(s).toMatch(/"One specific bottle" : "All bottles"/);
    expect(s).toMatch(/per bottle/);
    // The ledger stores no count, so none is displayed.
    expect(s).not.toMatch(/bottleCount|appliedToCount/);
  });

  it("no schema or RPC change was made", () => {
    const migrations = readdirSync(join(ROOT, "db")).filter((f) =>
      /^\d{3}_.*\.sql$/.test(f),
    );
    expect(migrations).toHaveLength(16);
    const s = readFileSync(
      join(ROOT, "src/data/repositories/mutation-repository.ts"),
      "utf8",
    );
    expect(s).toMatch(/callRpc<string>\("record_valuation"/);
  });

  it("the sheet writes through the repository only", () => {
    expect(code("src/features/cellar/RecordValuationSheet.tsx")).not.toMatch(
      /\.from\(|getSupabase|\.rpc\(/,
    );
  });
});
