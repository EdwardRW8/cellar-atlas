/**
 * Collection search, filter and sort. Pure functions over already-loaded data.
 *
 * Client-side is right to roughly 5,000 bottles. Beyond that this needs
 * server-side pagination, which changes the repository read interface —
 * flagged in the Phase 3 plan as a decision to revisit in Phase 11.
 */

import type { WineSummary, WineColour } from "./types";
import { assessWindow, type WindowIndicator } from "./drinking-window";

export interface CollectionFilters {
  search: string;
  colours: WineColour[];
  countries: string[];
  grapes: string[];
  locationIds: string[];
  readiness: WindowIndicator[];
  /** Include wines with no active bottles (all consumed, gifted, etc). */
  includeEmpty: boolean;
}

export type SortKey = "name" | "producer" | "vintage" | "value" | "bottles" | "readiness";
export type SortDirection = "asc" | "desc";

export const emptyFilters = (): CollectionFilters => ({
  search: "",
  colours: [],
  countries: [],
  grapes: [],
  locationIds: [],
  readiness: [],
  includeEmpty: false,
});

export function hasActiveFilters(f: CollectionFilters): boolean {
  return (
    f.search.trim().length > 0 ||
    f.colours.length > 0 ||
    f.countries.length > 0 ||
    f.grapes.length > 0 ||
    f.locationIds.length > 0 ||
    f.readiness.length > 0 ||
    f.includeEmpty
  );
}

export function countActiveFilters(f: CollectionFilters): number {
  return (
    f.colours.length +
    f.countries.length +
    f.grapes.length +
    f.locationIds.length +
    f.readiness.length +
    (f.includeEmpty ? 1 : 0)
  );
}

/** Case- and accent-insensitive, so "rhone" finds "Rhône". */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchesSearch(w: WineSummary, term: string): boolean {
  if (!term.trim()) return true;
  const haystack = normalise(
    [
      w.wine.producer,
      w.wine.name,
      w.wine.vintage?.toString() ?? "",
      ...w.wine.grapes,
      w.wine.geography.country?.name ?? "",
      w.wine.geography.region?.name ?? "",
      w.wine.geography.appellation?.name ?? "",
      w.wine.geography.unmatched ?? "",
    ].join(" "),
  );

  // Every whitespace-separated term must appear, so "margaux 2015" narrows.
  return normalise(term)
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => haystack.includes(t));
}

export function filterCollection(
  wines: WineSummary[],
  f: CollectionFilters,
  currentYear?: number,
): WineSummary[] {
  return wines.filter((w) => {
    if (!f.includeEmpty && w.activeBottles === 0) return false;
    if (!matchesSearch(w, f.search)) return false;

    if (f.colours.length && (!w.wine.colour || !f.colours.includes(w.wine.colour)))
      return false;

    if (f.countries.length) {
      const code = w.wine.geography.country?.code;
      if (!code || !f.countries.includes(code)) return false;
    }

    if (f.grapes.length && !w.wine.grapes.some((g) => f.grapes.includes(g))) return false;

    if (f.locationIds.length && !w.locations.some((l) => f.locationIds.includes(l.id)))
      return false;

    if (f.readiness.length) {
      const { indicator } = assessWindow(
        { from: w.wine.drinkFrom, until: w.wine.drinkUntil },
        currentYear,
      );
      if (!f.readiness.includes(indicator)) return false;
    }

    return true;
  });
}

const READINESS_ORDER: Record<WindowIndicator, number> = {
  ready: 0,
  past: 1,
  young: 2,
  unknown: 3,
};

export function sortCollection(
  wines: WineSummary[],
  key: SortKey,
  dir: SortDirection = "asc",
  currentYear?: number,
): WineSummary[] {
  const sign = dir === "asc" ? 1 : -1;

  return [...wines].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "name":
        cmp = a.wine.name.localeCompare(b.wine.name);
        break;
      case "producer":
        cmp =
          a.wine.producer.localeCompare(b.wine.producer) ||
          a.wine.name.localeCompare(b.wine.name);
        break;
      case "vintage":
        // Non-vintage sorts last regardless of direction.
        if (a.wine.vintage === null && b.wine.vintage === null) cmp = 0;
        else if (a.wine.vintage === null) return 1;
        else if (b.wine.vintage === null) return -1;
        else cmp = a.wine.vintage - b.wine.vintage;
        break;
      case "value":
        cmp = (a.totalValue ?? 0) - (b.totalValue ?? 0);
        break;
      case "bottles":
        cmp = a.activeBottles - b.activeBottles;
        break;
      case "readiness": {
        const ai = assessWindow(
          { from: a.wine.drinkFrom, until: a.wine.drinkUntil },
          currentYear,
        );
        const bi = assessWindow(
          { from: b.wine.drinkFrom, until: b.wine.drinkUntil },
          currentYear,
        );
        cmp = READINESS_ORDER[ai.indicator] - READINESS_ORDER[bi.indicator];
        break;
      }
    }
    return cmp * sign || a.wine.name.localeCompare(b.wine.name);
  });
}

export interface CollectionTotals {
  wines: number;
  bottles: number;
  value: number;
  readyNow: number;
  /** Active bottles carrying a valuation. */
  valuedBottles: number;
  /** Active bottles in total. */
  activeBottles: number;
}

/**
 * Is `value` a complete picture of the collection?
 *
 * False means some bottles have no valuation, so the figure covers only part
 * of the cellar and must be presented with its completeness.
 */
export function isValuationComplete(t: CollectionTotals): boolean {
  return t.activeBottles > 0 && t.valuedBottles === t.activeBottles;
}

export function summarise(wines: WineSummary[], currentYear?: number): CollectionTotals {
  return wines.reduce<CollectionTotals>(
    (acc, w) => {
      const { indicator } = assessWindow(
        { from: w.wine.drinkFrom, until: w.wine.drinkUntil },
        currentYear,
      );
      return {
        wines: acc.wines + 1,
        bottles: acc.bottles + w.activeBottles,
        // `?? 0` here is a SUM over wines that have a value, not a claim
        // that unvalued wines are worth nothing. The completeness counts
        // below are what stop the total being read as complete.
        value: acc.value + (w.totalValue ?? 0),
        valuedBottles: acc.valuedBottles + w.valuation.valuedBottles,
        activeBottles: acc.activeBottles + w.valuation.activeBottles,
        readyNow: acc.readyNow + (indicator === "ready" ? w.activeBottles : 0),
      };
    },
    { wines: 0, bottles: 0, value: 0, readyNow: 0, valuedBottles: 0, activeBottles: 0 },
  );
}

/** Filter options built from what the user actually owns. */
export interface FilterOptions {
  colours: WineColour[];
  countries: { code: string; name: string }[];
  grapes: string[];
  locations: { id: string; name: string }[];
}

export function deriveFilterOptions(wines: WineSummary[]): FilterOptions {
  const colours = new Set<WineColour>();
  const countries = new Map<string, string>();
  const grapes = new Set<string>();
  const locations = new Map<string, string>();

  for (const w of wines) {
    if (w.wine.colour) colours.add(w.wine.colour);
    const c = w.wine.geography.country;
    if (c) countries.set(c.code, c.name);
    w.wine.grapes.forEach((g) => grapes.add(g));
    w.locations.forEach((l) => locations.set(l.id, l.name));
  }

  return {
    colours: [...colours].sort(),
    countries: [...countries]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    grapes: [...grapes].sort(),
    locations: [...locations]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
