/**
 * Atlas aggregation.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 * DO NOT FAKE GEOGRAPHY.
 *
 * Collection data is aggregated ONLY through the canonical `geo_regions`
 * hierarchy. A wine contributes to a country node because its `geoRegionId`
 * resolves there, never because its free text happens to look like a place
 * name. Nothing here infers a location.
 *
 * The world map draws all 171 Natural Earth countries as neutral context, but
 * that is presentation. This module never invents a data node to match a
 * country outline, and a country with no canonical wines simply has no node.
 *
 * ── INCOMPLETE GEOGRAPHY IS A FIRST-CLASS STATE ──────────────────────────
 * Wines without a resolved region are counted in `unmapped` and surfaced, not
 * discarded. `docs/atlas.md`: "Atlas works with partial data from the first
 * bottle." A test asserts nothing is silently dropped.
 *
 * ── FACTUAL ONLY ─────────────────────────────────────────────────────────
 * Four metrics, all deterministic counts or sums: bottles, value, percentage,
 * ready to drink. No scoring, no trends, no recommendations — Phase 8.
 */

import type { WineSummary } from "./types";
import { assessWindow } from "./drinking-window";

export type AtlasMetric = "bottles" | "value" | "percentage" | "ready";

export const ATLAS_METRICS: { key: AtlasMetric; label: string }[] = [
  { key: "bottles", label: "Bottles" },
  { key: "value", label: "Value" },
  { key: "percentage", label: "Share" },
  { key: "ready", label: "Ready" },
];

export interface AtlasNode {
  /** Canonical geo_regions id, or the ISO code at country level. */
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2. Present at every level; regions inherit it. */
  countryCode: string;
  bottles: number;
  wines: number;
  value: number;
  /** Share of the whole mapped collection, 0–100. */
  percentage: number;
  readyBottles: number;
  /** Verified centroid. Null when the canonical row has no coordinate. */
  latitude: number | null;
  longitude: number | null;
  /**
   * How precise that coordinate is, straight from the database. Carried so
   * the UI can be honest rather than implying survey accuracy.
   */
  centroidPrecision: "exact" | "approximate" | "none";
}

export interface UnmappedSummary {
  wines: number;
  bottles: number;
  /** Free text the user supplied that matched no canonical node. */
  examples: string[];
}

export interface AtlasData {
  countries: AtlasNode[];
  /** Regions grouped by their country's ISO code. */
  regionsByCountry: Record<string, AtlasNode[]>;
  /** Appellations grouped by their parent region id. */
  appellationsByRegion: Record<string, AtlasNode[]>;
  unmapped: UnmappedSummary;
  totalMappedBottles: number;
  isEmpty: boolean;
}

const emptyNode = (id: string, name: string, countryCode: string): AtlasNode => ({
  id,
  name,
  countryCode,
  bottles: 0,
  wines: 0,
  value: 0,
  percentage: 0,
  readyBottles: 0,
  latitude: null,
  longitude: null,
  centroidPrecision: "none",
});

/**
 * Build every level in one pass.
 *
 * `geoLookup` supplies verified coordinates from `geo_regions`. It is optional
 * because aggregation must work before coordinates load — a country with no
 * coordinate still counts its bottles; it simply cannot be placed as a symbol.
 */
