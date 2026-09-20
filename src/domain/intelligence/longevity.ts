/**
 * Cellar Longevity and Legacy Outlook.
 *
 * ── THE QUESTION THIS ANSWERS ────────────────────────────────────────────
 * NOT "how many years until the cellar is empty" — that is
 * `bottles ÷ rate`, which ignores when wines are actually drinkable and can
 * be badly wrong in both directions. A cellar of 200 young Barolo is not
 * "ten years of drinking" if none of it opens for eight years.
 *
 * The real question is whether the cellar's drinking windows are COMPATIBLE
 * with how much the owner can realistically drink over time:
 *
 *   - how many bottles become drinkable in each future year
 *   - how many are already drinkable
 *   - how many will pass the end of their window unconsumed
 *   - what the owner can actually get through in that period
 *
 * ── LEGACY OUTLOOK, NOT LEGACY RISK ──────────────────────────────────────
 * A bottle whose window ends after the collecting horizon is not a risk. It
 * may be exactly what the owner intended — a wine laid down for a child, or
 * simply a long-lived bottle bought knowingly.
 *
 * So two distinct things are reported, and neither is called a risk:
 *
 *   BEYOND HORIZON     bottles still drinkable after the horizon ends.
 *                      Informational. Possibly deliberate.
 *   CONSUMPTION CONFLICT  bottles whose windows CLOSE within the period but
 *                      which exceed what the owner can drink in it. This is
 *                      the genuine pressure.
 *
 * ── MISSING WINDOWS ──────────────────────────────────────────────────────
 * A wine without a drinking window is NEVER given one. It is excluded from
 * every projection and reported in the evidence, so the user can see how much
 * of the answer is unknown.
 */

import type { WineSummary } from "../types";
import { assessWindow } from "../drinking-window";
import type { Evidence } from "./consumption";
import { projectionRange, type ConsumptionCapacity, type Range } from "./consumption";
import type { CellarProfile } from "./types";

/**
 * Horizons the projection is reported over.
 *
 * One year is "soon", five years is the span most people can picture, and ten
 * is long enough to expose a cellar maturing faster than it can be drunk.
 * They are reporting buckets, not thresholds in any decision.
 */
export const PROJECTION_YEARS = [1, 5, 10] as const;
export type ProjectionYear = (typeof PROJECTION_YEARS)[number];

export interface MaturationWindow {
  years: ProjectionYear;
  /** Bottles drinkable at some point within this period. */
  drinkableBottles: number;
  /** Bottles becoming newly ready during it. */
  newlyReadyBottles: number;
  /** Bottles whose window CLOSES within it. */
  closingBottles: number;
  /** What the owner would drink in this period. Null without capacity. */
  expectedConsumption: Range | null;
  /**
   * Closing bottles beyond what the owner could drink in the period.
   * Null without capacity. This is the genuine consumption conflict.
   */
  surplusClosing: number | null;
}

export interface LongevityResult {
  activeBottles: number;
  /** Active bottles carrying a usable drinking window. */
  withWindow: number;
  /** Active bottles with no window — excluded from every projection. */
  withoutWindow: number;
  windows: MaturationWindow[];
  /** Supporting fact only, never the headline. Null without capacity. */
  yearsOfDrinkingAtCurrentRate: Range | null;
  capacity: ConsumptionCapacity;
  evidence: Evidence;
  /** False when nothing can be said — no windows, or no capacity. */
  hasProjection: boolean;
}

export interface LegacyOutlookResult {
  horizonYears: number | null;
  /** Still drinkable after the horizon. Informational, not a problem. */
  beyondHorizonBottles: number;
  beyondHorizonWines: number;
  /** Windows closing inside the horizon but exceeding drinking capacity. */
  consumptionConflictBottles: number;
  /** What the owner would drink across the whole horizon. */
  expectedConsumptionOverHorizon: Range | null;
  /** Bottles that will be drinkable during the horizon. */
  drinkableWithinHorizon: number;
  withoutWindow: number;
  evidence: Evidence;
  /** False when no horizon is set — prompt rather than guess. */
  hasHorizon: boolean;
}

interface WindowedBottles {
  from: number | null;
  until: number | null;
  bottles: number;
}

/** Active bottles grouped by their wine's window. Consumed bottles excluded. */
function activeWindows(wines: WineSummary[]): WindowedBottles[] {
  return wines
    .filter((w) => w.activeBottles > 0)
    .map((w) => ({
      from: w.wine.drinkFrom,
      until: w.wine.drinkUntil,
      bottles: w.activeBottles,
    }));
}

/** Does this window make the wine drinkable at any point in [now, now+years]? */
function drinkableWithin(w: WindowedBottles, year: number, horizon: number): boolean {
  const opens = w.from ?? Number.NEGATIVE_INFINITY;
  const closes = w.until ?? Number.POSITIVE_INFINITY;
  // Overlaps the period at all.
  return opens <= year + horizon && closes >= year;
}

