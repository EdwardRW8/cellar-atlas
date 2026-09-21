/**
 * Workbook → canonical mappings.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * The bulk-import workbook's controlled lists were written independently of
 * the database, and three of them do not match what the schema accepts.
 * Every value below was checked against the actual CHECK constraints rather
 * than assumed.
 *
 * An alias is applied ONLY where the two denote the same thing, and every
 * applied alias is surfaced in the preview so nothing is translated behind the
 * user's back.
 *
 * Where no honest mapping exists — `insurance_value` — the value is REJECTED
 * rather than bent into the nearest option. Recording an insurance valuation
 * as a market estimate would misrepresent it permanently in an append-only
 * ledger.
 */

/** migration 004: colour CHECK. `Sweet` is NOT among them. */
export const CANONICAL_WINE_TYPES = [
  "Red",
  "White",
  "Rosé",
  "Sparkling",
  "Dessert",
  "Fortified",
] as const;
export type WineType = (typeof CANONICAL_WINE_TYPES)[number];

/** migration 007: bottle_size CHECK. */
export const CANONICAL_BOTTLE_SIZES = [
  "375ml",
  "750ml",
  "1500ml",
  "3000ml",
  "6000ml",
] as const;

/** migration 007: status CHECK. The workbook uses three of the six. */
export const CANONICAL_STATUSES = [
  "in_cellar",
  "consumed",
  "gifted",
  "sold",
  "lost",
  "removed",
] as const;

/** migration 010: valuation_basis CHECK. No insurance concept exists. */
export const CANONICAL_BASES = [
  "market_estimate",
  "merchant_retail",
  "auction_estimate",
  "realised_sale",
  "manual_estimate",
] as const;

/** migration 010: valuation source CHECK. */
export const CANONICAL_SOURCES = [
  "manual",
  "merchant",
  "auction_house",
  "api",
  "import",
] as const;

export interface Mapping<T> {
  value: T;
  /** Free-text provenance carried alongside the value (valuation source). */
  reference?: string;
  /** Set when the CSV value differed and an alias was applied. */
  alias?: { from: string; to: string; note?: string };
}

export interface Rejection {
  value: null;
  rejected: { from: string; reason: string };
  /**
   * Never present on a rejection.
   *
   * Declared so `.alias` can be read off the union without narrowing first —
   * a rejected value has no alias by definition, and callers checking for one
   * should not be forced through `isRejected` to ask.
   */
  alias?: undefined;
}

export type MapResult<T> = Mapping<T> | Rejection;

export function isRejected<T>(r: MapResult<T>): r is Rejection {
  return r.value === null;
}

function normalise(raw: string): string {
  return raw.trim().toLowerCase();
}

// ── WINE TYPE ─────────────────────────────────────────────────────────────

/**
 * `Sweet` is the workbook's word for what the database calls `Dessert`.
 *
 * They denote the same category, so the alias is applied — and shown as
 * "Sweet → Dessert" in the preview. The stored value is always canonical.
 */
const WINE_TYPE_ALIASES: Record<string, WineType> = {
  sweet: "Dessert",
  dessert: "Dessert",
  red: "Red",
  white: "White",
  rosé: "Rosé",
  rose: "Rosé",
  sparkling: "Sparkling",
  fortified: "Fortified",
};

export function mapWineType(raw: string): MapResult<WineType> {
  const key = normalise(raw);
  if (!key) {
    return { value: null, rejected: { from: raw, reason: "Wine type is required" } };
  }

  const mapped = WINE_TYPE_ALIASES[key];
  if (!mapped) {
    return {
      value: null,
      rejected: {
        from: raw,
        reason: `Not a recognised wine type. Use one of: ${CANONICAL_WINE_TYPES.join(", ")}`,
      },
    };
  }

  const canonicalSpelling = CANONICAL_WINE_TYPES.find((t) => normalise(t) === key);
  return canonicalSpelling
    ? { value: mapped }
    : { value: mapped, alias: { from: raw.trim(), to: mapped } };
}

// ── BOTTLE SIZE ───────────────────────────────────────────────────────────

/** The workbook supplies millilitres as a number; the column stores a label. */
export function mapBottleSize(raw: string): MapResult<string> {
  const text = raw.trim();
  if (!text) return { value: "750ml" };

  const digits = text.replace(/\s*ml\s*$/i, "").trim();
  const label = `${digits}ml`;

  if ((CANONICAL_BOTTLE_SIZES as readonly string[]).includes(label)) {
    return label === text
      ? { value: label }
      : { value: label, alias: { from: text, to: label } };
  }

  return {
    value: null,
    rejected: {
      from: text,
      // Names the supplied value. An unsupported size BLOCKS the row; it is
      // never quietly replaced with 750ml.
      reason: `"${text}" is not a supported bottle size. Use one of: ${CANONICAL_BOTTLE_SIZES.join(", ")}`,
    },
  };
}

// ── STATUS ────────────────────────────────────────────────────────────────

const STATUS_ALIASES: Record<string, string> = {
  "in cellar": "in_cellar",
  in_cellar: "in_cellar",
  incellar: "in_cellar",
  consumed: "consumed",
  drunk: "consumed",
  removed: "removed",
  gifted: "gifted",
  sold: "sold",
  lost: "lost",
};

