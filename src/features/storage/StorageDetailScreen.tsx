import { lazy, Suspense, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  capacity,
  validatePosition,
  type LayoutType,
  type LayoutConfig,
} from "@/domain/storage/layout";
import { computeOccupancy, findGeometryConflicts } from "@/domain/storage/occupancy";
import { describePosition } from "./StoragePickers";
import { RackBoundary } from "./rack/RackBoundary";
import { RackFilterBar } from "./rack/RackFilterBar";
import {
  emptyFilters,
  filterCollection,
  deriveFilterOptions,
  type CollectionFilters,
} from "@/domain/collection-filters";
import type { WineSummary, DomainBottle, DomainWine } from "@/domain/types";
import { BottleActionSheet } from "@/features/cellar/BottleActions";
import { Button } from "@/components/Button";
import { Sheet } from "@/components/Sheet";
import { DeliverAllSheet } from "./DeliverAllSheet";
import { Field } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * The rack renderer is its own lazy chunk. `docs/architecture.md` requires
 * that it never enters the initial bundle.
 */
const RackRenderer = lazy(() => import("./rack/RackRenderer"));

/** Contents of one location: a visual rack, or a list. */
export default function StorageDetailScreen() {
  const { locationId } = useParams();
  const navigate = useNavigate();
  const { locations, bottles, wines, run, runBatch } = useCellar();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [view, setView] = useState<"rack" | "list">("rack");
  const [delivering, setDelivering] = useState(false);
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters);
  const [selected, setSelected] = useState<string | null>(null);

  const location = locations.find((l) => l.id === locationId) ?? null;

  const contents = useMemo(() => {
    if (!location) return [];
    const wineName = new Map(wines.map((w) => [w.wine.id, w.wine]));
    return bottles
      .filter((b) => b.isActive && b.storageLocationId === location.id)
      .map((b) => ({ bottle: b, wine: wineName.get(b.wineDefinitionId) ?? null }))
      .sort((a, b) =>
        (a.bottle.positionKey ?? "").localeCompare(b.bottle.positionKey ?? ""),
      );
  }, [location, bottles, wines]);

  /**
   * Filter options and matches come from the SAME domain functions the
   * Cellar screen uses. Forking that logic would let the two views disagree
   * about what a filter means.
   */
  const summaries = useMemo<WineSummary[]>(() => {
    const byWine = new Map<string, WineSummary>();
    for (const { wine } of contents) {
      if (!wine) continue;
      const existing = wines.find((w) => w.wine.id === wine.id);
      if (existing) byWine.set(wine.id, existing);
    }
    return [...byWine.values()];
  }, [contents, wines]);

  const filterOptions = useMemo(() => deriveFilterOptions(summaries), [summaries]);

  const matchedBottleIds = useMemo(() => {
    const matchedWineIds = new Set(
      filterCollection(summaries, filters).map((w) => w.wine.id),
    );
    return new Set(
      contents
        .filter((c) => c.wine && matchedWineIds.has(c.wine.id))
        .map((c) => c.bottle.id),
    );
  }, [summaries, filters, contents]);

  const filtering =
    filters.colours.length > 0 ||
    filters.countries.length > 0 ||
    filters.grapes.length > 0 ||
    filters.readiness.length > 0;

  const selectedBottle = contents.find((c) => c.bottle.id === selected) ?? null;

  const openBottle = (id: string) => navigate(`/cellar/bottle/${id}`);

  if (!location) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <EmptyState
          title="Location not found"
          action={<Button onClick={() => navigate("/storage")}>Back to storage</Button>}
        />
      </div>
    );
  }

  const occupancy = computeOccupancy(
    location.occupied,
    location.layoutType as LayoutType | null,
    (location.layoutConfig ?? null) as LayoutConfig | null,
  );

  return (
    <div style={{ padding: "1rem 1rem 2rem" }}>
      <button
        onClick={() => navigate("/storage")}
        style={{
          minHeight: 44,
          color: "var(--text-tertiary)",
          fontSize: "0.8125rem",
          marginBottom: "0.5rem",
        }}
      >
        ← Storage
      </button>

      <header style={{ marginBottom: "1.25rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
            fontStyle: "italic",
          }}
        >
          {location.name}
        </h1>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-tertiary)", marginTop: 4 }}>
          {location.isExternal ? "External storage" : location.kind}
          {location.layoutType ? ` · ${location.layoutType}` : " · no layout"}
          {" · "}
          {occupancy.label}
        </p>

        {occupancy.percentFull !== null && (
          <div
            aria-hidden
            style={{
              height: 4,
              borderRadius: 2,
              marginTop: 10,
              background: "var(--border-subtle)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${occupancy.percentFull}%`,
                background: occupancy.isFull
                  ? "var(--status-approaching)"
                  : "var(--accent-gold)",
              }}
            />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: "1rem" }}>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => setRemoving(true)}>
            Remove
          </Button>
          {/* Bulk delivery only makes sense from external storage. */}
          {location.isExternal && contents.length > 0 && (
            <Button variant="secondary" onClick={() => setDelivering(true)}>
              Deliver all
            </Button>
          )}
        </div>
      </header>

      {location.isPositioned && (
        <div style={{ display: "flex", gap: 6, marginBottom: "1rem" }}>
          {(["rack", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              style={{
                minHeight: TOUCH_TARGET_MIN_PX,
                padding: "0 1rem",
                borderRadius: 999,
                fontSize: "0.8125rem",
                textTransform: "capitalize",
                background: view === v ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${
                  view === v ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"
                }`,
                color: view === v ? "var(--accent-gold)" : "var(--text-secondary)",
              }}
            >
              {v === "rack" ? "Rack" : "List"}
            </button>
          ))}
        </div>
      )}

      {location.isPositioned && view === "rack" && contents.length > 0 && (
        <>
          <RackFilterBar
            filters={filters}
            options={filterOptions}
            matchCount={matchedBottleIds.size}
            totalCount={contents.length}
            onChange={setFilters}
            onClear={() => setFilters(emptyFilters())}
          />

          {/* The list is the fallback: a rendering failure degrades rather
              than blanking the screen, which is what V2 did. */}
          <RackBoundary fallback={<ContentsList contents={contents} onOpen={openBottle} />}>
            <Suspense
              fallback={
                <p style={{ color: "var(--text-tertiary)", fontSize: "0.8125rem" }}>
                  Loading rack…
                </p>
              }
            >
              <RackRenderer
                layoutType={location.layoutType as LayoutType}
                layoutConfig={(location.layoutConfig ?? {}) as LayoutConfig}
                bottles={contents}
                matchedBottleIds={matchedBottleIds}
                filtering={filtering}
                selectedKey={selectedBottle?.bottle.positionKey ?? null}
                onSelect={(b) => setSelected(b.id)}
              />
            </Suspense>
          </RackBoundary>
        </>
      )}

      {(!location.isPositioned || view === "list" || contents.length === 0) &&
        (contents.length === 0 ? (
          <EmptyState
            title="Nothing stored here yet"
            description="Add wines and choose this location when placing them."
          />
        ) : (
          <ContentsList contents={contents} onOpen={openBottle} />
        ))}

      <Sheet open={delivering} onClose={() => setDelivering(false)} title="Deliver home">
        <DeliverAllSheet
          bottles={contents.map((c) => c.bottle)}
          wines={new Map(wines.map((w) => [w.wine.id, w.wine]))}
          destinations={locations.filter((l) => !l.isExternal && l.id !== location.id)}
          allBottles={bottles}
          onCancel={() => setDelivering(false)}
          onDeliver={async (selected, destinationId, positions) => {
            // Positions flow through to move_bottle. A positioned destination
            // refuses a null position — which is what made the first version
            // fail six times over.
            return runBatch(`Deliver ${selected.length} bottles`, (m) =>
              m.deliverBottles(
                selected.map((b) => ({ id: b.id, version: b.version })),
                destinationId,
                positions,
              ),
            );
          }}
        />
      </Sheet>

      <Sheet open={editing} onClose={() => setEditing(false)} title="Edit location">
        <EditLocationForm
          location={location}
          bottles={bottles.filter((b) => b.isActive && b.storageLocationId === location.id)}
          onCancel={() => setEditing(false)}
          onSaveName={async (name) => {
            const r = await run(`Rename ${location.name}`, (m) =>
              m.updateLocation({
                locationId: location.id,
                version: location.version,
                patch: { name },
              }),
            );
            if (r.ok) setEditing(false);
          }}
          onSaveGeometry={async (config) => {
            if (!location.layoutId) return;
            const r = await run(`Update ${location.name} layout`, (m) =>
              m.updateLayout({
                layoutId: location.layoutId!,
                version: location.version,
                patch: { config },
              }),
            );
            if (r.ok) setEditing(false);
          }}
        />
      </Sheet>

      {selectedBottle && (
        <BottleActionSheet
          bottle={selectedBottle.bottle}
          wineName={selectedBottle.wine?.name ?? "Bottle"}
          onClose={() => setSelected(null)}
        />
      )}

      <Sheet open={removing} onClose={() => setRemoving(false)} title="Remove location">
        <RemoveLocationForm
          occupied={occupancy.occupied}
          name={location.name}
          onCancel={() => setRemoving(false)}
          onRemove={async (reason) => {
            const r = await run(`Remove ${location.name}`, (m) =>
              m.deleteLocation({
                locationId: location.id,
                version: location.version,
                reason,
              }),
            );
            if (r.ok) {
              setRemoving(false);
              navigate("/storage");
            }
          }}
        />
      </Sheet>
    </div>
  );
}

/**
 * Edit a location.
 *
 * A geometry change is checked locally first, using the same domain
 * validation the database mirrors, so the user is warned before submitting.
 * The database remains authoritative — this is a courtesy, not a substitute.
 */
function EditLocationForm({
  location,
  bottles,
  onCancel,
  onSaveName,
  onSaveGeometry,
}: {
  location: ReturnType<typeof useCellar>["locations"][number];
  bottles: ReturnType<typeof useCellar>["bottles"];
  onCancel: () => void;
  onSaveName: (name: string) => Promise<void>;
  onSaveGeometry: (config: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(location.name);
  const [busy, setBusy] = useState(false);

  const cfg = (location.layoutConfig ?? {}) as Record<string, unknown>;

  /**
   * Geometry editing for every positioned type, not just grid.
   *
   * Phase 4 deferred this here explicitly ("a fuller editor is Phase 5").
   * Each type exposes the fields its own config actually has — the form
   * reads them from the stored config rather than assuming a shape, and the
   * proposed config is validated by the same domain function the database
   * mirrors.
   */
  const [fields, setFields] = useState<Record<string, string>>(() =>
    editableFields(location.layoutType, cfg),
  );

  const proposed = useMemo(
    () => buildConfig(location.layoutType, cfg, fields),
    [location.layoutType, cfg, fields],
  );

  const derivedCapacity = useMemo(() => {
    if (!proposed || !location.layoutType) return null;
    return capacity(location.layoutType as LayoutType, proposed as LayoutConfig);
  }, [proposed, location.layoutType]);

  const conflicts = useMemo(() => {
    if (!proposed || !location.layoutType) return [];
    return findGeometryConflicts(
      bottles,
      location.layoutType as LayoutType,
      proposed as LayoutConfig,
      validatePosition,
    );
  }, [proposed, bottles, location.layoutType]);

  const geometryChanged =
    proposed !== null && JSON.stringify(proposed) !== JSON.stringify(cfg);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />

      <Button
        fullWidth
        disabled={busy || !name.trim() || name === location.name}
        onClick={async () => {
          setBusy(true);
          await onSaveName(name.trim());
          setBusy(false);
        }}
      >
        {busy ? "Saving…" : "Save name"}
      </Button>

      {location.isPositioned && Object.keys(fields).length > 0 && (
        <>
          <div style={{ height: 1, background: "var(--border-subtle)" }} />

          <p
            style={{
              fontSize: "0.6875rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
            }}
          >
            Geometry
          </p>

          {Object.entries(fields).map(([key, value]) => (
            <Field
              key={key}
              label={FIELD_LABELS[key] ?? key}
              type="number"
              inputMode="numeric"
              value={value}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          ))}

          {derivedCapacity !== null && (
            <p style={{ fontSize: "0.8125rem", color: "var(--accent-gold)" }}>
              New capacity: {derivedCapacity} bottles
            </p>
          )}

          {conflicts.length > 0 && (
            <p
              role="alert"
              style={{
                padding: "0.75rem 1rem",
                borderRadius: 10,
                background: "rgba(245,181,68,0.08)",
                border: "1px solid rgba(245,181,68,0.3)",
                color: "var(--status-approaching)",
                fontSize: "0.8125rem",
                lineHeight: 1.6,
              }}
            >
              This would leave {conflicts.length} bottle
              {conflicts.length === 1 ? "" : "s"} in positions that would no longer exist (
              {conflicts.map((c) => c.positionKey).join(", ")}). Move them first.
            </p>
          )}

          <Button
            fullWidth
            disabled={busy || conflicts.length > 0 || !geometryChanged}
            onClick={async () => {
              setBusy(true);
              if (proposed) await onSaveGeometry(proposed);
              setBusy(false);
            }}
          >
            {busy ? "Saving…" : "Save geometry"}
          </Button>
        </>
      )}

      <Button variant="ghost" fullWidth onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  columns: "Columns",
  rows: "Rows",
  firstHeight: "First column holds",
  step: "Increase per column",
  shelfCount: "Shelves",
  perShelf: "Bottles per shelf",
  zoneShelves: "Shelves per zone",
};

/**
 * Which numeric fields does this layout type expose?
 *
 * Read from the stored config, so a type with no editable geometry simply
 * returns nothing and the geometry section does not render.
 */
function editableFields(
  type: string | null,
  cfg: Record<string, unknown>,
): Record<string, string> {
  switch (type) {
    case "staircase": {
      const heights = (cfg.heights as number[]) ?? [];
      const first = heights[0] ?? 1;
      const step = heights.length > 1 ? (heights[1] ?? first) - first : 1;
      return {
        columns: String(heights.length || cfg.columns || 1),
        firstHeight: String(first),
        step: String(step),
      };
    }
    case "grid":
      return { rows: String(cfg.rows ?? 1), columns: String(cfg.columns ?? 1) };
    case "shelving": {
      const shelves = (cfg.shelves as number[]) ?? [];
      return {
        shelfCount: String(shelves.length || 1),
        perShelf: String(shelves[0] ?? 1),
      };
    }
    case "fridge": {
      const zones = (cfg.zones as { shelves: number; perShelf: number }[]) ?? [];
      return {
        zoneShelves: String(zones[0]?.shelves ?? 1),
        perShelf: String(zones[0]?.perShelf ?? 1),
      };
    }
    default:
      return {};
  }
}

/** Rebuild a config from the edited fields, preserving anything not exposed. */
function buildConfig(
  type: string | null,
  cfg: Record<string, unknown>,
  fields: Record<string, string>,
): Record<string, unknown> | null {
  const num = (k: string, min = 1) => {
    const n = Number(fields[k]);
    return Number.isInteger(n) && n >= min ? n : null;
  };

  switch (type) {
    case "staircase": {
      const columns = num("columns");
      const first = num("firstHeight");
      const step = Number(fields.step);
      if (columns === null || first === null || !Number.isInteger(step)) return null;
      return {
        ...cfg,
        columns,
        heights: Array.from({ length: columns }, (_, i) => Math.max(1, first + i * step)),
      };
    }
    case "grid": {
      const rows = num("rows");
      const columns = num("columns");
      return rows === null || columns === null ? null : { ...cfg, rows, columns };
    }
    case "shelving": {
      const count = num("shelfCount");
      const per = num("perShelf");
      return count === null || per === null
        ? null
        : { ...cfg, shelves: Array.from({ length: count }, () => per) };
    }
    case "fridge": {
      const shelves = num("zoneShelves");
      const per = num("perShelf");
      if (shelves === null || per === null) return null;
      const zones = (cfg.zones as { name: string }[]) ?? [{ name: "Main" }];
      return {
        ...cfg,
        zones: zones.map((z) => ({ ...z, shelves, perShelf: per })),
      };
    }
    default:
      return null;
  }
}

function RemoveLocationForm({
  occupied,
  name,
  onCancel,
  onRemove,
}: {
  occupied: number;
  name: string;
  onCancel: () => void;
  onRemove: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (occupied > 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <p
          role="alert"
          style={{
            padding: "0.875rem 1rem",
            borderRadius: 10,
            background: "rgba(245,181,68,0.08)",
            border: "1px solid rgba(245,181,68,0.3)",
            color: "var(--status-approaching)",
            fontSize: "0.875rem",
            lineHeight: 1.6,
          }}
        >
          {name} still holds {occupied} bottle{occupied === 1 ? "" : "s"}. Move or consume
          them before removing it.
        </p>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", lineHeight: 1.6 }}>
        The location is kept permanently with your reason attached, so past bottles keep
        their history. It simply stops appearing in lists.
      </p>
      <Field
        label="Why are you removing it?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="No longer used"
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          fullWidth
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            await onRemove(reason.trim());
            setBusy(false);
          }}
        >
          {busy ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}

/** The list view, also used as the rack's failure fallback. */
function ContentsList({
  contents,
  onOpen,
}: {
  contents: { bottle: DomainBottle; wine: DomainWine | null }[];
  onOpen: (id: string) => void;
}) {
  return (
    <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
      {contents.map(({ bottle, wine }) => (
        <li key={bottle.id}>
          <button
            onClick={() => onOpen(bottle.id)}
            style={{
              width: "100%",
              textAlign: "left",
              minHeight: TOUCH_TARGET_MIN_PX,
              padding: "0.625rem 0.875rem",
              borderRadius: 10,
              background: "var(--surface-raised)",
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
              {wine
                ? `${wine.name}${wine.vintage ? ` ${wine.vintage}` : ""}`
                : "Unknown wine"}
            </span>
            <span
              style={{
                display: "block",
                fontSize: "0.75rem",
                color: "var(--text-tertiary)",
                marginTop: 2,
              }}
            >
              {bottle.position ? describePosition(bottle.position) : "Unpositioned"}
              {" · "}
              {bottle.bottleSize}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
