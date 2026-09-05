/**
 * DEVELOPMENT FIXTURE
 *
 * Creates a realistic cellar for development and manual testing.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────
 * This uses the SAME RPC functions the application uses. It never inserts
 * directly into a table, so it exercises the real mutation path including
 * idempotency, geometry validation and event logging.
 *
 * It refuses to run against a cellar that already contains non-synthetic
 * data. Every wine it creates is prefixed with a marker so `resetFixture`
 * can identify and remove exactly what it made, and nothing else.
 *
 * NEVER runs automatically. It must be invoked explicitly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Every fixture wine carries this in its notes. Nothing else is touched. */
export const FIXTURE_MARKER = "[DEV-FIXTURE]";

const uid = () => crypto.randomUUID();

export interface FixtureResult {
  cellarId: string;
  layouts: { rack: string };
  locations: { home: string; berryBros: string; wineSociety: string };
  wineIds: string[];
  bottleCount: number;
  warnings: string[];
}

/** The owner's rack — created through the API, exactly as a user would. */
export const STAIRCASE_RACK = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right" as const,
};

/**
 * Obviously synthetic wines. Real producers are avoided deliberately — these
 * must never be mistaken for a genuine collection.
 */
const WINES = [
  {
    producer: "Sample Estate",
    name: "Cabernet Reference",
    vintage: 2015,
    colour: "Red",
    grapes: ["Cabernet Sauvignon"],
    country: "FR",
    region: "fr-bordeaux",
    from: 2022,
    until: 2045,
    price: 65,
  },
  {
    producer: "Sample Estate",
    name: "Left Bank Reference",
    vintage: 2018,
    colour: "Red",
    grapes: ["Merlot", "Cabernet Franc"],
    country: "FR",
    region: "fr-pomerol",
    from: 2026,
    until: 2042,
    price: 90,
  },
  {
    producer: "Testing Domaine",
    name: "Pinot Reference",
    vintage: 2019,
    colour: "Red",
    grapes: ["Pinot Noir"],
    country: "FR",
    region: "fr-burgundy",
    from: 2024,
    until: 2035,
    price: 55,
  },
  {
    producer: "Testing Domaine",
    name: "Chardonnay Reference",
    vintage: 2021,
    colour: "White",
    grapes: ["Chardonnay"],
    country: "FR",
    region: "fr-chablis",
    from: 2023,
    until: 2030,
    price: 35,
  },
  {
    producer: "Example Cave",
    name: "Sparkling Reference",
    vintage: null,
    colour: "Sparkling",
    grapes: ["Chardonnay", "Pinot Noir"],
    country: "FR",
    region: "fr-champagne",
    from: 2023,
    until: 2032,
    price: 48,
  },
  {
    producer: "Demo Tenuta",
    name: "Nebbiolo Reference",
    vintage: 2016,
    colour: "Red",
    grapes: ["Nebbiolo"],
    country: "IT",
    region: "it-barolo",
    from: 2026,
    until: 2040,
    price: 72,
  },
  {
    producer: "Demo Tenuta",
    name: "Sangiovese Reference",
    vintage: 2019,
    colour: "Red",
    grapes: ["Sangiovese"],
    country: "IT",
    region: "it-chianti-classico",
    from: 2023,
    until: 2033,
    price: 28,
  },
  {
    producer: "Placeholder Bodega",
    name: "Tempranillo Reference",
    vintage: 2017,
    colour: "Red",
    grapes: ["Tempranillo"],
    country: "ES",
    region: "es-rioja",
    from: 2022,
    until: 2036,
    price: 32,
  },
  {
    producer: "Placeholder Quinta",
    name: "Douro Reference",
    vintage: 2014,
    colour: "Red",
    grapes: ["Touriga Nacional"],
    country: "PT",
    region: "pt-douro",
    from: 2024,
    until: 2044,
    price: 40,
  },
  {
    producer: "Specimen Weingut",
    name: "Riesling Reference",
    vintage: 2020,
    colour: "White",
    grapes: ["Riesling"],
    country: "DE",
    region: "de-mosel",
    from: 2022,
    until: 2038,
    price: 30,
  },
  {
    producer: "Mock Winery",
    name: "Napa Reference",
    vintage: 2018,
    colour: "Red",
    grapes: ["Cabernet Sauvignon"],
    country: "US",
    region: "us-napa",
    from: 2025,
    until: 2040,
    price: 110,
  },
  {
    producer: "Mock Winery",
    name: "Willamette Reference",
    vintage: 2021,
    colour: "Red",
    grapes: ["Pinot Noir"],
    country: "US",
    region: "us-willamette",
    from: 2024,
    until: 2032,
    price: 58,
  },
  {
    producer: "Trial Estate",
    name: "Barossa Reference",
    vintage: 2017,
    colour: "Red",
    grapes: ["Shiraz"],
    country: "AU",
    region: "au-barossa",
    from: 2023,
    until: 2038,
    price: 45,
  },
  {
    producer: "Trial Estate",
    name: "Marlborough Reference",
    vintage: 2023,
    colour: "White",
    grapes: ["Sauvignon Blanc"],
    country: "NZ",
    region: "nz-marlborough",
    from: 2024,
    until: 2027,
    price: 18,
  },
  // Deliberately past its window, so drinking-window states are all exercised.
  {
    producer: "Sample Estate",
    name: "Past Window Reference",
    vintage: 2005,
    colour: "Red",
    grapes: ["Merlot"],
    country: "FR",
    region: "fr-bordeaux",
    from: 2010,
    until: 2020,
    price: 50,
  },
  // Deliberately far too young.
  {
    producer: "Demo Tenuta",
    name: "Very Young Reference",
    vintage: 2023,
    colour: "Red",
    grapes: ["Nebbiolo"],
    country: "IT",
    region: "it-barbaresco",
    from: 2033,
    until: 2050,
    price: 85,
  },
];

