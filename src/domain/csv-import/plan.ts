/**
 * Import planning.
 *
 * Turns validated rows into an explicit list of mutations, decided BEFORE
 * anything is written. Nothing here performs I/O; the screen executes the plan
 * and the plan is what the preview describes, so the two cannot disagree.
 *
 * ── STABLE OPERATION IDS ─────────────────────────────────────────────────
 * Every planned mutation carries an operation id derived from the import
 * attempt plus the logical action it performs — not a random one minted at
 * call time.
 *
 * That means a retry replays the SAME ids, and `claim_operation` turns each
 * already-applied step into a harmless no-op. Resuming a half-finished import
 * cannot double-write anything, which matters because only the acquisition is
 * transactional; valuations, tastings and status changes are not.
 *
 * ── DEDUPLICATION ────────────────────────────────────────────────────────
 * Matching uses the database's own uniqueness rule — the partial unique index
 * `(cellar_id, lower(producer), lower(name), coalesce(vintage, -1))` — so the
 * importer's idea of "the same wine" is identical to the constraint that would
 * otherwise reject the insert.
 *
 * A near-match is never resolved silently: it is surfaced for the user.
 */

import type { ParsedRow } from "./parse";
import type { GeoRow } from "@/data/repositories/cellar-repository";

// ── IDENTITY ──────────────────────────────────────────────────────────────

/**
 * The database's uniqueness rule, expressed once.
 *
 * `coalesce(vintage, -1)` matters: two non-vintage wines from one producer
 * with the same name ARE the same wine to the index, and must be to us.
 */
export function wineKey(producer: string, name: string, vintage: number | null): string {
  return [producer.trim().toLowerCase(), name.trim().toLowerCase(), vintage ?? -1].join(
    "\u0000",
  );
}

/** An existing wine, reduced to what matching needs. */
export interface ExistingWine {
  id: string;
  producer: string;
  name: string;
  vintage: number | null;
}

/** A location the cellar actually has. */
export interface ExistingLocation {
  id: string;
  name: string;
  isPositioned: boolean;
  /** Canonical position keys already taken by a live bottle. */
  occupiedKeys: Set<string>;
  /** Validates a position key against this location's own layout. */
  isValidKey: (key: string) => boolean;
}

// ── FINGERPRINT ───────────────────────────────────────────────────────────

/**
 * A content fingerprint, stable across sessions and devices.
 *
 * Normalised so that trailing whitespace, line-ending differences and a BOM
 * do not make the same file look new. Stored in `acquisitions.reference` so a
 * later re-upload of the same file can be recognised and WARNED about —
 * never blocked, because importing the same wines again is sometimes exactly
 * what the user means.
 */
