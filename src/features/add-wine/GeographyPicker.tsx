import { useEffect, useMemo, useRef, useState } from "react";
import { useCellar } from "@/hooks/useCellar";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Searchable picker over the canonical `geo_regions` hierarchy.
 *
 * Typing "Pauillac" finds the appellation and stores its `geoRegionId`, so
 * Atlas can later aggregate reliably. Free text remains available for
 * genuinely unmapped places and is stored in `regionText` instead — Atlas
 * surfaces those as needing attention rather than silently dropping them.
 *
 * The seeded hierarchy is country → region → subregion → appellation, so a
 * result carries its ancestry for disambiguation: two "Saint-Julien" entries
 * in different countries would be distinguishable.
 */

export interface GeoResult {
  id: string;
  name: string;
  level: string;
  country_code: string;
  parent_id: string | null;
}

export interface GeoSelection {
  geoRegionId: string | null;
  countryCode: string | null;
  /** Only set when the user chose free text over a canonical node. */
  regionText: string | null;
  /** For display: "Pauillac · Bordeaux · France". */
  label: string | null;
}

const LEVEL_LABEL: Record<string, string> = {
  country: "Country",
  region: "Region",
  subregion: "Subregion",
  appellation: "Appellation",
};

export function GeographyPicker({
  value,
  onChange,
}: {
  value: GeoSelection;
  onChange: (selection: GeoSelection) => void;
}) {
  const { repository } = useCellar();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [ancestry, setAncestry] = useState<Map<string, GeoResult>>(new Map());
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search. Two characters minimum, matching the repository.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);

    if (term.trim().length < 2 || !repository) {
      setResults([]);
      setSearchFailed(false);
      return;
    }

    setSearching(true);
    debounce.current = setTimeout(() => {
      void repository
        .searchGeography(term)
        .then(async (rows) => {
          const found = rows as unknown as GeoResult[];
          setResults(found);
          setSearchFailed(false);

          // Fetch ancestors so each result can show its full path.
          const parentIds = found
            .map((r) => r.parent_id)
            .filter((id): id is string => Boolean(id) && !ancestry.has(id!));
          if (parentIds.length > 0) {
            const parents = await repository
              .searchGeographyByIds(parentIds)
              .catch(() => [] as GeoResult[]);
            setAncestry((prev) => {
              const next = new Map(prev);
              for (const p of parents as GeoResult[]) next.set(p.id, p);
              return next;
            });
          }
        })
        .catch(() => {
          setResults([]);
          setSearchFailed(true);
        })
        .finally(() => setSearching(false));
    }, 250);

    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [term, repository]); // eslint-disable-line

  const describe = useMemo(
    () =>
      (r: GeoResult): string => {
        const parts = [r.name];
        let parent = r.parent_id ? ancestry.get(r.parent_id) : undefined;
        let guard = 0;
        while (parent && guard++ < 4) {
          parts.push(parent.name);
          parent = parent.parent_id ? ancestry.get(parent.parent_id) : undefined;
        }
        return parts.join(" · ");
      },
    [ancestry],
  );

  const select = (r: GeoResult) => {
    onChange({
      geoRegionId: r.id,
      countryCode: r.country_code,
      regionText: null,
      label: describe(r),
    });
    setTerm("");
    setResults([]);
  };

  const useFreeText = () => {
    onChange({
      geoRegionId: null,
      countryCode: value.countryCode,
      regionText: term.trim(),
      label: null,
    });
    setTerm("");
    setResults([]);
  };

  const clear = () =>
    onChange({ geoRegionId: null, countryCode: null, regionText: null, label: null });

  // ── Already chosen ──────────────────────────────────────────────────────
  if (value.geoRegionId || value.regionText) {
    const canonical = Boolean(value.geoRegionId);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0.75rem 0.875rem",
          borderRadius: 10,
          background: canonical ? "rgba(110,231,160,0.06)" : "rgba(245,181,68,0.06)",
          border: `1px solid ${canonical ? "rgba(110,231,160,0.25)" : "rgba(245,181,68,0.25)"}`,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "0.9375rem",
              color: "var(--text-primary)",
            }}
          >
            {value.label ?? value.regionText}
          </span>
          <span
            style={{
              display: "block",
              fontSize: "0.6875rem",
              color: canonical ? "var(--status-ready)" : "var(--status-approaching)",
              marginTop: 2,
            }}
          >
            {canonical ? "Matched to the wine atlas" : "Free text — not on the atlas"}
          </span>
        </span>
        <button
          type="button"
          onClick={clear}
          aria-label="Change region"
          style={{
            minWidth: TOUCH_TARGET_MIN_PX,
            minHeight: TOUCH_TARGET_MIN_PX,
            color: "var(--text-tertiary)",
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  // ── Searching ───────────────────────────────────────────────────────────
  return (
    <div>
      <label htmlFor="geo-search" className="visually-hidden">
        Search regions and appellations
      </label>
      <input
        id="geo-search"
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Pauillac, Barolo, Napa…"
        autoComplete="off"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="geo-results"
        style={{
          width: "100%",
          minHeight: TOUCH_TARGET_MIN_PX,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          padding: "0.6875rem 0.875rem",
          color: "var(--text-primary)",
          fontSize: "1rem",
          outline: "none",
        }}
      />

      {searching && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", marginTop: 6 }}>
          Searching…
        </p>
      )}

      {searchFailed && (
        <p
          role="alert"
          style={{ fontSize: "0.75rem", color: "var(--status-approaching)", marginTop: 6 }}
        >
          Could not reach the atlas. You can still enter the region as free text.
        </p>
      )}

      {results.length > 0 && (
        <ul
          id="geo-results"
          role="listbox"
          style={{
            listStyle: "none",
            marginTop: 6,
            maxHeight: 260,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => select(r)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  minHeight: TOUCH_TARGET_MIN_PX,
                  padding: "0.625rem 0.875rem",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <span
                  style={{
                    display: "block",
                    fontSize: "0.9375rem",
                    color: "var(--text-primary)",
                  }}
                >
                  {describe(r)}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: "0.6875rem",
                    color: "var(--text-tertiary)",
                    marginTop: 2,
                  }}
                >
                  {LEVEL_LABEL[r.level] ?? r.level} · {r.country_code}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Free text is a deliberate fallback, never the default path. */}
      {term.trim().length >= 2 && !searching && results.length === 0 && (
        <div
          style={{
            marginTop: 8,
            padding: "0.875rem",
            borderRadius: 10,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <p
            style={{
              fontSize: "0.8125rem",
              color: "var(--text-secondary)",
              marginBottom: "0.625rem",
              lineHeight: 1.5,
            }}
          >
            Nothing on the atlas matches “{term.trim()}”.
          </p>
          <button
            type="button"
            onClick={useFreeText}
            style={{
              width: "100%",
              minHeight: TOUCH_TARGET_MIN_PX,
              borderRadius: 10,
              background: "rgba(245,181,68,0.10)",
              border: "1px solid rgba(245,181,68,0.3)",
              color: "var(--status-approaching)",
              fontSize: "0.8125rem",
            }}
          >
            Use “{term.trim()}” as free text
          </button>
        </div>
      )}
    </div>
  );
}