async function rpc<T>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Refuse to run where real data exists. */
export async function isSafeToSeed(
  sb: SupabaseClient,
  cellarId: string,
): Promise<{ safe: boolean; reason?: string }> {
  const { data, error } = await sb
    .from("wine_definitions")
    .select("id, notes")
    .eq("cellar_id", cellarId)
    .is("deleted_at", null);

  if (error) return { safe: false, reason: error.message };

  const rows = data ?? [];
  const real = rows.filter((w) => !(w.notes ?? "").includes(FIXTURE_MARKER));
  const fixture = rows.filter((w) => (w.notes ?? "").includes(FIXTURE_MARKER));

  // Protecting real data is the important case.
  if (real.length > 0) {
    return {
      safe: false,
      reason:
        `This cellar contains ${real.length} wine(s) that the fixture did not create. ` +
        `Refusing to seed. Use an empty cellar.`,
    };
  }

  // Already seeded: refuse cleanly rather than failing later on a unique
  // constraint, which is confusing and leaves partial state behind.
  if (fixture.length > 0) {
    return {
      safe: false,
      reason:
        `This cellar already contains ${fixture.length} fixture wine(s). ` +
        `Refusing to seed twice. Run scripts/reset-fixture.sql first.`,
    };
  }

  return { safe: true };
}