export function buildAtlasData(
  wines: WineSummary[],
  geoLookup?: Map<
    string,
    { latitude: number | null; longitude: number | null; precision: string }
  >,
  currentYear?: number,
): AtlasData {
  const countries = new Map<string, AtlasNode>();
  const regions = new Map<string, AtlasNode>();
  const appellations = new Map<string, AtlasNode>();
  const regionCountry = new Map<string, string>();
  const appellationRegion = new Map<string, string>();

  const unmapped: UnmappedSummary = { wines: 0, bottles: 0, examples: [] };
  let totalMappedBottles = 0;

  const applyCoords = (node: AtlasNode, key: string) => {
    const geo = geoLookup?.get(key);
    if (!geo) return;
    node.latitude = geo.latitude;
    node.longitude = geo.longitude;
    node.centroidPrecision = geo.precision as AtlasNode["centroidPrecision"];
  };

  for (const w of wines) {
    if (w.activeBottles === 0) continue;

    const { country, region, appellation, unmatched } = w.wine.geography;
    const bottles = w.activeBottles;
    const value = w.totalValue ?? 0;
    const ready =
      assessWindow({ from: w.wine.drinkFrom, until: w.wine.drinkUntil }, currentYear)
        .indicator === "ready"
        ? bottles
        : 0;

    // No canonical country means no map position. Counted, never discarded.
    if (!country) {
      unmapped.wines += 1;
      unmapped.bottles += bottles;
      const hint = unmatched ?? w.wine.producer;
      if (hint && unmapped.examples.length < 5 && !unmapped.examples.includes(hint)) {
        unmapped.examples.push(hint);
      }
      continue;
    }

    totalMappedBottles += bottles;

    // ── Country ──
    let c = countries.get(country.code);
    if (!c) {
      c = emptyNode(country.id, country.name, country.code);
      applyCoords(c, country.id);
      countries.set(country.code, c);
    }
    c.bottles += bottles;
    c.wines += 1;
    c.value += value;
    c.readyBottles += ready;

    // ── Region ──
    if (region) {
      let r = regions.get(region.id);
      if (!r) {
        r = emptyNode(region.id, region.name, country.code);
        applyCoords(r, region.id);
        regions.set(region.id, r);
        regionCountry.set(region.id, country.code);
      }
      r.bottles += bottles;
      r.wines += 1;
      r.value += value;
      r.readyBottles += ready;

      // ── Appellation ──
      if (appellation) {
        let a = appellations.get(appellation.id);
        if (!a) {
          a = emptyNode(appellation.id, appellation.name, country.code);
          applyCoords(a, appellation.id);
          appellations.set(appellation.id, a);
          appellationRegion.set(appellation.id, region.id);
        }
        a.bottles += bottles;
        a.wines += 1;
        a.value += value;
        a.readyBottles += ready;
      }
    }
  }

  // Percentages are of the MAPPED collection, so they sum to 100 at country
  // level. Including unmapped wines would make them sum to less, which reads
  // as an arithmetic error rather than as missing data.
  const share = (n: AtlasNode) => {
    n.percentage =
      totalMappedBottles === 0
        ? 0
        : Math.round((n.bottles / totalMappedBottles) * 1000) / 10;
  };
  countries.forEach(share);
  regions.forEach(share);
  appellations.forEach(share);

  const byBottles = (a: AtlasNode, b: AtlasNode) =>
    b.bottles - a.bottles || a.name.localeCompare(b.name);

  const regionsByCountry: Record<string, AtlasNode[]> = {};
  for (const [id, node] of regions) {
    const code = regionCountry.get(id)!;
    (regionsByCountry[code] ??= []).push(node);
  }
  Object.values(regionsByCountry).forEach((list) => list.sort(byBottles));

  const appellationsByRegion: Record<string, AtlasNode[]> = {};
  for (const [id, node] of appellations) {
    const regionId = appellationRegion.get(id)!;
    (appellationsByRegion[regionId] ??= []).push(node);
  }
  Object.values(appellationsByRegion).forEach((list) => list.sort(byBottles));

  return {
    countries: [...countries.values()].sort(byBottles),
    regionsByCountry,
    appellationsByRegion,
    unmapped,
    totalMappedBottles,
    isEmpty: countries.size === 0 && unmapped.wines === 0,
  };
}

/** The value of a node under the selected metric. */
export function metricValue(node: AtlasNode, metric: AtlasMetric): number {
  switch (metric) {
    case "bottles":
      return node.bottles;
    case "value":
      return node.value;
    case "percentage":
      return node.percentage;
    case "ready":
      return node.readyBottles;
  }
}

export function formatMetric(node: AtlasNode, metric: AtlasMetric): string {
  const v = metricValue(node, metric);
  switch (metric) {
    case "bottles":
      return `${v} bottle${v === 1 ? "" : "s"}`;
    case "value":
      return v > 0
        ? new Intl.NumberFormat("en-GB", {
            style: "currency",
            currency: "GBP",
            maximumFractionDigits: 0,
          }).format(v)
        : "—";
    case "percentage":
      return `${v}%`;
    case "ready":
      return `${v} ready`;
  }
}

/**
 * Shading intensity, 0–1, relative to the largest node.
 *
 * Returns 0 for every node when nothing has a value under this metric, so a
 * collection with no valuations does not shade every country identically and
 * imply data that is not there.
 */
export function shadeIntensity(
  node: AtlasNode,
  nodes: AtlasNode[],
  metric: AtlasMetric,
): number {
  const max = Math.max(...nodes.map((n) => metricValue(n, metric)), 0);
  if (max <= 0) return 0;
  const v = metricValue(node, metric);
  if (v <= 0) return 0;
  // Square root keeps small holdings visible against a dominant one.
  return Math.sqrt(v / max);
}

/** Symbol radius for proportional-symbol mapping, in map units. */
export function symbolRadius(
  node: AtlasNode,
  nodes: AtlasNode[],
  metric: AtlasMetric,
  minRadius = 0.6,
  maxRadius = 4,
): number {
  const max = Math.max(...nodes.map((n) => metricValue(n, metric)), 0);
  const v = metricValue(node, metric);
  if (max <= 0 || v <= 0) return minRadius;
  // Area proportional to value — the correct convention for symbol maps.
  return minRadius + (maxRadius - minRadius) * Math.sqrt(v / max);
}

/** Only these countries may be shaded or drilled into. */
export function interactiveCountryCodes(data: AtlasData): Set<string> {
  return new Set(data.countries.map((c) => c.countryCode));
}
