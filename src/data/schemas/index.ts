/**
 * Zod schemas — the boundary between the database and the domain.
 *
 * Row schemas mirror Postgres exactly: snake_case, nullable-heavy, numerics
 * as strings. Domain types are what the app reasons about. Parsing between
 * them means a shape mismatch surfaces immediately rather than as a null
 * three screens later.
 */

import { z } from "zod";

// ── Primitives ────────────────────────────────────────────────────────────

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Postgres returns numeric as a string to preserve exactness. */
export const numericSchema = z.union([z.string(), z.number()]).nullable();

export const currencySchema = z.string().length(3);

export const bottleSizeSchema = z.enum(["375ml", "750ml", "1500ml", "3000ml", "6000ml"]);

export const wineColourSchema = z.enum([
  "Red",
  "White",
  "Rosé",
  "Sparkling",
  "Dessert",
  "Fortified",
]);

export const bottleStatusSchema = z.enum([
  "in_cellar",
  "consumed",
  "gifted",
  "sold",
  "lost",
  "removed",
]);

export const layoutTypeSchema = z.enum([
  "staircase",
  "grid",
  "shelving",
  "fridge",
  "unpositioned",
  "external",
]);

export const eventTypeSchema = z.enum([
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
]);

/** Amendment 6: what KIND of number this is, separate from where it came from. */
export const valuationBasisSchema = z.enum([
  "market_estimate",
  "merchant_retail",
  "auction_estimate",
  "realised_sale",
  "manual_estimate",
]);

/** Where the number came from. */
export const valuationSourceSchema = z.enum([
  "manual",
  "merchant",
  "auction_house",
  "api",
  "import",
]);

// ── Layout configs ────────────────────────────────────────────────────────

export const staircaseConfigSchema = z
  .object({
    columns: z.number().int().positive(),
    heights: z.array(z.number().int().positive()).min(1),
    chamfer: z.boolean().default(false),
    orientation: z.enum(["ascending-right", "ascending-left"]).default("ascending-right"),
  })
  .refine((c) => c.heights.length === c.columns, {
    message: "heights must have exactly one entry per column",
  });

export const gridConfigSchema = z.object({
  rows: z.number().int().positive(),
  columns: z.number().int().positive(),
});

export const shelvingConfigSchema = z.object({
  shelves: z.array(z.number().int().positive()).min(1),
});

export const fridgeConfigSchema = z.object({
  zones: z
    .array(
      z.object({
        name: z.string(),
        shelves: z.number().int().positive(),
        perShelf: z.number().int().positive(),
        tempC: z.number().optional(),
      }),
    )
    .min(1),
});

export const unpositionedConfigSchema = z.object({ note: z.string().optional() });

export const externalConfigSchema = z.object({
  merchant: z.string().optional(),
  accountRef: z.string().optional(),
});

/** Validate a config against its declared type. */
export function parseLayoutConfig(type: string, config: unknown) {
  switch (type) {
    case "staircase":
      return staircaseConfigSchema.parse(config);
    case "grid":
      return gridConfigSchema.parse(config);
    case "shelving":
      return shelvingConfigSchema.parse(config);
    case "fridge":
      return fridgeConfigSchema.parse(config);
    case "unpositioned":
      return unpositionedConfigSchema.parse(config);
    case "external":
      return externalConfigSchema.parse(config);
    default:
      throw new Error(`Unknown layout type: ${type}`);
  }
}

// ── Positions ─────────────────────────────────────────────────────────────

export const staircasePositionSchema = z.object({
  col: z.number().int().positive(),
  row: z.number().int().positive(),
});
export const gridPositionSchema = z.object({
  x: z.number().int().positive(),
  y: z.number().int().positive(),
});
export const shelvingPositionSchema = z.object({
  shelf: z.number().int().positive(),
  index: z.number().int().positive(),
});
export const fridgePositionSchema = z.object({
  zone: z.number().int().positive(),
  shelf: z.number().int().positive(),
  index: z.number().int().positive(),
});

