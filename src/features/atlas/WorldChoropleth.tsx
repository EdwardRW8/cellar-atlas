import { useMemo } from "react";
import type { CountryGeometry } from "@/data/geo/world-geometry";
import {
  shadeIntensity,
  type AtlasNode,
  type AtlasMetric,
} from "@/domain/atlas-aggregation";

/**
 * World choropleth.
 *
 * ── THE TWO LAYERS ───────────────────────────────────────────────────────
 * NEUTRAL CONTEXT — all 171 Natural Earth countries render, so this is
 * recognisably a world map rather than a scattering of shapes. A country with
 * no collection data is drawn in a flat neutral tone, is not shaded, and is
 * not interactive.
 *
 * COLLECTION DATA — only countries present in the canonical `geo_regions`
 * hierarchy receive metric shading and become tappable. The shading comes
 * from `atlas-aggregation`, never from the geometry file.
 *
 * The two never mix. Drawing a country does not imply it holds wine.
 *
 * Region and appellation boundaries are NOT derived from this geometry.
 * Country outlines are country outlines.
 */

/** Equirectangular. Chosen for being trivially invertible and honest about
 *  its own distortion, rather than for looking impressive. */
export function project(lon: number, lat: number): { x: number; y: number } {
  return { x: lon, y: -lat };
}

const VIEW = { minX: -180, minY: -83, width: 360, height: 150 };

export function WorldChoropleth({
  geometry,
  nodes,
  metric,
  onSelectCountry,
  selectedCode,
}: {
  geometry: CountryGeometry[];
  nodes: AtlasNode[];
  metric: AtlasMetric;
  onSelectCountry: (code: string) => void;
  selectedCode: string | null;
}) {
  /** Canonical data, keyed by ISO code. Absent means "no collection data". */
  const byCode = useMemo(() => new Map(nodes.map((n) => [n.countryCode, n])), [nodes]);

  const paths = useMemo(
    () =>
      geometry.map((country) => ({
        iso: country.iso,
        name: country.name,
        d: toPath(country),
      })),
    [geometry],
  );

  return (
    <svg
      viewBox={`${VIEW.minX} ${VIEW.minY} ${VIEW.width} ${VIEW.height}`}
      style={{
        width: "100%",
        height: "auto",
        display: "block",
        touchAction: "manipulation",
      }}
      role="group"
      aria-label="World map of your collection"
    >
      {paths.map((p) => {
        const node = byCode.get(p.iso) ?? null;
        const intensity = node ? shadeIntensity(node, nodes, metric) : 0;
        const interactive = node !== null;
        const selected = p.iso === selectedCode;

        return (
          <path
            key={p.iso}
            d={p.d}
            // Neutral for everything without collection data.
            fill={
              node
                ? `rgba(217,174,85,${0.15 + intensity * 0.75})`
                : "rgba(255,255,255,0.05)"
            }
            stroke={selected ? "var(--accent-gold)" : "rgba(255,255,255,0.12)"}
            strokeWidth={selected ? 0.9 : 0.25}
            style={{ cursor: interactive ? "pointer" : "default" }}
            onClick={interactive ? () => onSelectCountry(p.iso) : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={
              node
                ? `${node.name}: ${node.bottles} bottle${node.bottles === 1 ? "" : "s"}`
                : undefined
            }
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectCountry(p.iso);
                    }
                  }
                : undefined
            }
          />
        );
      })}
    </svg>
  );
}

/** Country outline as an SVG path. Rings are closed with Z. */
function toPath(country: CountryGeometry): string {
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

export default WorldChoropleth;
