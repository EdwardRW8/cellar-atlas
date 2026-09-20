import { useMemo } from "react";
import type { CountryGeometry } from "@/data/geo/world-geometry";
import { project } from "./WorldChoropleth";
import {
  symbolRadius,
  formatMetric,
  type AtlasNode,
  type AtlasMetric,
} from "@/domain/atlas-aggregation";

/**
 * Country view — proportional symbols at verified centroids.
 *
 * ── WHY CIRCLES AND NOT SHAPES ───────────────────────────────────────────
 * Wine-region boundaries are not reliably available under an open licence.
 * French appellation boundaries sit with the INAO; equivalents elsewhere are
 * no better. Hand-drawing approximations would look authoritative while being
 * wrong.
 *
 * A circle at a real coordinate does not claim to be a territory. Proportional
 * symbol mapping is a legitimate cartographic technique and it is honest about
 * its own precision — which is why the precision recorded in `geo_regions` is
 * carried through and shown, rather than hidden.
 *
 * The country OUTLINE comes from Natural Earth country geometry. No region
 * boundary is inferred from it.
 */
export function CountrySymbols({
  countryGeometry,
  countryName,
  regions,
  metric,
  onSelectRegion,
  selectedRegionId,
}: {
  countryGeometry: CountryGeometry | null;
  countryName: string;
  regions: AtlasNode[];
  metric: AtlasMetric;
  onSelectRegion: (regionId: string) => void;
  selectedRegionId: string | null;
}) {
  /** Only regions with a verified coordinate can be placed. */
  const placeable = useMemo(
    () => regions.filter((r) => r.latitude !== null && r.longitude !== null),
    [regions],
  );
  const unplaceable = regions.length - placeable.length;

  const bounds = useMemo(() => {
    const points: { x: number; y: number }[] = [];

    if (countryGeometry) {
      for (const polygon of countryGeometry.polygons) {
        for (const ring of polygon) {
          for (const [lon, lat] of ring) points.push(project(lon, lat));
        }
      }
    }
    for (const r of placeable) points.push(project(r.longitude!, r.latitude!));

    if (points.length === 0) return null;

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const pad = 2;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      minX,
      minY,
      width: Math.max(1, Math.max(...xs) - minX + pad),
      height: Math.max(1, Math.max(...ys) - minY + pad),
    };
  }, [countryGeometry, placeable]);

  if (!bounds) {
    return (
      <p style={{ color: "var(--text-tertiary)", fontSize: "0.875rem" }}>
        No mapped regions for {countryName} yet.
      </p>
    );
  }

  return (
    <div>
      <svg
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          touchAction: "manipulation",
        }}
        role="group"
        aria-label={`Regions of ${countryName}`}
      >
        {countryGeometry && (
          <path
            d={outlinePath(countryGeometry)}
            fill="rgba(255,255,255,0.05)"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={bounds.width / 400}
          />
        )}

        {placeable.map((r) => {
          const { x, y } = project(r.longitude!, r.latitude!);
          const radius = symbolRadius(
            r,
            placeable,
            metric,
            bounds.width / 120,
            bounds.width / 22,
          );
          const selected = r.id === selectedRegionId;

          return (
            <g
              key={r.id}
              onClick={() => onSelectRegion(r.id)}
              role="button"
              tabIndex={0}
              aria-label={`${r.name}: ${formatMetric(r, metric)}`}
              style={{ cursor: "pointer" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectRegion(r.id);
                }
              }}
            >
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill="rgba(217,174,85,0.45)"
                stroke={selected ? "var(--accent-gold)" : "rgba(217,174,85,0.9)"}
                strokeWidth={selected ? bounds.width / 200 : bounds.width / 600}
              />
            </g>
          );
        })}
      </svg>

      {/* Honesty note. Circles are points, not territories. */}
      <p
        style={{
          fontSize: "0.6875rem",
          color: "var(--text-tertiary)",
          marginTop: "0.625rem",
          lineHeight: 1.6,
        }}
      >
        Circles mark region centre points sized by {metric}. They are locations, not
        territory boundaries — reliable open boundary data for wine regions does not exist.
        {unplaceable > 0 && (
          <>
            {" "}
            {unplaceable} region{unplaceable === 1 ? "" : "s"} could not be placed and{" "}
            {unplaceable === 1 ? "is" : "are"} listed below.
          </>
        )}
      </p>
    </div>
  );
}

function outlinePath(country: CountryGeometry): string {
  const parts: string[] = [];
  for (const polygon of country.polygons) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      const points = ring.map(([lon, lat]) => {
        const { x, y } = project(lon, lat);
        return `${x},${y}`;
      });
      parts.push(`M${points.join("L")}Z`);
    }
  }
  return parts.join(" ");
}

export default CountrySymbols;
