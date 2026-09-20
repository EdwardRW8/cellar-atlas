/**
 * Consumption capacity.
 *
 * ── EVIDENCE, NOT A CONFIDENCE SCORE ─────────────────────────────────────
 * Every result carries an `Evidence` record naming what it was derived from:
 * how many bottles, over how long, and what was excluded. The UI turns that
 * into a sentence — "Based on 18 consumed bottles over 11 months" — so the
 * user can judge the claim themselves.
 *
 * There is deliberately no numeric confidence. "82% confident" is a number
 * with no defensible derivation; a sample size is a fact.
 *
 * ── WHY A FLOOR ──────────────────────────────────────────────────────────
 * A rate computed from two bottles is noise with a decimal point. Below the
 * floor the observed rate is SUPPRESSED rather than softened, and the profile
 * estimate is used instead — clearly labelled as an estimate.
 */

import type { DomainBottle } from "../types";
import type { CellarProfile } from "./types";

/**
 * Minimum evidence before an observed rate is trusted.
 *
 * MIN_CONSUMED_BOTTLES = 6 — fewer than six points cannot distinguish a
 * habit from a dinner party.
 *
 * MIN_HISTORY_DAYS = 90 — a shorter window is dominated by whatever happened
 * last week. Ninety days spans a season.
 *
 * Both must be met. Six bottles in one evening is not a rate.
 */
export const MIN_CONSUMED_BOTTLES = 6;
export const MIN_HISTORY_DAYS = 90;

/** Trailing window for the observed rate. A year absorbs seasonality. */
export const OBSERVATION_WINDOW_DAYS = 365;

export type EvidenceSource = "observed" | "profile" | "mixed" | "none";

export interface Evidence {
  source: EvidenceSource;
  /** Days between the earliest and latest event used. */
  historyDays?: number;
  /** Number of bottles the figure was derived from. */
  sampleSize?: number;
  /** Bottles excluded from a calculation, with the reason implied by context. */
  excludedBottles?: number;
  /** Wines or bottles omitted for want of a drinking window. */
  missingWindows?: number;
}

export interface ConsumptionCapacity {
  /** Bottles per year. Null when neither observation nor estimate exists. */
  bottlesPerYear: number | null;
  bottlesPerMonth: number | null;
  evidence: Evidence;
  /** True when the observed history cleared both floors. */
  isObserved: boolean;
}

/**
 * Statuses that represent a bottle actually being drunk.
 *
 * Gifted, sold and lost bottles left the cellar but were NOT consumed by the
 * owner, so they must not inflate a drinking rate. `removed` is an inventory
 * correction and never represents a real bottle.
 */
const CONSUMPTION_STATUSES = new Set(["consumed"]);

/** Statuses that removed a bottle from inventory without it being drunk. */
const DEPARTED_NOT_CONSUMED = new Set(["gifted", "sold", "lost"]);

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 86_400_000;
}

/**
 * Observed and estimated drinking capacity.
 *
 * `now` is injected so tests are deterministic.
 */
export function computeConsumptionCapacity(
  bottles: DomainBottle[],
  profile: CellarProfile | null,
  now: Date = new Date(),
): ConsumptionCapacity {
  const windowStart = new Date(now.getTime() - OBSERVATION_WINDOW_DAYS * 86_400_000);

  const consumedInWindow = bottles.filter((b) => {
    if (!CONSUMPTION_STATUSES.has(b.status)) return false;
    if (!b.statusChangedAt) return false;
    const at = new Date(b.statusChangedAt);
    return !Number.isNaN(at.getTime()) && at >= windowStart && at <= now;
  });

  const departedNotConsumed = bottles.filter((b) =>
    DEPARTED_NOT_CONSUMED.has(b.status),
  ).length;

  const sampleSize = consumedInWindow.length;

  // Span of the evidence, not the length of the window we looked at.
  let historyDays = 0;
  if (sampleSize > 0) {
    const times = consumedInWindow.map((b) => new Date(b.statusChangedAt!).getTime());
    historyDays = daysBetween(new Date(Math.min(...times)), now);
  }

  const profileMonthly = profile?.bottlesPerMonth ?? null;

  // ── Observed, if the evidence supports it ──
  if (sampleSize >= MIN_CONSUMED_BOTTLES && historyDays >= MIN_HISTORY_DAYS) {
    const perYear = (sampleSize / historyDays) * 365;
    return {
      bottlesPerYear: round1(perYear),
      bottlesPerMonth: round1(perYear / 12),
      isObserved: true,
      evidence: {
        source: profileMonthly !== null ? "mixed" : "observed",
        historyDays: Math.round(historyDays),
        sampleSize,
        excludedBottles: departedNotConsumed,
      },
    };
  }

  // ── Profile estimate ──
  if (profileMonthly !== null && profileMonthly > 0) {
    return {
      bottlesPerYear: round1(profileMonthly * 12),
      bottlesPerMonth: round1(profileMonthly),
      isObserved: false,
      evidence: {
        source: "profile",
        // Reported so the UI can explain why observation was not used.
        sampleSize,
        historyDays: Math.round(historyDays),
      },
    };
  }

  // ── Nothing to go on. Suppress rather than guess. ──
  return {
    bottlesPerYear: null,
    bottlesPerMonth: null,
    isObserved: false,
    evidence: { source: "none", sampleSize, historyDays: Math.round(historyDays) },
  };
}

/**
 * A plain-English band around a projection.
 *
 * Extrapolating a rate forward is not precise, so the result is a range.
 * ±25% is wide enough to be honest and narrow enough to be useful; it is a
 * presentational band, not a statistical interval, and is described as
 * "approximately" rather than as a confidence interval.
 */
export const PROJECTION_BAND = 0.25;

export interface Range {
  low: number;
  high: number;
}

export function projectionRange(value: number): Range {
  return {
    low: Math.max(0, Math.floor(value * (1 - PROJECTION_BAND))),
    high: Math.ceil(value * (1 + PROJECTION_BAND)),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