export function computeLongevity(
  wines: WineSummary[],
  capacity: ConsumptionCapacity,
  currentYear: number = new Date().getFullYear(),
): LongevityResult {
  const all = activeWindows(wines);
  const activeBottles = all.reduce((n, w) => n + w.bottles, 0);

  // A wine with NEITHER bound cannot be projected. One bound is usable.
  const usable = all.filter((w) => w.from !== null || w.until !== null);
  const unusable = all.filter((w) => w.from === null && w.until === null);

  const withWindow = usable.reduce((n, w) => n + w.bottles, 0);
  const withoutWindow = unusable.reduce((n, w) => n + w.bottles, 0);

  const perYear = capacity.bottlesPerYear;

  const windows: MaturationWindow[] = PROJECTION_YEARS.map((years) => {
    const drinkable = usable
      .filter((w) => drinkableWithin(w, currentYear, years))
      .reduce((n, w) => n + w.bottles, 0);

    // Newly ready: not open now, opens within the period.
    const newlyReady = usable
      .filter((w) => {
        const opens = w.from;
        if (opens === null) return false;
        return opens > currentYear && opens <= currentYear + years;
      })
      .reduce((n, w) => n + w.bottles, 0);

    // Closing: window ends within the period and has not already passed.
    const closing = usable
      .filter((w) => {
        const closes = w.until;
        if (closes === null) return false;
        return closes >= currentYear && closes <= currentYear + years;
      })
      .reduce((n, w) => n + w.bottles, 0);

    const expected = perYear === null ? null : projectionRange(perYear * years);

    // Only bottles that MUST be drunk in the period count toward conflict.
    const surplus = expected === null ? null : Math.max(0, closing - expected.high);

    return {
      years,
      drinkableBottles: drinkable,
      newlyReadyBottles: newlyReady,
      closingBottles: closing,
      expectedConsumption: expected,
      surplusClosing: surplus,
    };
  });

  // Supporting fact only. Deliberately not the headline.
  const yearsOfDrinking =
    perYear === null || perYear <= 0 ? null : projectionRange(activeBottles / perYear);

  return {
    activeBottles,
    withWindow,
    withoutWindow,
    windows,
    yearsOfDrinkingAtCurrentRate: yearsOfDrinking,
    capacity,
    evidence: {
      ...capacity.evidence,
      missingWindows: withoutWindow,
      excludedBottles: withoutWindow,
    },
    hasProjection: withWindow > 0 && perYear !== null,
  };
}

/**
 * Legacy Outlook.
 *
 * Reports what is unlikely to be consumed within the intended horizon,
 * separating deliberate long-term holdings from genuine pressure.
 */
export function computeLegacyOutlook(
  wines: WineSummary[],
  capacity: ConsumptionCapacity,
  profile: CellarProfile | null,
  currentYear: number = new Date().getFullYear(),
): LegacyOutlookResult {
  const horizon = profile?.collectingHorizonYears ?? null;
  const all = activeWindows(wines);

  const usable = all.filter((w) => w.from !== null || w.until !== null);
  const withoutWindow = all
    .filter((w) => w.from === null && w.until === null)
    .reduce((n, w) => n + w.bottles, 0);

  if (horizon === null) {
    return {
      horizonYears: null,
      beyondHorizonBottles: 0,
      beyondHorizonWines: 0,
      consumptionConflictBottles: 0,
      expectedConsumptionOverHorizon: null,
      drinkableWithinHorizon: 0,
      withoutWindow,
      evidence: { ...capacity.evidence, missingWindows: withoutWindow },
      hasHorizon: false,
    };
  }

  const end = currentYear + horizon;

  // Still drinkable after the horizon ends. Possibly deliberate.
  const beyond = usable.filter((w) => (w.until ?? Number.POSITIVE_INFINITY) > end);
  const beyondHorizonBottles = beyond.reduce((n, w) => n + w.bottles, 0);

  const drinkableWithinHorizon = usable
    .filter((w) => drinkableWithin(w, currentYear, horizon))
    .reduce((n, w) => n + w.bottles, 0);

  // Windows closing INSIDE the horizon: these must be drunk or lost.
  const closingInside = usable
    .filter((w) => {
      const closes = w.until;
      if (closes === null) return false;
      return closes >= currentYear && closes <= end;
    })
    .reduce((n, w) => n + w.bottles, 0);

  const expected =
    capacity.bottlesPerYear === null
      ? null
      : projectionRange(capacity.bottlesPerYear * horizon);

  const conflict = expected === null ? 0 : Math.max(0, closingInside - expected.high);

  return {
    horizonYears: horizon,
    beyondHorizonBottles,
    beyondHorizonWines: beyond.length,
    consumptionConflictBottles: conflict,
    expectedConsumptionOverHorizon: expected,
    drinkableWithinHorizon,
    withoutWindow,
    evidence: {
      ...capacity.evidence,
      missingWindows: withoutWindow,
      excludedBottles: withoutWindow,
    },
    hasHorizon: true,
  };
}

/** Bottles already past their window — a present fact, not a projection. */
export function pastWindowBottles(
  wines: WineSummary[],
  currentYear: number = new Date().getFullYear(),
): number {
  return wines
    .filter((w) => w.activeBottles > 0)
    .filter(
      (w) =>
        assessWindow({ from: w.wine.drinkFrom, until: w.wine.drinkUntil }, currentYear)
          .indicator === "past",
    )
    .reduce((n, w) => n + w.activeBottles, 0);
}
