/**
 * Collection balance.
 *
 * ── FACTS, NOT JUDGEMENTS ────────────────────────────────────────────────
 * "62% of your bottles are from one country" is a fact. "Your collection is
 * too concentrated" is an opinion the app is not entitled to hold — a Burgundy
 * specialist's cellar is meant to look concentrated.
 *
 * So shares are reported and nothing is scored, ranked as good or bad, or
 * flagged as a problem.
 *
 * ── PRODUCER MATCHING ────────────────────────────────────────────────────
 * Producers are free text with no canonical id. Matching is therefore exact
 * after trimming and case-folding only. "Ch. Margaux" and "Château Margaux"
 * stay separate, which understates concentration — the honest direction to
 * err, since the alternative is silently merging two different estates.
 */

import type { WineSummary } from "../types";

export interface ConcentrationSlice {
  key: string;
  label: string;
  bottles: number;
  wines: number;
  /** Share of classified bottles, 0–100. */
  percentage: number;
}

export interface ConcentrationDimension {
  dimension: "colour" | "country" | "producer" | "decade";
  label: string;
  slices: ConcentrationSlice[];
  /** Bottles carrying a value for this dimension. */
  classifiedBottles: number;
  /** Bottles with the field blank — excluded from percentages. */
  unclassifiedBottles: number;
  /** The largest slice, or null when nothing is classified. */
  largest: ConcentrationSlice | null;
}

/** Slices below this are grouped, purely to keep the list readable. */
export const MIN_SLICE_PERCENT = 3;

function build(
  dimension: ConcentrationDimension["dimension"],
  label: string,
  wines: WineSummary[],
  keyOf: (w: WineSummary) => { key: string; label: string } | null,
): ConcentrationDimension {
  const owned = wines.filter((w) => w.activeBottles > 0);
  const buckets = new Map<string, ConcentrationSlice>();
  let classified = 0;
  let unclassified = 0;

  for (const w of owned) {
    const k = keyOf(w);
    if (!k) {
      unclassified += w.activeBottles;
      continue;
    }
    classified += w.activeBottles;
    const existing = buckets.get(k.key);
    if (existing) {
      existing.bottles += w.activeBottles;
      existing.wines += 1;
    } else {
      buckets.set(k.key, {
        key: k.key,
        label: k.label,
        bottles: w.activeBottles,
        wines: 1,
        percentage: 0,
      });
    }
  }

  const slices = [...buckets.values()].sort(
    (a, b) => b.bottles - a.bottles || a.label.localeCompare(b.label),
  );
  for (const s of slices) {
    s.percentage = classified === 0 ? 0 : Math.round((s.bottles / classified) * 1000) / 10;
  }

  return {
    dimension,
    label,
    slices,
    classifiedBottles: classified,
    unclassifiedBottles: unclassified,
    largest: slices[0] ?? null,
  };
}

export function computeConcentration(wines: WineSummary[]): ConcentrationDimension[] {
  return [
    build("colour", "Type", wines, (w) =>
      w.wine.colour ? { key: w.wine.colour, label: w.wine.colour } : null,
    ),

    // Canonical geography only — never the free-text fallback.
    build("country", "Country", wines, (w) => {
      const c = w.wine.geography.country;
      return c ? { key: c.code, label: c.name } : null;
    }),

    build("producer", "Producer", wines, (w) => {
      const p = w.wine.producer.trim();
      return p ? { key: p.toLowerCase(), label: p } : null;
    }),

    build("decade", "Vintage", wines, (w) => {
      const v = w.wine.vintage;
      if (v === null) return null;
      const decade = Math.floor(v / 10) * 10;
      return { key: String(decade), label: `${decade}s` };
    }),
  ];
}

/** Slices at or above the threshold, with the remainder grouped. */
export function significantSlices(
  d: ConcentrationDimension,
  minPercent: number = MIN_SLICE_PERCENT,
): ConcentrationSlice[] {
  const major = d.slices.filter((s) => s.percentage >= minPercent);
  const minor = d.slices.filter((s) => s.percentage < minPercent);
  if (minor.length === 0) return major;

  const bottles = minor.reduce((n, s) => n + s.bottles, 0);
  return [
    ...major,
    {
      key: "__other__",
      label: `${minor.length} other${minor.length === 1 ? "" : "s"}`,
      bottles,
      wines: minor.reduce((n, s) => n + s.wines, 0),
      percentage:
        d.classifiedBottles === 0
          ? 0
          : Math.round((bottles / d.classifiedBottles) * 1000) / 10,
    },
  ];
}