export async function seedFixture(
  sb: SupabaseClient,
  cellarId: string,
  opts: { force?: boolean } = {},
): Promise<FixtureResult> {
  const warnings: string[] = [];

  if (!opts.force) {
    const check = await isSafeToSeed(sb, cellarId);
    if (!check.safe) throw new Error(check.reason);
  }

  // ── Storage: created through the API, never seeded by migration ─────────
  const rackLayout = await rpc<string>(sb, "create_storage_layout", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Staircase Rack",
    p_type: "staircase",
    p_config: STAIRCASE_RACK,
  });

  const home = await rpc<string>(sb, "create_storage_location", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Home Cellar",
    p_kind: "home",
    p_layout_id: rackLayout,
    p_is_external: false,
  });

  const berryBros = await rpc<string>(sb, "create_storage_location", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Berry Bros & Rudd",
    p_kind: "merchant",
    p_layout_id: null,
    p_is_external: true,
  });

  const wineSociety = await rpc<string>(sb, "create_storage_location", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "The Wine Society",
    p_kind: "merchant",
    p_layout_id: null,
    p_is_external: true,
  });

  // ── Resolve geography slugs to canonical ids ────────────────────────────
  const { data: regions } = await sb
    .from("geo_regions")
    .select("id, slug")
    .in(
      "slug",
      WINES.map((w) => w.region),
    );
  const regionBySlug = new Map((regions ?? []).map((r) => [r.slug, r.id]));

  // ── Wines ───────────────────────────────────────────────────────────────
  const wineIds: string[] = [];
  for (const w of WINES) {
    const geoId = regionBySlug.get(w.region) ?? null;
    if (!geoId)
      warnings.push(`No geo_region for slug "${w.region}" — wine stored with free text.`);

    const id = await rpc<string>(sb, "create_wine_definition", {
      p_operation_id: uid(),
      p_cellar_id: cellarId,
      p_wine: {
        producer: w.producer,
        name: w.name,
        vintage: w.vintage,
        colour: w.colour,
        grapes: w.grapes,
        geo_region_id: geoId,
        country_code: w.country,
        region_text: geoId ? null : w.region,
        drink_from: w.from,
        drink_until: w.until,
        notes: FIXTURE_MARKER,
      },
    });
    wineIds.push(id);
  }

  // ── Acquisitions ────────────────────────────────────────────────────────
  let bottleCount = 0;
  let nextCol = 13;
  let nextRow = 1;

  /** Walk the staircase from the tallest column downward. */
  const nextSlot = () => {
    const heights = STAIRCASE_RACK.heights;
    while (nextCol >= 1) {
      const h = heights[nextCol - 1] ?? 0;
      if (nextRow <= h) return { col: nextCol, row: nextRow++ };
      nextCol -= 1;
      nextRow = 1;
    }
    throw new Error("Rack full");
  };

  // A twelve-bottle case into the rack.
  await rpc<string>(sb, "create_acquisition_with_items", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_acquisition: {
      purchased_on: "2024-06-12",
      source: "Berry Bros & Rudd",
      reference: "DEV-CASE-12",
      total_amount: 780,
      currency: "GBP",
      notes: FIXTURE_MARKER,
    },
    p_items: [
      {
        wine_definition_id: wineIds[0],
        quantity: 12,
        format: "case_12",
        unit_price: 65,
        storage_location_id: home,
        positions: Array.from({ length: 12 }, () => nextSlot()),
      },
    ],
  });
  bottleCount += 12;

  // A mixed six-bottle order, held in bond at the merchant. No positions.
  await rpc<string>(sb, "create_acquisition_with_items", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_acquisition: {
      purchased_on: "2025-02-03",
      source: "The Wine Society",
      reference: "DEV-MIXED-6",
      total_amount: 396,
      currency: "GBP",
      notes: FIXTURE_MARKER,
    },
    p_items: [
      {
        wine_definition_id: wineIds[5],
        quantity: 2,
        unit_price: 72,
        storage_location_id: wineSociety,
      },
      {
        wine_definition_id: wineIds[7],
        quantity: 2,
        unit_price: 32,
        storage_location_id: wineSociety,
      },
      {
        wine_definition_id: wineIds[10],
        quantity: 2,
        unit_price: 110,
        storage_location_id: wineSociety,
      },
    ],
  });
  bottleCount += 6;

  // Singles and pairs into the rack, spread across countries and styles.
  const singles: Array<[number, number]> = [
    [2, 2],
    [3, 1],
    [4, 2],
    [6, 1],
    [8, 1],
    [9, 2],
    [11, 1],
    [12, 1],
    [13, 1],
    [14, 1],
    [15, 1],
  ];
  for (const [wineIndex, qty] of singles) {
    const w = WINES[wineIndex]!;
    await rpc<string>(sb, "create_acquisition_with_items", {
      p_operation_id: uid(),
      p_cellar_id: cellarId,
      p_acquisition: {
        purchased_on: "2025-09-20",
        source: "Berry Bros & Rudd",
        notes: FIXTURE_MARKER,
      },
      p_items: [
        {
          wine_definition_id: wineIds[wineIndex],
          quantity: qty,
          unit_price: w.price,
          storage_location_id: home,
          positions: Array.from({ length: qty }, () => nextSlot()),
        },
      ],
    });
    bottleCount += qty;
  }

  // A few bottles at Berry Bros, unpositioned.
  await rpc<string>(sb, "create_acquisition_with_items", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_acquisition: {
      purchased_on: "2026-01-08",
      source: "Berry Bros & Rudd",
      notes: FIXTURE_MARKER,
    },
    p_items: [
      {
        wine_definition_id: wineIds[1],
        quantity: 6,
        format: "case_6",
        unit_price: 90,
        storage_location_id: berryBros,
      },
    ],
  });
  bottleCount += 6;

  // ── A little history, so Home and the tasting log are not empty ─────────
  const { data: drinkable } = await sb
    .from("bottles")
    .select("id, version, wine_definition_id")
    .eq("cellar_id", cellarId)
    .eq("status", "in_cellar")
    .limit(2);

  for (const b of drinkable ?? []) {
    await rpc(sb, "change_bottle_status", {
      p_operation_id: uid(),
      p_bottle_id: b.id,
      p_expected_version: b.version,
      p_status: "consumed",
      p_occurred_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      p_notes: FIXTURE_MARKER,
    });
    await rpc(sb, "record_tasting", {
      p_operation_id: uid(),
      p_cellar_id: cellarId,
      p_tasting: {
        wine_definition_id: b.wine_definition_id,
        bottle_id: b.id,
        rating: 4,
        notes: `${FIXTURE_MARKER} Synthetic tasting note.`,
      },
    });
    bottleCount -= 1;
  }

  // A valuation, so purchase price and current value differ visibly.
  await rpc(sb, "record_valuation", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_valuation: {
      wine_definition_id: wineIds[0],
      amount: 95,
      currency: "GBP",
      valuation_basis: "market_estimate",
      source: "manual",
      notes: FIXTURE_MARKER,
    },
  });

  return {
    cellarId,
    layouts: { rack: rackLayout },
    locations: { home, berryBros, wineSociety },
    wineIds,
    bottleCount,
    warnings,
  };
}