export const positionSchema = z.union([
  staircasePositionSchema,
  gridPositionSchema,
  shelvingPositionSchema,
  fridgePositionSchema,
]);

// ── Geography ─────────────────────────────────────────────────────────────

export const geoRegionRowSchema = z.object({
  id: uuidSchema,
  parent_id: uuidSchema.nullable(),
  level: z.enum(["country", "region", "subregion", "appellation"]),
  slug: z.string(),
  name: z.string(),
  country_code: z.string().length(2),
  latitude: numericSchema,
  longitude: numericSchema,
  has_boundary: z.boolean(),
  source: z.enum(["iso-3166", "natural-earth", "manual-curation"]),
  source_version: z.string(),
  source_url: z.string().nullable(),
  verified_on: z.string(),
  centroid_precision: z.enum(["exact", "approximate", "none"]),
  sort_order: z.number().int(),
});

// ── Wine ──────────────────────────────────────────────────────────────────

export const wineDefinitionRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  producer: z.string(),
  name: z.string(),
  vintage: z.number().int().nullable(),
  colour: wineColourSchema.nullable(),
  grapes: z.array(z.string()),
  geo_region_id: uuidSchema.nullable(),
  country_code: z.string().length(2).nullable(),
  region_text: z.string().nullable(),
  drink_from: z.number().int().nullable(),
  drink_until: z.number().int().nullable(),
  enrichment_source: z.enum(["manual", "ai", "import"]).nullable(),
  enrichment_confidence: numericSchema,
  notes: z.string().nullable(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
});

export const wineDefinitionInputSchema = z.object({
  producer: z.string().min(1, "Producer is required"),
  name: z.string().min(1, "Wine name is required"),
  vintage: z.number().int().min(1800).max(2100).nullable().optional(),
  colour: wineColourSchema.optional(),
  grapes: z.array(z.string()).default([]),
  geo_region_id: uuidSchema.nullable().optional(),
  country_code: z.string().length(2).nullable().optional(),
  region_text: z.string().nullable().optional(),
  drink_from: z.number().int().nullable().optional(),
  drink_until: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
});

// ── Storage ───────────────────────────────────────────────────────────────

export const storageLayoutRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  name: z.string(),
  type: layoutTypeSchema,
  config: z.unknown(),
  capacity: z.number().int().nullable(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
});

export const storageLocationRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  name: z.string(),
  kind: z.enum(["home", "merchant", "fridge", "other"]),
  storage_layout_id: uuidSchema.nullable(),
  is_external: z.boolean(),
  merchant_reference: z.string().nullable(),
  sort_order: z.number().int(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
});

// ── Acquisition ───────────────────────────────────────────────────────────

export const acquisitionRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  purchased_on: z.string().nullable(),
  source: z.string().nullable(),
  storage_location_id: uuidSchema.nullable(),
  reference: z.string().nullable(),
  total_amount: numericSchema,
  currency: currencySchema,
  notes: z.string().nullable(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
});

export const acquisitionItemRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  acquisition_id: uuidSchema,
  wine_definition_id: uuidSchema,
  quantity: z.number().int().positive(),
  bottle_size: bottleSizeSchema,
  format: z.enum(["case_12", "case_6", "case_3", "loose"]),
  unit_price: numericSchema,
  line_total: numericSchema,
  duty_paid: z.boolean(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
});

// ── Bottle ────────────────────────────────────────────────────────────────

export const bottleRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  wine_definition_id: uuidSchema,
  acquisition_item_id: uuidSchema.nullable(),
  bottle_size: bottleSizeSchema,
  storage_location_id: uuidSchema.nullable(),
  position: z.unknown().nullable(),
  position_key: z.string().nullable(),
  status: bottleStatusSchema,
  status_changed_at: z.string().nullable(),
  current_value: numericSchema,
  current_value_at: z.string().nullable(),
  label_condition: z.enum(["pristine", "good", "damaged", "missing"]).nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  // NOTE: no deleted_at. Bottles are never deleted (amendment 3).
});

// ── Events ────────────────────────────────────────────────────────────────

