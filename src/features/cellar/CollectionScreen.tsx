import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  emptyFilters,
  filterCollection,
  sortCollection,
  summarise,
  deriveFilterOptions,
  countActiveFilters,
  type CollectionFilters,
  type SortKey,
  type SortDirection,
} from "@/domain/collection-filters";
import { cellarValuation, holdingValue, type BottleValuation } from "@/domain/valuation";
import { assessWindow } from "@/domain/drinking-window";
import type { WineSummary, DomainBottle } from "@/domain/types";
import { Sheet } from "@/components/Sheet";
import { SearchField } from "@/components/SearchField";
import { StatusDot } from "@/components/StatusDot";
import { ValuationTotal } from "@/components/ValuationTotal";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

export default function CollectionScreen() {
  const { state, error, wines, bottles, valuations, refresh } = useCellar();
  const navigate = useNavigate();

  /**
   * Home may hand over a starting filter, e.g. "show me what is ready".
   *
   * This uses react-router's own location state — no query-string parsing, no
   * new routing infrastructure. Filtering itself is unchanged; only the
   * INITIAL value differs, and only when arriving from a link that set it.
   */
  const routeState = useLocation().state as { filters?: Partial<CollectionFilters> } | null;

  const [filters, setFilters] = useState<CollectionFilters>(() =>
    routeState?.filters ? { ...emptyFilters(), ...routeState.filters } : emptyFilters(),
  );
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [filterOpen, setFilterOpen] = useState(false);

  const options = useMemo(() => deriveFilterOptions(wines), [wines]);
  const visible = useMemo(
    () => sortCollection(filterCollection(wines, filters), sortKey, sortDir),
    [wines, filters, sortKey, sortDir],
  );
  // Currency-aware cellar valuation, shared with Wine Detail's logic.
  const cellarValue = useMemo(
    () => cellarValuation(bottles, valuations),
    [bottles, valuations],
  );

  const totals = useMemo(() => summarise(visible), [visible]);
  const activeCount = countActiveFilters(filters);

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Skeleton />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <div
          role="alert"
          style={{
            padding: "1.25rem",
            borderRadius: 14,
            background: "var(--surface-raised)",
            border: "1px solid rgba(255,138,122,0.3)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              fontStyle: "italic",
              color: "var(--status-past)",
              marginBottom: "0.5rem",
            }}
          >
            Could not load your cellar
          </h2>
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

  const emptyCellar = wines.length === 0;

  return (
    <div style={{ padding: "1rem 1rem 1.5rem" }}>
      <header style={{ marginBottom: "1rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.875rem",
            fontStyle: "italic",
          }}
        >
          Cellar
        </h1>
        <p
          style={{
            fontSize: "0.75rem",
            color: "var(--text-tertiary)",
            marginTop: "0.125rem",
          }}
        >
          {totals.wines} wine{totals.wines === 1 ? "" : "s"} · {totals.bottles} bottle
          {totals.bottles === 1 ? "" : "s"}
          {/* Currency-aware and completeness-aware. A bare number here
              would imply the whole cellar was valued, and would sum
              currencies that cannot be summed. */}
          {cellarValue.present > 0 && (
            <>
              {" · "}
              <ValuationTotal totals={cellarValue} inline />
            </>
          )}
        </p>
      </header>

      {!emptyCellar && (
        <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
          <SearchField
            value={filters.search}
            onChange={(search) => setFilters((f) => ({ ...f, search }))}
            placeholder="Search wines, producers, regions"
          />
          <button
            onClick={() => setFilterOpen(true)}
            aria-label={`Filters${activeCount ? `, ${activeCount} active` : ""}`}
            style={{
              minWidth: TOUCH_TARGET_MIN_PX,
              minHeight: TOUCH_TARGET_MIN_PX,
              borderRadius: 10,
              position: "relative",
              background: activeCount ? "rgba(217,174,85,0.12)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${activeCount ? "rgba(217,174,85,0.35)" : "var(--border-subtle)"}`,
              color: activeCount ? "var(--accent-gold)" : "var(--text-secondary)",
            }}
          >
            ⚙
            {activeCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  minWidth: 16,
                  height: 16,
                  borderRadius: 8,
                  background: "var(--accent-gold)",
                  color: "var(--surface-base)",
                  fontSize: "0.625rem",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {activeCount}
              </span>
            )}
          </button>
        </div>
      )}

      {emptyCellar ? (
        <EmptyState
          title="Your cellar is empty"
          description="Add your first wine to begin. You can record bottles without a storage location and place them later."
          action={<Button onClick={() => navigate("/add")}>Add your first wine</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No wines match"
          description="Try a different search, or clear your filters."
          action={
            <Button variant="secondary" onClick={() => setFilters(emptyFilters())}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {visible.map((w) => (
            <li key={w.wine.id}>
              <WineRow
                summary={w}
                bottles={bottles}
                valuations={valuations}
                onOpen={() => navigate(`/cellar/wine/${w.wine.id}`)}
              />
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="Filter and sort"
        footer={
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="ghost" fullWidth onClick={() => setFilters(emptyFilters())}>
              Clear all
            </Button>
            <Button fullWidth onClick={() => setFilterOpen(false)}>
              Show {filterCollection(wines, filters).length} wines
            </Button>
          </div>
        }
      >
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          options={options}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={(k, d) => {
            setSortKey(k);
            setSortDir(d);
          }}
        />
      </Sheet>
    </div>
  );
}

function WineRow({
  summary,
  bottles,
  valuations,
  onOpen,
}: {
  summary: WineSummary;
  bottles: DomainBottle[];
  valuations: Map<string, BottleValuation>;
  onOpen: () => void;
}) {
  const { wine, activeBottles, locations } = summary;

  const wineValue = useMemo(
    () =>
      holdingValue(
        bottles
          .filter((b) => b.isActive && b.wineDefinitionId === wine.id)
          .map((b) => b.id),
        valuations,
      ),
    [bottles, valuations, wine.id],
  );

  const { indicator, label } = assessWindow({
    from: wine.drinkFrom,
    until: wine.drinkUntil,
  });

  const place =
    locations.length === 0
      ? "No location"
      : locations.length === 1
        ? locations[0]!.name
        : `${locations.length} locations`;

  return (
    <button
      onClick={onOpen}
      style={{
        width: "100%",
        textAlign: "left",
        minHeight: TOUCH_TARGET_MIN_PX + 28,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0.875rem 1rem",
        borderRadius: 12,
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <StatusDot indicator={indicator} />

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontFamily: "var(--font-display)",
            fontSize: "1.0625rem",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {wine.name}
          {wine.vintage ? ` ${wine.vintage}` : ""}
        </span>
        <span
          style={{
            display: "block",
            fontSize: "0.75rem",
            color: "var(--text-tertiary)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {wine.producer} · {place} · {label}
        </span>
      </span>

      <span style={{ textAlign: "right", flexShrink: 0 }}>
        <span
          style={{
            display: "block",
            fontFamily: "var(--font-display)",
            fontSize: "1.125rem",
            color: "var(--text-primary)",
          }}
        >
          {activeBottles}
        </span>
        {/* Currency-aware at row level too. A bare figure here would sum
            currencies and hide how much of the wine is actually valued. */}
        {wineValue.present > 0 && (
          <span style={{ display: "block", fontSize: "0.6875rem" }}>
            <ValuationTotal totals={wineValue} inline />
          </span>
        )}
      </span>
    </button>
  );
}

function FilterPanel({
  filters,
  onChange,
  options,
  sortKey,
  sortDir,
  onSort,
}: {
  filters: CollectionFilters;
  onChange: (f: CollectionFilters) => void;
  options: ReturnType<typeof deriveFilterOptions>;
  sortKey: SortKey;
  sortDir: SortDirection;
  onSort: (k: SortKey, d: SortDirection) => void;
}) {
  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <Group label="Sort by">
        {(
          [
            ["name", "Name"],
            ["producer", "Producer"],
            ["vintage", "Vintage"],
            ["value", "Value"],
            ["bottles", "Bottles"],
            ["readiness", "Readiness"],
          ] as [SortKey, string][]
        ).map(([k, l]) => (
          <Chip
            key={k}
            selected={sortKey === k}
            onClick={() => onSort(k, sortKey === k && sortDir === "asc" ? "desc" : "asc")}
          >
            {l}
            {sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
          </Chip>
        ))}
      </Group>

      <Group label="Readiness">
        {(
          [
            ["ready", "Ready"],
            ["young", "Not ready"],
            ["past", "Past window"],
            ["unknown", "Unknown"],
          ] as const
        ).map(([k, l]) => (
          <Chip
            key={k}
            selected={filters.readiness.includes(k)}
            onClick={() =>
              onChange({ ...filters, readiness: toggle(filters.readiness, k) })
            }
          >
            {l}
          </Chip>
        ))}
      </Group>

      {options.colours.length > 0 && (
        <Group label="Type">
          {options.colours.map((c) => (
            <Chip
              key={c}
              selected={filters.colours.includes(c)}
              onClick={() => onChange({ ...filters, colours: toggle(filters.colours, c) })}
            >
              {c}
            </Chip>
          ))}
        </Group>
      )}

      {options.countries.length > 0 && (
        <Group label="Country">
          {options.countries.map((c) => (
            <Chip
              key={c.code}
              selected={filters.countries.includes(c.code)}
              onClick={() =>
                onChange({ ...filters, countries: toggle(filters.countries, c.code) })
              }
            >
              {c.name}
            </Chip>
          ))}
        </Group>
      )}

      {options.grapes.length > 0 && (
        <Group label="Grape">
          {options.grapes.map((g) => (
            <Chip
              key={g}
              selected={filters.grapes.includes(g)}
              onClick={() => onChange({ ...filters, grapes: toggle(filters.grapes, g) })}
            >
              {g}
            </Chip>
          ))}
        </Group>
      )}

      {options.locations.length > 0 && (
        <Group label="Location">
          {options.locations.map((l) => (
            <Chip
              key={l.id}
              selected={filters.locationIds.includes(l.id)}
              onClick={() =>
                onChange({ ...filters, locationIds: toggle(filters.locationIds, l.id) })
              }
            >
              {l.name}
            </Chip>
          ))}
        </Group>
      )}

      <Group label="Other">
        <Chip
          selected={filters.includeEmpty}
          onClick={() => onChange({ ...filters, includeEmpty: !filters.includeEmpty })}
        >
          Include fully consumed
        </Chip>
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "none" }}>
      <legend
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginBottom: "0.5rem",
        }}
      >
        {label}
      </legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{children}</div>
    </fieldset>
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
        minHeight: TOUCH_TARGET_MIN_PX - 8,
        padding: "0.5rem 0.875rem",
        borderRadius: 999,
        fontSize: "0.8125rem",
        background: selected ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${selected ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
        color: selected ? "var(--accent-gold)" : "var(--text-secondary)",
      }}
    >
      {children}
    </button>
  );
}
