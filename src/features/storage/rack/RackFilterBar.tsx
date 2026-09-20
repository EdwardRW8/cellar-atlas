import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";
import type { FilterOptions, CollectionFilters } from "@/domain/collection-filters";

/**
 * Filtering over the rack.
 *
 * Reuses `collection-filters.ts` verbatim — the same options derivation and
 * the same predicate the Cellar screen uses. Forking that logic would let the
 * two views disagree about what "Bordeaux" means.
 *
 * Options are derived from what the user actually owns, so a cellar with no
 * white wine offers no White filter.
 */
export function RackFilterBar({
  filters,
  options,
  matchCount,
  totalCount,
  onChange,
  onClear,
}: {
  filters: CollectionFilters;
  options: FilterOptions;
  matchCount: number;
  totalCount: number;
  onChange: (f: CollectionFilters) => void;
  onClear: () => void;
}) {
  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  const active =
    filters.colours.length +
    filters.countries.length +
    filters.grapes.length +
    filters.readiness.length;

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: "0.5rem",
        }}
      >
        <span
          aria-live="polite"
          style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}
        >
          {active > 0
            ? `${matchCount} of ${totalCount} bottles match`
            : `${totalCount} bottle${totalCount === 1 ? "" : "s"}`}
        </span>
        {active > 0 && (
          <button
            type="button"
            onClick={onClear}
            style={{
              minHeight: TOUCH_TARGET_MIN_PX,
              padding: "0 0.75rem",
              fontSize: "0.75rem",
              color: "var(--accent-gold)",
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          overflowX: "auto",
          paddingBottom: 4,
          // Horizontal scroll is confined to this strip, never the page.
          WebkitOverflowScrolling: "touch",
        }}
      >
        {options.colours.map((c) => (
          <Chip
            key={`colour-${c}`}
            selected={filters.colours.includes(c)}
            onClick={() => onChange({ ...filters, colours: toggle(filters.colours, c) })}
          >
            {c}
          </Chip>
        ))}
        {options.countries.map((c) => (
          <Chip
            key={`country-${c.code}`}
            selected={filters.countries.includes(c.code)}
            onClick={() =>
              onChange({ ...filters, countries: toggle(filters.countries, c.code) })
            }
          >
            {c.name}
          </Chip>
        ))}
        {options.grapes.slice(0, 12).map((g) => (
          <Chip
            key={`grape-${g}`}
            selected={filters.grapes.includes(g)}
            onClick={() => onChange({ ...filters, grapes: toggle(filters.grapes, g) })}
          >
            {g}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{
        flexShrink: 0,
        minHeight: TOUCH_TARGET_MIN_PX - 8,
        padding: "0.5rem 0.875rem",
        borderRadius: 999,
        fontSize: "0.8125rem",
        whiteSpace: "nowrap",
        background: selected ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${selected ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
        color: selected ? "var(--accent-gold)" : "var(--text-secondary)",
      }}
    >
      {children}
    </button>
  );
}
