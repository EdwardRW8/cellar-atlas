import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import { GeographyPicker, type GeoSelection } from "@/features/add-wine/GeographyPicker";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Bulk geography fix.
 *
 * `docs/atlas.md` makes incomplete geography actionable rather than merely
 * visible: "12 wines need geographic information", tappable, leading here.
 *
 * ── NO NEW WRITE ARCHITECTURE ────────────────────────────────────────────
 * Reuses the Phase 3 GeographyPicker and the existing
 * `update_wine_definition` RPC through `useCellar().run()`. That means the
 * established version check, conflict handling, idempotency and RLS all
 * apply unchanged. No new RPC, no direct table write, no service role.
 */
export default function GeographyFixScreen() {
  const { state, wines, run } = useCellar();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  /** Wines the user owns that have no canonical country. */
  const needsGeography = useMemo(
    () => wines.filter((w) => w.activeBottles > 0 && w.wine.geography.country === null),
    [wines],
  );

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Skeleton rows={3} />
      </div>
    );
  }

  const apply = async (
    wineId: string,
    version: number,
    name: string,
    selection: GeoSelection,
  ) => {
    setBusyId(wineId);
    setFailed(null);

    const outcome = await run(`Set geography for ${name}`, (m) =>
      m.updateWine({
        wineId,
        version,
        patch: {
          geo_region_id: selection.geoRegionId,
          country_code: selection.countryCode,
          region_text: selection.regionText,
        },
      }),
    );

    setBusyId(null);
    if (!outcome.ok) {
      setFailed(outcome.error ?? "Could not save. Your change is queued.");
    }
  };

  return (
    <div style={{ padding: "1.25rem" }}>
      <button
        onClick={() => navigate("/atlas")}
        style={{
          minHeight: TOUCH_TARGET_MIN_PX,
          color: "var(--text-tertiary)",
          fontSize: "0.8125rem",
          marginBottom: "0.5rem",
        }}
      >
        ← Atlas
      </button>

      <header style={{ marginBottom: "1.25rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
            fontStyle: "italic",
          }}
        >
          Add geography
        </h1>
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            marginTop: "0.375rem",
            lineHeight: 1.6,
          }}
        >
          These wines are not on the map because they have no matched region. Search the
          atlas for each one, or record free text where nothing matches.
        </p>
      </header>

      {failed && (
        <p
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: 10,
            marginBottom: "1rem",
            background: "rgba(255,138,122,0.08)",
            border: "1px solid rgba(255,138,122,0.25)",
            color: "var(--status-past)",
            fontSize: "0.8125rem",
          }}
        >
          {failed}
        </p>
      )}

      {needsGeography.length === 0 ? (
        <EmptyState
          title="Every wine is mapped"
          description="Nothing needs geographic information right now."
          action={<Button onClick={() => navigate("/atlas")}>Back to Atlas</Button>}
        />
      ) : (
        <ul
          style={{
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {needsGeography.map((w) => (
            <li
              key={w.wine.id}
              style={{
                padding: "1rem",
                borderRadius: 12,
                background: "var(--surface-raised)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ marginBottom: "0.75rem" }}>
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "1.0625rem",
                    color: "var(--text-primary)",
                  }}
                >
                  {w.wine.name}
                  {w.wine.vintage ? ` ${w.wine.vintage}` : ""}
                </div>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-tertiary)",
                    marginTop: 2,
                  }}
                >
                  {w.wine.producer} · {w.activeBottles} bottle
                  {w.activeBottles === 1 ? "" : "s"}
                  {w.wine.geography.unmatched && (
                    <> · currently “{w.wine.geography.unmatched}”</>
                  )}
                </div>
              </div>

              <GeographyPicker
                value={{
                  geoRegionId: null,
                  countryCode: null,
                  regionText: null,
                  label: null,
                }}
                onChange={(selection) =>
                  void apply(w.wine.id, w.wine.version, w.wine.name, selection)
                }
              />

              {busyId === w.wine.id && (
                <p
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--accent-gold)",
                    marginTop: "0.5rem",
                  }}
                >
                  Saving…
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