export const bottleEventRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  bottle_id: uuidSchema,
  event_type: eventTypeSchema,
  occurred_at: z.string(),
  recorded_at: z.string(),
  previous_state: z.unknown().nullable(),
  new_state: z.unknown().nullable(),
  reason: z.string().nullable(),
  notes: z.string().nullable(),
  actor_id: uuidSchema.nullable(),
  device_id: z.string().nullable(),
  operation_id: uuidSchema.nullable(),
});

// ── Tasting & valuation ───────────────────────────────────────────────────

export const tastingRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  wine_definition_id: uuidSchema,
  bottle_id: uuidSchema.nullable(),
  bottle_event_id: uuidSchema.nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  notes: z.string().nullable(),
  tasted_on: z.string(),
  tasted_by: uuidSchema.nullable(),
  context: z.string().nullable(),
  version: z.number().int(),
  deleted_at: z.string().nullable(),
});

export const valuationRowSchema = z
  .object({
    id: uuidSchema,
    cellar_id: uuidSchema,
    wine_definition_id: uuidSchema.nullable(),
    bottle_id: uuidSchema.nullable(),
    amount: numericSchema,
    currency: currencySchema,
    valuation_basis: valuationBasisSchema,
    source: valuationSourceSchema,
    valued_on: z.string(),
    confidence: numericSchema,
    notes: z.string().nullable(),
  })
  .refine((v) => (v.wine_definition_id === null) !== (v.bottle_id === null), {
    message: "A valuation must target exactly one of a wine or a bottle",
  });

export const valuationInputSchema = z
  .object({
    wine_definition_id: uuidSchema.nullable().optional(),
    bottle_id: uuidSchema.nullable().optional(),
    amount: z.number().nonnegative(),
    currency: currencySchema.default("GBP"),
    valuation_basis: valuationBasisSchema,
    source: valuationSourceSchema.default("manual"),
    valued_on: isoDateSchema.optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((v) => Boolean(v.wine_definition_id) !== Boolean(v.bottle_id), {
    message: "A valuation must target exactly one of a wine or a bottle",
  });

// ── Profile ───────────────────────────────────────────────────────────────

export const cellarProfileRowSchema = z.object({
  id: uuidSchema,
  cellar_id: uuidSchema,
  bottles_per_month: numericSchema,
  bottles_purchased_per_year: z.number().int().nullable(),
  typical_purchase_quantity: z.number().int().nullable(),
  prefers_ageing: z.boolean().nullable(),
  collecting_horizon_years: z.number().int().nullable(),
  favourite_regions: z.array(uuidSchema),
  favourite_grapes: z.array(z.string()),
  dislikes: z.array(z.string()),
  typical_bottle_budget: numericSchema,
  currency: currencySchema,
  values_investment: z.boolean().nullable(),
  onboarding_completed_at: z.string().nullable(),
  version: z.number().int(),
});

// ── Inferred types ────────────────────────────────────────────────────────

export type GeoRegionRow = z.infer<typeof geoRegionRowSchema>;
export type WineDefinitionRow = z.infer<typeof wineDefinitionRowSchema>;
export type WineDefinitionInput = z.infer<typeof wineDefinitionInputSchema>;
export type StorageLayoutRow = z.infer<typeof storageLayoutRowSchema>;
export type StorageLocationRow = z.infer<typeof storageLocationRowSchema>;
export type AcquisitionRow = z.infer<typeof acquisitionRowSchema>;
export type AcquisitionItemRow = z.infer<typeof acquisitionItemRowSchema>;
export type BottleRow = z.infer<typeof bottleRowSchema>;
export type BottleEventRow = z.infer<typeof bottleEventRowSchema>;
export type TastingRow = z.infer<typeof tastingRowSchema>;
export type ValuationRow = z.infer<typeof valuationRowSchema>;
export type ValuationInput = z.infer<typeof valuationInputSchema>;
export type CellarProfileRow = z.infer<typeof cellarProfileRowSchema>;

/** Postgres numerics arrive as strings. Convert at the boundary, once. */
export function toNumber(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