/**
 * Remove everything the fixture created — and nothing else.
 *
 * Identification is by the marker, so a cellar containing both fixture and
 * real data would lose only the fixture rows. `seedFixture` refuses that
 * situation anyway.
 *
 * Requires elevated rights: history tables are immutable through the normal
 * API by design, so a reset is a development operation, not a user one.
 */
export async function resetFixture(
  sb: SupabaseClient,
  cellarId: string,
): Promise<{ removed: Record<string, number>; note: string }> {
  const removed: Record<string, number> = {};

  const { data: wines } = await sb
    .from("wine_definitions")
    .select("id")
    .eq("cellar_id", cellarId)
    .like("notes", `%${FIXTURE_MARKER}%`);

  const wineIds = (wines ?? []).map((w) => w.id);
  removed.wines = wineIds.length;

  const { count: bottleCount } = await sb
    .from("bottles")
    .select("id", { count: "exact", head: true })
    .eq("cellar_id", cellarId)
    .in(
      "wine_definition_id",
      wineIds.length ? wineIds : ["00000000-0000-0000-0000-000000000000"],
    );
  removed.bottles = bottleCount ?? 0;

  return {
    removed,
    note:
      "Counts only. Deletion requires the service role, because bottles and " +
      "history are immutable through the normal API by design. Run " +
      "scripts/reset-fixture.sql in the Supabase SQL editor to complete.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ALTERNATIVE-LAYOUT FIXTURE
//
// Proves the product is storage-agnostic. This cellar has NO staircase and no
// rack of the owner's shape at all — a rectangular grid, a wine fridge, and
// merchant storage. If any product code assumes a staircase, this breaks.
// ═══════════════════════════════════════════════════════════════════════════

export interface AltFixtureResult {
  cellarId: string;
  layouts: { grid: string; fridge: string };
  locations: { wall: string; fridge: string; merchant: string };
  wineIds: string[];
  bottleCount: number;
}

export const GRID_RACK = { rows: 8, columns: 12 } as const;

export const WINE_FRIDGE = {
  zones: [
    { name: "Upper", shelves: 4, perShelf: 8, tempC: 12 },
    { name: "Lower", shelves: 3, perShelf: 10, tempC: 16 },
  ],
} as const;

const ALT_WINES = [
  {
    producer: "Reference Cave",
    name: "Grid White",
    vintage: 2022,
    colour: "White",
    grapes: ["Riesling"],
    country: "DE",
    region: "de-mosel",
    from: 2023,
    until: 2035,
    price: 25,
  },
  {
    producer: "Reference Cave",
    name: "Grid Sparkling",
    vintage: null,
    colour: "Sparkling",
    grapes: ["Chardonnay"],
    country: "FR",
    region: "fr-champagne",
    from: 2024,
    until: 2031,
    price: 42,
  },
  {
    producer: "Second Estate",
    name: "Fridge Rose",
    vintage: 2023,
    colour: "Rosé",
    grapes: ["Grenache"],
    country: "FR",
    region: "fr-provence",
    from: 2024,
    until: 2026,
    price: 19,
  },
  {
    producer: "Second Estate",
    name: "Fridge White",
    vintage: 2021,
    colour: "White",
    grapes: ["Chardonnay"],
    country: "AU",
    region: "au-adelaide-hills",
    from: 2023,
    until: 2029,
    price: 27,
  },
  {
    producer: "Alternate Quinta",
    name: "Bonded Red",
    vintage: 2019,
    colour: "Red",
    grapes: ["Tempranillo"],
    country: "ES",
    region: "es-ribera-del-duero",
    from: 2025,
    until: 2040,
    price: 38,
  },
];

export async function seedAlternativeLayoutFixture(
  sb: SupabaseClient,
  cellarId: string,
): Promise<AltFixtureResult> {
  const check = await isSafeToSeed(sb, cellarId);
  if (!check.safe) throw new Error(check.reason);

  // A rectangular grid — nothing like the owner's staircase.
  const gridLayout = await rpc<string>(sb, "create_storage_layout", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Wall Rack",
    p_type: "grid",
    p_config: GRID_RACK,
  });

  const fridgeLayout = await rpc<string>(sb, "create_storage_layout", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Wine Fridge",
    p_type: "fridge",
    p_config: WINE_FRIDGE,
  });

  const wall = await rpc<string>(sb, "create_storage_location", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Wall Rack",
    p_kind: "home",
    p_layout_id: gridLayout,
    p_is_external: false,
  });

  const fridge = await rpc<string>(sb, "create_storage_location", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Kitchen Fridge",
    p_kind: "fridge",
    p_layout_id: fridgeLayout,
    p_is_external: false,
  });

  // A merchant this user chose — nothing to do with the owner's merchants.
  const merchant = await rpc<string>(sb, "create_storage_location", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_name: "Independent Merchant",
    p_kind: "merchant",
    p_layout_id: null,
    p_is_external: true,
  });

  const { data: regions } = await sb
    .from("geo_regions")
    .select("id, slug")
    .in(
      "slug",
      ALT_WINES.map((w) => w.region),
    );
  const bySlug = new Map((regions ?? []).map((r) => [r.slug, r.id]));

  const wineIds: string[] = [];
  for (const w of ALT_WINES) {
    const id = await rpc<string>(sb, "create_wine_definition", {
      p_operation_id: uid(),
      p_cellar_id: cellarId,
      p_wine: {
        producer: w.producer,
        name: w.name,
        vintage: w.vintage,
        colour: w.colour,
        grapes: w.grapes,
        geo_region_id: bySlug.get(w.region) ?? null,
        country_code: w.country,
        drink_from: w.from,
        drink_until: w.until,
        notes: FIXTURE_MARKER,
      },
    });
    wineIds.push(id);
  }

  let bottleCount = 0;

  // Grid positions: {x,y}, not {col,row}.
  await rpc<string>(sb, "create_acquisition_with_items", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_acquisition: {
      purchased_on: "2025-05-10",
      source: "Independent Merchant",
      reference: "ALT-GRID-6",
      total_amount: 150,
      notes: FIXTURE_MARKER,
    },
    p_items: [
      {
        wine_definition_id: wineIds[0],
        quantity: 6,
        format: "case_6",
        unit_price: 25,
        storage_location_id: wall,
        positions: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 3, y: 1 },
          { x: 1, y: 2 },
          { x: 2, y: 2 },
          { x: 3, y: 2 },
        ],
      },
    ],
  });
  bottleCount += 6;

  // Fridge positions: {zone,shelf,index}.
  await rpc<string>(sb, "create_acquisition_with_items", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_acquisition: {
      purchased_on: "2025-08-22",
      source: "Independent Merchant",
      notes: FIXTURE_MARKER,
    },
    p_items: [
      {
        wine_definition_id: wineIds[2],
        quantity: 4,
        unit_price: 19,
        storage_location_id: fridge,
        positions: [
          { zone: 1, shelf: 1, index: 1 },
          { zone: 1, shelf: 1, index: 2 },
          { zone: 2, shelf: 1, index: 1 },
          { zone: 2, shelf: 2, index: 5 },
        ],
      },
    ],
  });
  bottleCount += 4;

  // Unpositioned at the merchant.
  await rpc<string>(sb, "create_acquisition_with_items", {
    p_operation_id: uid(),
    p_cellar_id: cellarId,
    p_acquisition: {
      purchased_on: "2026-01-15",
      source: "Independent Merchant",
      notes: FIXTURE_MARKER,
    },
    p_items: [
      {
        wine_definition_id: wineIds[4],
        quantity: 12,
        format: "case_12",
        unit_price: 38,
        storage_location_id: merchant,
      },
    ],
  });
  bottleCount += 12;

  return {
    cellarId,
    layouts: { grid: gridLayout, fridge: fridgeLayout },
    locations: { wall, fridge, merchant },
    wineIds,
    bottleCount,
  };
}
