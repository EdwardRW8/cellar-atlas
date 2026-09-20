import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  buildAtlasData,
  formatMetric,
  ATLAS_METRICS,
  type AtlasMetric,
  type AtlasNode,
} from "@/domain/atlas-aggregation";
import type { CountryGeometry } from "@/data/geo/world-geometry";
import { AtlasBoundary } from "./AtlasBoundary";
import { AppellationList } from "./AppellationList";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Atlas — the geographic view of the collection.
 *
 * Three levels, three honest approaches (docs/atlas.md):
 *
 *   World       true choropleth over real country polygons
 *   Country     proportional symbols at verified centroids
 *   Appellation ranked comparison, NO MAP
 *
 * The geometry asset and both map components are lazily imported, so an 83 KB
 * dataset never enters the initial bundle. Tests assert that.
 */

const WorldChoropleth = lazy(() => import("./WorldChoropleth"));
const CountrySymbols = lazy(() => import("./CountrySymbols"));

type Level =
  | { kind: "world" }
  | { kind: "country"; code: string }
  | { kind: "region"; code: string; regionId: string };

export default function Atlas() {
  const { state, error, wines, repository, refresh } = useCellar();
  const navigate = useNavigate();

  const [level, setLevel] = useState<Level>({ kind: "world" });
  const [metric, setMetric] = useState<AtlasMetric>("bottles");
  const [geometry, setGeometry] = useState<CountryGeometry[] | null>(null);
  const [geoError, setGeoError] = useState(false);
  const [centroids, setCentroids] = useState<
    Map<string, { latitude: number | null; longitude: number | null; precision: string }>
  >(new Map());

  // Country geometry: loaded on first open, never in the initial bundle.
  useEffect(() => {
    let cancelled = false;
    void import("@/data/geo/world-geometry")
      .then((m) => {
        if (!cancelled) setGeometry(m.default);
      })
      .catch(() => {
        if (!cancelled) setGeoError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Verified centroids from the canonical hierarchy.
  useEffect(() => {
    if (!repository) return;
    let cancelled = false;
    void repository
      .loadGeoCentroids()
      .then((m) => {
        if (!cancelled) setCentroids(m);
      })
      .catch(() => {
        /* Aggregation still works; symbols simply cannot be placed. */
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const data = useMemo(() => buildAtlasData(wines, centroids), [wines, centroids]);

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <Skeleton rows={3} />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <div
          role="alert"
          style={{
            padding: "1.25rem",
            borderRadius: 14,
            background: "var(--surface-raised)",
            border: "1px solid rgba(255,138,122,0.3)",
          }}
        >
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.875rem",
              marginBottom: "1rem",
            }}
          >
            {error}
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (data.isEmpty) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Header />
        <EmptyState
          title="Nothing to map yet"
          description="Add wines with a region and this page will show where your collection comes from."
          action={<Button onClick={() => navigate("/add")}>Add a wine</Button>}
        />
      </div>
    );
  }

  const country =
    level.kind !== "world"
      ? (data.countries.find((c) => c.countryCode === level.code) ?? null)
      : null;

  const regions = country ? (data.regionsByCountry[country.countryCode] ?? []) : [];

  const region =
    level.kind === "region" ? (regions.find((r) => r.id === level.regionId) ?? null) : null;

  const appellations = region ? (data.appellationsByRegion[region.id] ?? []) : [];

  return (
    <div style={{ padding: "1.25rem" }}>
      <Header />

      <Breadcrumb
        level={level}
        countryName={country?.name ?? null}
        regionName={region?.name ?? null}
        onWorld={() => setLevel({ kind: "world" })}
        onCountry={() =>
          country && setLevel({ kind: "country", code: country.countryCode })
        }
      />

      <MetricSwitcher metric={metric} onChange={setMetric} />

      {/* Value here sums only bottles that HAVE a valuation. Saying so stops
          the map implying the whole collection has been valued. */}
      {metric === "value" && (
        <p
          style={{
            fontSize: "0.6875rem",
            color: "var(--text-tertiary)",
            marginTop: "-0.5rem",
            marginBottom: "1rem",
            lineHeight: 1.6,
          }}
        >
          Value covers only bottles with a recorded valuation, and is not combined across
          currencies.
        </p>
      )}

      {/* Incomplete geography is surfaced, never hidden. */}
      {data.unmapped.wines > 0 && (
        <button
          type="button"
          onClick={() => navigate("/atlas/fix")}
          style={{
            width: "100%",
            textAlign: "left",
            minHeight: TOUCH_TARGET_MIN_PX,
            padding: "0.75rem 1rem",
            borderRadius: 10,
            marginBottom: "1rem",
            background: "rgba(245,181,68,0.08)",
            border: "1px solid rgba(245,181,68,0.3)",
            color: "var(--status-approaching)",
            fontSize: "0.8125rem",
          }}
        >
          {data.unmapped.wines} wine{data.unmapped.wines === 1 ? "" : "s"} need geographic
          information
          {data.unmapped.bottles > 0 && (
            <> · {data.unmapped.bottles} bottles not shown on the map</>
          )}
          <span style={{ color: "var(--accent-gold)" }}> →</span>
        </button>
      )}

      <AtlasBoundary
        fallback={
          <NodeList
            nodes={
              level.kind === "world"
                ? data.countries
                : level.kind === "country"
                  ? regions
                  : appellations
            }
            metric={metric}
            onSelect={() => {}}
          />
        }
      >
        <Suspense fallback={<Skeleton rows={2} />}>
          {level.kind === "world" && (
            <>
              {geoError ? (
                <p
                  role="alert"
                  style={{ color: "var(--status-approaching)", fontSize: "0.8125rem" }}
                >
                  The world map could not be loaded. Your collection is listed below.
                </p>
              ) : geometry ? (
                <WorldChoropleth
                  geometry={geometry}
                  nodes={data.countries}
                  metric={metric}
                  selectedCode={null}
                  onSelectCountry={(code) => setLevel({ kind: "country", code })}
                />
              ) : (
                <Skeleton rows={2} />
              )}
              <NodeList
                nodes={data.countries}
                metric={metric}
                onSelect={(n) => setLevel({ kind: "country", code: n.countryCode })}
              />
            </>
          )}

          {level.kind === "country" && country && (
            <>
              {geometry && (
                <CountrySymbols
                  countryGeometry={
                    geometry.find((g) => g.iso === country.countryCode) ?? null
                  }
                  countryName={country.name}
                  regions={regions}
                  metric={metric}
                  selectedRegionId={null}
                  onSelectRegion={(regionId) =>
                    setLevel({ kind: "region", code: country.countryCode, regionId })
                  }
                />
              )}
              <NodeList
                nodes={regions}
                metric={metric}
                onSelect={(n) =>
                  setLevel({
                    kind: "region",
                    code: country.countryCode,
                    regionId: n.id,
                  })
                }
              />
            </>
          )}

          {level.kind === "region" && region && (
            <AppellationList
              appellations={appellations}
              regionName={region.name}
              metric={metric}
            />
          )}
        </Suspense>
      </AtlasBoundary>
    </div>
  );
}

function Header() {
  return (
    <header style={{ marginBottom: "1rem" }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.875rem",
          fontStyle: "italic",
        }}
      >
        Atlas
      </h1>
      <p
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginTop: "0.25rem",
        }}
      >
        Where your collection comes from
      </p>
    </header>
  );
}

function Breadcrumb({
  level,
  countryName,
  regionName,
  onWorld,
  onCountry,
}: {
  level: Level;
  countryName: string | null;
  regionName: string | null;
  onWorld: () => void;
  onCountry: () => void;
}) {
  if (level.kind === "world") return null;

  return (
    <nav
      aria-label="Atlas level"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        onClick={onWorld}
        style={{
          minHeight: TOUCH_TARGET_MIN_PX,
          padding: "0 0.5rem",
          color: "var(--accent-gold)",
          fontSize: "0.8125rem",
        }}
      >
        World
      </button>
      <span style={{ color: "var(--text-tertiary)" }}>›</span>
      {level.kind === "region" ? (
        <>
          <button
            type="button"
            onClick={onCountry}
            style={{
              minHeight: TOUCH_TARGET_MIN_PX,
              padding: "0 0.5rem",
              color: "var(--accent-gold)",
              fontSize: "0.8125rem",
            }}
          >
            {countryName}
          </button>
          <span style={{ color: "var(--text-tertiary)" }}>›</span>
          <span style={{ color: "var(--text-primary)", fontSize: "0.8125rem" }}>
            {regionName}
          </span>
        </>
      ) : (
        <span style={{ color: "var(--text-primary)", fontSize: "0.8125rem" }}>
          {countryName}
        </span>
      )}
    </nav>
  );
}

function MetricSwitcher({
  metric,
  onChange,
}: {
  metric: AtlasMetric;
  onChange: (m: AtlasMetric) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Metric"
      style={{ display: "flex", gap: 6, marginBottom: "1rem", flexWrap: "wrap" }}
    >
      {ATLAS_METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          role="radio"
          aria-checked={metric === m.key}
          onClick={() => onChange(m.key)}
          style={{
            minHeight: TOUCH_TARGET_MIN_PX - 8,
            padding: "0.5rem 0.875rem",
            borderRadius: 999,
            fontSize: "0.8125rem",
            background:
              metric === m.key ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${
              metric === m.key ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"
            }`,
            color: metric === m.key ? "var(--accent-gold)" : "var(--text-secondary)",
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** Always shown beneath the map, and used as the failure fallback. */
function NodeList({
  nodes,
  metric,
  onSelect,
}: {
  nodes: AtlasNode[];
  metric: AtlasMetric;
  onSelect: (node: AtlasNode) => void;
}) {
  if (nodes.length === 0) return null;

  return (
    <ul
      style={{
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: "1rem",
      }}
    >
      {nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => onSelect(n)}
            style={{
              width: "100%",
              textAlign: "left",
              minHeight: TOUCH_TARGET_MIN_PX,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "0.625rem 0.875rem",
              borderRadius: 10,
              background: "var(--surface-raised)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <span style={{ fontSize: "0.9375rem", color: "var(--text-primary)" }}>
              {n.name}
            </span>
            <span style={{ fontSize: "0.8125rem", color: "var(--accent-gold)" }}>
              {formatMetric(n, metric)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
