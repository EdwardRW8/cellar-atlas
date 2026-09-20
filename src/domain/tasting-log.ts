/**
 * Tasting log.
 *
 * ── A TASTING SURVIVES ITS BOTTLE ────────────────────────────────────────
 * `tasting_records.wine_definition_id` is NOT NULL while `bottle_id` is
 * nullable. Migration 010 states why: a tasting must survive independently of
 * inventory, and may record a wine tasted elsewhere — a restaurant, a
 * friend's cellar — that the user has never owned.
 *
 * So a tasting is never filtered out for lacking a bottle, and the log must
 * read correctly for a wine that is not in the collection.
 */

export interface TastingRecord {
  id: string;
  wineId: string;
  /** Null when the wine was tasted elsewhere, or the bottle has since gone. */
  bottleId: string | null;
  rating: number | null;
  notes: string | null;
  tastedOn: string;
  context: string | null;
  version: number;
  /** Denormalised for display. Null when the wine is no longer readable. */
  producer: string | null;
  wineName: string | null;
  vintage: number | null;
}

export interface TastingMonth {
  /** YYYY-MM. */
  month: string;
  label: string;
  tastings: TastingRecord[];
}

export const RATING_WORDS = [
  "",
  "Disappointing",
  "Decent",
  "Very good",
  "Excellent",
  "Exceptional",
] as const;

export function describeRating(rating: number | null): string {
  if (rating === null) return "No rating";
  return RATING_WORDS[rating] ?? `${rating} of 5`;
}

export function describeTastedWine(t: TastingRecord): string {
  if (!t.wineName) return "Unknown wine";
  return `${t.wineName}${t.vintage ? ` ${t.vintage}` : ""}`;
}

/** Was this tasted from a bottle in the cellar, or somewhere else? */
export function wasTastedElsewhere(t: TastingRecord): boolean {
  return t.bottleId === null;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function describeMonth(month: string, now: Date = new Date()): string {
  const parsed = new Date(`${month}-01T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;

  const sameYear = parsed.getUTCFullYear() === now.getUTCFullYear();
  return parsed.toLocaleDateString("en-GB", {
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** Group tastings by month, newest first. */
export function groupByMonth(
  tastings: TastingRecord[],
  now: Date = new Date(),
): TastingMonth[] {
  const months = new Map<string, TastingRecord[]>();

  for (const t of tastings) {
    if (!t.tastedOn) continue;
    const key = monthKey(t.tastedOn);
    if (!key) continue;
    (months.get(key) ?? months.set(key, []).get(key)!).push(t);
  }

  return [...months.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, list]) => ({
      month,
      label: describeMonth(month, now),
      tastings: [...list].sort((a, b) => b.tastedOn.localeCompare(a.tastedOn)),
    }));
}

export interface TastingStats {
  total: number;
  rated: number;
  /** Mean of rated tastings only. Null when none are rated. */
  averageRating: number | null;
  distinctWines: number;
  tastedElsewhere: number;
}

export function summariseTastings(tastings: TastingRecord[]): TastingStats {
  const rated = tastings.filter((t) => t.rating !== null);
  const sum = rated.reduce((n, t) => n + (t.rating ?? 0), 0);

  return {
    total: tastings.length,
    rated: rated.length,
    // Unrated tastings are excluded rather than counted as zero — a note
    // without a score is not a bad review.
    averageRating: rated.length === 0 ? null : Math.round((sum / rated.length) * 10) / 10,
    distinctWines: new Set(tastings.map((t) => t.wineId)).size,
    tastedElsewhere: tastings.filter(wasTastedElsewhere).length,
  };
}
