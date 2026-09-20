/**
 * Home dashboard aggregation.
 *
 * ── FACTUAL, NOT PREDICTIVE ──────────────────────────────────────────────
 * Everything here is a deterministic count or sum over data the user already
 * has. There is no scoring, no forecasting and no recommendation. Cellar
 * Longevity, Legacy Risk, buying intelligence and consumption forecasts are
 * Phase 8 and must not appear here.
 *
 * The test for whether something belongs: could two people, given the same
 * database, disagree about the answer? If yes, it is a prediction and it does
 * not go in Home.
 *
 * ── REUSE, NOT REIMPLEMENTATION ──────────────────────────────────────────
 * Totals come from `summarise()` and readiness from `assessWindow()` — the
 * same functions the Cellar screen uses. Home and Cellar can therefore never
 * disagree about how many bottles are ready.
 */

import type { WineSummary, DomainStorageLocation } from "./types";
import { assessWindow, closesWithin } from "./drinking-window";
import { summarise, type CollectionTotals } from "./collection-filters";
import { computeOccupancy } from "./storage/occupancy";
import type { LayoutType, LayoutConfig } from "./storage/layout";

/**
 * How soon a window must close to count as "closing soon".
 *
 * Typed as `number`, not the literal `2`, because it is a tunable threshold.
 * As a literal, TypeScript proves the singular branch of "year/years"
 * unreachable and rejects the pluralisation as dead code.
 */
export const CLOSING_SOON_YEARS: number = 2;

export interface ReadinessBreakdown {
  /** Bottles whose window is open now. */
  readyBottles: number;
  readyWines: number;
  /** Open now, but closing within CLOSING_SOON_YEARS. */
  closingSoonBottles: number;
  closingSoonWines: number;
  /** Window has passed. */
  pastWindowBottles: number;
  pastWindowWines: number;
  /** No window recorded, so readiness is unknown. */
  unknownWindowWines: number;
}

export interface AttentionItem {
  kind: "missing-geography" | "missing-window" | "missing-colour";
  label: string;
  wines: number;
}

export interface StoragePressure {
  /** Only locations with a real capacity. Unbounded storage is excluded. */
  boundedLocations: number;
  occupied: number;
  capacity: number;
  free: number;
  percentFull: number;
  /** Bounded locations at or over capacity. */
  fullLocations: { id: string; name: string }[];
  /** Bottles in unbounded storage, reported separately, never as a percentage. */
  unboundedBottles: number;
  unboundedLocations: number;
}

export interface CellarSummary {
  totals: CollectionTotals;
  readiness: ReadinessBreakdown;
  attention: AttentionItem[];
  storage: StoragePressure | null;
  isEmpty: boolean;
}

/**
 * Readiness, counted in BOTTLES as well as wines.
 *
 * Bottles is the number that matters — six bottles of one ready wine is a
 * different situation from one bottle each of six.
 */
export function summariseReadiness(
  wines: WineSummary[],
  currentYear?: number,
): ReadinessBreakdown {
  const b: ReadinessBreakdown = {
    readyBottles: 0,
    readyWines: 0,
    closingSoonBottles: 0,
    closingSoonWines: 0,
    pastWindowBottles: 0,
    pastWindowWines: 0,
    unknownWindowWines: 0,
  };

  for (const w of wines) {
    if (w.activeBottles === 0) continue;

    const window = { from: w.wine.drinkFrom, until: w.wine.drinkUntil };
    const { indicator } = assessWindow(window, currentYear);

    if (indicator === "ready") {
      b.readyBottles += w.activeBottles;
      b.readyWines += 1;

      // Closing soon is a SUBSET of ready — a wine cannot be closing if its
      // window has not opened.
      if (closesWithin(window, CLOSING_SOON_YEARS, currentYear)) {
        b.closingSoonBottles += w.activeBottles;
        b.closingSoonWines += 1;
      }
    } else if (indicator === "past") {
      b.pastWindowBottles += w.activeBottles;
      b.pastWindowWines += 1;
    } else if (indicator === "unknown") {
      b.unknownWindowWines += 1;
    }
  }

  return b;
}