export function mapStatus(raw: string): MapResult<string> {
  const key = normalise(raw);
  if (!key) return { value: "in_cellar" };

  const mapped = STATUS_ALIASES[key];
  if (!mapped) {
    return {
      value: null,
      rejected: {
        from: raw,
        reason: "Status must be In cellar, Consumed or Removed",
      },
    };
  }

  return key === mapped
    ? { value: mapped }
    : { value: mapped, alias: { from: raw.trim(), to: mapped } };
}

// ── VALUATION BASIS ───────────────────────────────────────────────────────

const BASIS_ALIASES: Record<string, string> = {
  market_estimate: "market_estimate",
  "market estimate": "market_estimate",
  retail_price: "merchant_retail",
  "retail price": "merchant_retail",
  merchant_retail: "merchant_retail",
  auction_estimate: "auction_estimate",
  "auction estimate": "auction_estimate",
  realised_sale: "realised_sale",
  "realised sale": "realised_sale",
  realized_sale: "realised_sale",
  manual_estimate: "manual_estimate",
  "manual estimate": "manual_estimate",

  // ── LEGACY COMPATIBILITY ALIASES ──
  // Wording found in spreadsheets created before this template existed. They
  // are NOT the template's vocabulary and never reach the database: each maps
  // to a canonical basis and is shown as a mapping in the preview.
  "estimated current uk retail/market value": "market_estimate",
  "current uk retail listing": "merchant_retail",
};

/**
 * `insurance_value` is deliberately absent.
 *
 * The enum has no insurance concept, and mapping it to `manual_estimate`
 * would record an insurance valuation as the owner's guess — permanently,
 * in an append-only ledger. The valuation is skipped and reported; the wine
 * and its bottles still import.
 */
export function mapValuationBasis(raw: string): MapResult<string> {
  const key = normalise(raw);
  if (!key) {
    return {
      value: null,
      rejected: { from: raw, reason: "A valuation needs a basis" },
    };
  }

  if (key === "insurance_value" || key === "insurance value") {
    return {
      value: null,
      rejected: {
        from: raw.trim(),
        reason:
          "Insurance value is not a basis Cellar Atlas can record truthfully. " +
          "Change it to one of: " +
          CANONICAL_BASES.join(", "),
      },
    };
  }

  const mapped = BASIS_ALIASES[key];
  if (!mapped) {
    return {
      value: null,
      rejected: {
        from: raw.trim(),
        reason: `Unknown valuation basis. Use one of: ${CANONICAL_BASES.join(", ")}`,
      },
    };
  }

  return key === mapped
    ? { value: mapped }
    : { value: mapped, alias: { from: raw.trim(), to: mapped } };
}

// ── VALUATION SOURCE ──────────────────────────────────────────────────────

/**
 * Provenance is preserved wherever the enum can express it.
 *
 * A merchant valuation stays `merchant` — it does not become `import` merely
 * because it reached Cellar Atlas through a CSV. Only values the enum cannot
 * represent fall back to `import`, and only with a visible warning.
 */
const SOURCE_ALIASES: Record<string, string> = {
  manual: "manual",
  merchant: "merchant",
  retailer: "merchant",
  auction_house: "auction_house",
  "auction house": "auction_house",
  api: "api",
  import: "import",
};

export function mapValuationSource(raw: string): MapResult<string> {
  const text = raw.trim();
  const key = normalise(raw);
  if (!key) return { value: "import" };

  const mapped = SOURCE_ALIASES[key];
  if (mapped) {
    return key === mapped
      ? { value: mapped }
      : { value: mapped, alias: { from: text, to: mapped } };
  }

  // Not a source TYPE — a provenance reference: a URL, a merchant's name, a
  // sale, "personal estimate". It is never forced into the type enum, which
  // would misstate what kind of source it was. The type is recorded as
  // "import" (the record reached Cellar Atlas by import; its type was not
  // stated) and the text is kept verbatim as the reference.
  const shown = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return {
    value: "import",
    reference: text,
    alias: {
      from: text,
      to: "import",
      note:
        `"${shown}" is not a source type, so it is kept as the valuation's ` +
        `source reference and the type is recorded as "import".`,
    },
  };
}

// ── CURRENCY ──────────────────────────────────────────────────────────────

/**
 * A currency is never invented.
 *
 * `create_acquisition_with_items` defaults a blank currency to GBP. For a
 * bulk import that would silently misstate a EUR purchase, so the importer
 * requires a currency whenever a price is present and the RPC's fallback can
 * never be reached.
 */
export function mapCurrency(raw: string): MapResult<string> {
  const text = raw.trim().toUpperCase();
  if (!text) {
    return { value: null, rejected: { from: raw, reason: "Currency is required" } };
  }
  if (!/^[A-Z]{3}$/.test(text)) {
    return {
      value: null,
      rejected: {
        from: raw.trim(),
        reason: "Currency must be a 3-letter code, such as GBP",
      },
    };
  }
  return { value: text };
}