export async function fingerprintCsv(text: string): Promise<string> {
  const normalised = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();

  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * A deterministic UUID for one planned action.
 *
 * Derived from the attempt id and a logical action key, so the same step in
 * the same attempt always produces the same operation id — which is what
 * makes a resumed import idempotent through `claim_operation`.
 *
 * Formatted as a v4-shaped UUID because every operation column is `uuid`.
 */
export async function stableOperationId(
  attemptId: string,
  action: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${attemptId}\u0000${action}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ── PLAN ──────────────────────────────────────────────────────────────────

export interface PlannedWine {
  key: string;
  /** Client-supplied, so a replay recreates nothing. */
  id: string;
  operationId: string;
  producer: string;
  name: string;
  vintage: number | null;
  wine: Record<string, unknown>;
  /** Rows that contributed to this wine. */
  lineNumbers: number[];
}

export interface PlannedItem {
  wineKey: string;
  lineNumber: number;
  /** Resolved by name within the user's own locations; null when unnamed or unresolved. */
  storageLocationId: string | null;
  quantity: number;
  bottleSize: string;
  unitPrice: number | null;
  positions: (Record<string, number> | null)[];
}

export interface PlannedValuation {
  operationId: string;
  wineKey: string;
  lineNumber: number;
  amount: number;
  currency: string;
  basis: string;
  source: string;
  /** Free-text provenance; stored in the ledger's notes. */
  reference: string | null;
  valuedOn: string | null;
}

export interface PlannedTasting {
  operationId: string;
  wineKey: string;
  lineNumber: number;
  rating: number | null;
  notes: string | null;
  tastedOn: string | null;
  context: string | null;
}

export interface PlannedStatusChange {
  wineKey: string;
  lineNumber: number;
  status: string;
  quantity: number;
}

export interface PositionOutcome {
  lineNumber: number;
  /** The position asked for; null when only a location was named. */
  requested: string | null;
  locationName: string;
  resolved: boolean;
  reason?:
    | "no-such-location"
    | "ambiguous-location"
    | "not-positioned"
    | "invalid-for-layout"
    | "occupied"
    | "claimed-in-file";
}

export interface ImportPlan {
  attemptId: string;
  fingerprint: string;

  winesToCreate: PlannedWine[];
  winesReused: { key: string; id: string; lineNumbers: number[] }[];
  ambiguous: { lineNumber: number; producer: string; name: string; candidates: string[] }[];

  items: PlannedItem[];
  valuations: PlannedValuation[];
  tastings: PlannedTasting[];
  statusChanges: PlannedStatusChange[];

  positions: PositionOutcome[];

  counts: {
    rows: number;
    validRows: number;
    warningRows: number;
    invalidRows: number;
    winesToCreate: number;
    winesReused: number;
    bottlesToCreate: number;
    valuations: number;
    tastings: number;
    unresolvedPositions: number;
  };
}

/**
 * Build the plan.
 *
 * INVALID rows are excluded from every mutation. The import screen blocks
 * confirmation while any remain, so this exclusion is a safety net rather
 * than the mechanism.
 */
function resolveGeography(
  row: ParsedRow,
  geography: Map<string, GeoRow>,
): {
  geoRegionId: string | null;
  countryCode: string | null;
  regionText: string | null;
} {
  const nodes = [...geography.values()];

  const normalise = (value: string) => value.trim().toLocaleLowerCase();

  // Explicit aliases only where both names denote the same geography.
  // Keep this deliberately small: unknown geography remains free text rather
  // than being guessed into the canonical hierarchy.
  const geographyAliases: Record<string, string> = {
    "mount veeder": "Mt. Veeder",
    "sonoma county": "Sonoma",
  };

  const exactMatches = (value: string | null, level?: string) => {
    if (!value) return [];

    const normalised = normalise(value);
    const wanted = normalise(geographyAliases[normalised] ?? value);

    return nodes.filter(
      (node) =>
        normalise(node.name) === wanted &&
        (!level || node.level === level),
    );
  };

  // Prefer the deepest, most specific geography supplied by the CSV.
  const candidates = [
    { value: row.appellation, level: undefined },
    { value: row.region, level: undefined },
    { value: row.country, level: "country" },
  ];

  for (const candidate of candidates) {
    let matches = exactMatches(candidate.value, candidate.level);

    // Country is useful for disambiguating otherwise identical place names.
    if (row.country) {
  const countryMatches = exactMatches(row.country, "country");
  const countryMatch = countryMatches[0];

  if (countryMatches.length === 1 && countryMatch) {
    matches = matches.filter(
      (match) => match.country_code === countryMatch.country_code,
    );
  }
}

const match = matches[0];

if (matches.length === 1 && match) {
  return {
    geoRegionId: match.id,
    countryCode: match.country_code,
    regionText: null,
  };
}
  }

  // No unique canonical match: preserve the most useful supplied text rather
  // than guessing. Atlas will surface it for later review.
  return {
    geoRegionId: null,
    countryCode: null,
    regionText: row.appellation ?? row.region ?? row.country,
  };
}
export async function planImport(args: {
  rows: ParsedRow[];
  attemptId: string;
  fingerprint: string;
  existingWines: ExistingWine[];
  geography: Map<string, GeoRow>;
  locations: ExistingLocation[];
  newId: () => string;
  parsePositionKey: (locationId: string, key: string) => Record<string, number> | null;
}): Promise<ImportPlan> {
  const { rows, attemptId, fingerprint, existingWines, geography, locations, newId } = args;

  const importable = rows.filter((r) => r.severity !== "invalid");

  const existingByKey = new Map(
    existingWines.map((w) => [wineKey(w.producer, w.name, w.vintage), w.id]),
  );

  const winesToCreate: PlannedWine[] = [];
  const reusedMap = new Map<string, { key: string; id: string; lineNumbers: number[] }>();
  const createdMap = new Map<string, PlannedWine>();
  const ambiguous: ImportPlan["ambiguous"] = [];

  const items: PlannedItem[] = [];
  const valuations: PlannedValuation[] = [];
  const tastings: PlannedTasting[] = [];
  const statusChanges: PlannedStatusChange[] = [];
  const positions: PositionOutcome[] = [];

  // Positions claimed earlier in THIS file, so two rows cannot claim one slot.
  const claimedInFile = new Map<string, Set<string>>();

  for (const row of importable) {
    const key = wineKey(row.producer, row.wineName, row.vintage);

    // ── Wine: reuse, collapse, or create ──
    const existingId = existingByKey.get(key);
    if (existingId) {
      const entry = reusedMap.get(key) ?? { key, id: existingId, lineNumbers: [] };
      entry.lineNumbers.push(row.lineNumber);
      reusedMap.set(key, entry);
    } else if (createdMap.has(key)) {
      // A second row for the same wine collapses into the first definition.
      createdMap.get(key)!.lineNumbers.push(row.lineNumber);
    } else {
      const wineId = newId();
      const geo = resolveGeography(row, geography);
      const planned: PlannedWine = {
        key,
        id: wineId,
        operationId: await stableOperationId(attemptId, `wine:${key}`),
        producer: row.producer,
        name: row.wineName,
        vintage: row.vintage,
        lineNumbers: [row.lineNumber],
        wine: {
          id: wineId,
          producer: row.producer,
          name: row.wineName,
          vintage: row.vintage,
          colour: row.wineType,
          grapes: row.grapes,
          geo_region_id: geo.geoRegionId,
country_code: geo.countryCode,
region_text: geo.regionText,
          drink_from: row.drinkFrom,
          drink_until: row.drinkUntil,
          notes: row.notes,
          enrichment_source: "import",
        },
      };
      createdMap.set(key, planned);
      winesToCreate.push(planned);
    }

    // ── Near matches, surfaced not guessed ──
    if (!existingId) {
      const near = existingWines.filter(
        (w) =>
          w.producer.trim().toLowerCase() === row.producer.trim().toLowerCase() &&
          w.name.trim().toLowerCase() === row.wineName.trim().toLowerCase() &&
          w.vintage !== row.vintage,
      );
      if (near.length > 0) {
        ambiguous.push({
          lineNumber: row.lineNumber,
          producer: row.producer,
          name: row.wineName,
          candidates: near.map((w) => `${w.name} ${w.vintage ?? "NV"}`),
        });
      }
    }

    // ── Positions: proven safe, or omitted ──
    const rowPositions: (Record<string, number> | null)[] = Array(row.quantity).fill(null);

// A named location is used only when its storage rules can be satisfied.
// Positioned layouts require a valid position. If none is supplied, the
// bottles import unpositioned/unlocated after the user acknowledges the
// warning rather than inventing a slot or violating the layout invariant.
let storageLocationId: string | null = null;
if (row.storageLocation?.trim()) {
  const match = resolveLocation(row.storageLocation, locations);
  if ("reason" in match) {
    // Never invent a location, never guess between two. The bottles import
    // unpositioned and unlocated, after the user acknowledges it.
    positions.push({
      lineNumber: row.lineNumber,
      requested: row.position ?? null,
      locationName: row.storageLocation,
      resolved: false,
      reason: match.reason,
    });
  } else {
    const location = match.location;

    if (!row.position && location.isPositioned) {
      // A positioned layout cannot accept a bottle without a position.
      // Keep storageLocationId null so the bottle imports safely unpositioned.
      positions.push({
        lineNumber: row.lineNumber,
        requested: null,
        locationName: row.storageLocation,
        resolved: false,
        reason: "invalid-for-layout",
      });
    } else {
      storageLocationId = location.id;

      if (row.position) {
        let reason: PositionOutcome["reason"] | undefined;
        if (!location.isPositioned) reason = "not-positioned";
        else if (!location.isValidKey(row.position)) reason = "invalid-for-layout";
        else {
          const claimed = claimedInFile.get(location.id) ?? new Set<string>();
          if (location.occupiedKeys.has(row.position)) reason = "occupied";
          else if (claimed.has(row.position)) reason = "claimed-in-file";
          else {
            const parsed = args.parsePositionKey(location.id, row.position);
            if (!parsed) reason = "invalid-for-layout";
            else {
              // Only the FIRST bottle of a multi-bottle row takes the slot.
              rowPositions[0] = parsed;
              claimed.add(row.position);
              claimedInFile.set(location.id, claimed);
            }
          }
        }

        positions.push({
          lineNumber: row.lineNumber,
          requested: row.position,
          locationName: row.storageLocation,
          resolved: reason === undefined,
          reason,
        });

        // An invalid supplied position must not leave the bottle assigned to
        // a positioned location without a valid position.
        if (reason !== undefined && location.isPositioned) {
          storageLocationId = null;
        }
      }
    }
  }
    } else if (row.position) {
      // A position with no location cannot be placed anywhere.
      positions.push({
        lineNumber: row.lineNumber,
        requested: row.position,
        locationName: "",
        resolved: false,
        reason: "no-such-location",
      });
    }

    items.push({
      wineKey: key,
      lineNumber: row.lineNumber,
      storageLocationId,
      quantity: row.quantity,
      bottleSize: row.bottleSize,
      // Absent price stays null: unknown, never zero.
      unitPrice: row.purchasePrice,
      positions: rowPositions,
    });

    if (row.valuation) {
      valuations.push({
        operationId: await stableOperationId(
          attemptId,
          `valuation:${key}:${row.lineNumber}`,
        ),
        wineKey: key,
        lineNumber: row.lineNumber,
        ...row.valuation,
      });
    }

    if (row.tasting) {
      tastings.push({
        operationId: await stableOperationId(attemptId, `tasting:${key}:${row.lineNumber}`),
        wineKey: key,
        lineNumber: row.lineNumber,
        ...row.tasting,
      });
    }

    if (row.status !== "in_cellar") {
      statusChanges.push({
        wineKey: key,
        lineNumber: row.lineNumber,
        status: row.status,
        quantity: row.quantity,
      });
    }
  }

  const winesReused = [...reusedMap.values()];

  return {
    attemptId,
    fingerprint,
    winesToCreate,
    winesReused,
    ambiguous,
    items,
    valuations,
    tastings,
    statusChanges,
    positions,
    counts: {
      rows: rows.length,
      validRows: rows.filter((r) => r.severity === "valid").length,
      warningRows: rows.filter((r) => r.severity === "warning").length,
      invalidRows: rows.filter((r) => r.severity === "invalid").length,
      winesToCreate: winesToCreate.length,
      winesReused: winesReused.length,
      bottlesToCreate: items.reduce((n, i) => n + i.quantity, 0),
      valuations: valuations.length,
      tastings: tastings.length,
      unresolvedPositions: positions.filter((p) => !p.resolved).length,
    },
  };
}

/** Confirmation is blocked while any row cannot be imported. */
export function canConfirm(plan: ImportPlan): boolean {
  return plan.counts.invalidRows === 0 && plan.counts.bottlesToCreate > 0;
}

/**
 * Resolve a storage-location NAME against the user's own locations.
 *
 *   1. whitespace is trimmed
 *   2. an exact match wins
 *   3. otherwise a UNIQUE case-insensitive match is accepted
 *   4. several case-insensitive matches → ambiguous: never guessed
 *   5. no match → unresolved: a location is never invented
 *
 * Generic: nothing here knows any particular cellar's location names.
 */
export function resolveLocation(
  name: string,
  locations: ExistingLocation[],
): { location: ExistingLocation } | { reason: "no-such-location" | "ambiguous-location" } {
  const wanted = name.trim();
  const exact = locations.filter((l) => l.name.trim() === wanted);
  if (exact.length === 1) return { location: exact[0]! };
  if (exact.length > 1) return { reason: "ambiguous-location" };

  const folded = wanted.toLowerCase();
  const loose = locations.filter((l) => l.name.trim().toLowerCase() === folded);
  if (loose.length === 1) return { location: loose[0]! };
  if (loose.length > 1) return { reason: "ambiguous-location" };
  return { reason: "no-such-location" };
}