/**
 * Records missing information the user could usefully fill in.
 *
 * Incomplete data is a first-class state, not an error — `phase-0-audit.md`
 * makes that point about geography specifically. Nothing here is a judgement
 * about the wine; it is a count of blank fields.
 */
export function summariseAttention(wines: WineSummary[]): AttentionItem[] {
  const owned = wines.filter((w) => w.activeBottles > 0);

  const missingGeography = owned.filter((w) => w.wine.geography.country === null).length;
  const missingWindow = owned.filter(
    (w) => w.wine.drinkFrom === null && w.wine.drinkUntil === null,
  ).length;
  const missingColour = owned.filter((w) => w.wine.colour === null).length;

  const items: AttentionItem[] = [];

  if (missingGeography > 0) {
    items.push({
      kind: "missing-geography",
      label: `${missingGeography} wine${missingGeography === 1 ? "" : "s"} need geography`,
      wines: missingGeography,
    });
  }
  if (missingWindow > 0) {
    items.push({
      kind: "missing-window",
      label: `${missingWindow} wine${missingWindow === 1 ? "" : "s"} have no drinking window`,
      wines: missingWindow,
    });
  }
  if (missingColour > 0) {
    items.push({
      kind: "missing-colour",
      label: `${missingColour} wine${missingColour === 1 ? "" : "s"} have no type recorded`,
      wines: missingColour,
    });
  }

  return items;
}

/**
 * Storage pressure across ALL locations, whatever their shape.
 *
 * Layout agnostic by construction: capacity comes from `computeOccupancy`,
 * which dispatches on the layout's own type. Unbounded storage — merchant,
 * external, unpositioned — has no capacity, so it is counted separately and
 * NEVER folded into a percentage. Saying a merchant holding 200 bottles is
 * "0% full" would be worse than saying nothing.
 *
 * Returns null when there is no bounded storage at all, so the panel simply
 * does not render for a cellar that keeps everything at a merchant.
 */
export function summariseStorage(
  locations: DomainStorageLocation[],
): StoragePressure | null {
  let occupied = 0;
  let capacity = 0;
  let boundedLocations = 0;
  let unboundedBottles = 0;
  let unboundedLocations = 0;
  const fullLocations: { id: string; name: string }[] = [];

  for (const l of locations) {
    const o = computeOccupancy(
      l.occupied,
      l.layoutType as LayoutType | null,
      l.layoutConfig as LayoutConfig | null,
    );

    if (o.capacity === null) {
      unboundedLocations += 1;
      unboundedBottles += o.occupied;
      continue;
    }

    boundedLocations += 1;
    occupied += o.occupied;
    capacity += o.capacity;
    if (o.isFull) fullLocations.push({ id: l.id, name: l.name });
  }

  if (boundedLocations === 0) return null;

  return {
    boundedLocations,
    occupied,
    capacity,
    free: Math.max(0, capacity - occupied),
    percentFull: capacity === 0 ? 0 : Math.round((occupied / capacity) * 100),
    fullLocations,
    unboundedBottles,
    unboundedLocations,
  };
}

/** Everything Home needs, in one pure pass. */
export function buildCellarSummary(
  wines: WineSummary[],
  locations: DomainStorageLocation[],
  currentYear?: number,
): CellarSummary {
  const owned = wines.filter((w) => w.activeBottles > 0);

  return {
    // Same function the Cellar screen uses, so the two cannot disagree.
    totals: summarise(owned, currentYear),
    readiness: summariseReadiness(wines, currentYear),
    attention: summariseAttention(wines),
    storage: summariseStorage(locations),
    isEmpty: owned.length === 0,
  };
}
