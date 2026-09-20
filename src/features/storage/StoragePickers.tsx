/**
 * Storage pickers.
 *
 * THE ARCHITECTURE RULE LIVES HERE.
 *
 * Neither component knows that a staircase exists. Both read `layoutType` and
 * `layoutConfig` from the location and delegate to `src/domain/storage/`.
 * Adding a seventh layout type would require no change to either.
 *
 * A test asserts no file under src/features/ mentions "staircase" or 130.
 */

import { useMemo, useState } from "react";
import {
  capacity,
  enumeratePositions,
  validatePosition,
  positionToRecord,
  type LayoutType,
  type LayoutConfig,
  type Position,
} from "@/domain/storage/layout";
import { computeOccupancy } from "@/domain/storage/occupancy";
import type { DomainStorageLocation } from "@/domain/types";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

// ═══════════════════════════════════════════════════════════════════════════
// LOCATION PICKER
// ═══════════════════════════════════════════════════════════════════════════

export function StorageLocationPicker({
  locations,
  value,
  onChange,
  allowNone = true,
}: {
  locations: DomainStorageLocation[];
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
}) {
  if (locations.length === 0) {
    return (
      <div
        style={{
          padding: "1rem",
          background: "rgba(245,181,68,0.08)",
          border: "1px solid rgba(245,181,68,0.25)",
          borderRadius: 10,
        }}
      >
        <p
          style={{ color: "var(--text-secondary)", fontSize: "0.875rem", lineHeight: 1.6 }}
        >
          You have no storage locations yet. Bottles can still be added without one — create
          locations later under Storage.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} role="radiogroup">
      {allowNone && (
        <LocationOption
          selected={value === null}
          onSelect={() => onChange(null)}
          title="No location yet"
          detail="Record the bottles now, place them later"
        />
      )}
      {locations.map((l) => (
        <LocationOption
          key={l.id}
          selected={value === l.id}
          onSelect={() => onChange(l.id)}
          title={l.name}
          detail={describeLocation(l)}
        />
      ))}
    </div>
  );
}

/**
 * Description derived entirely from configuration.
 *
 * Occupancy arithmetic lives in the domain, so this cannot drift from what
 * the storage screens show.
 */
function describeLocation(l: DomainStorageLocation): string {
  if (!l.isPositioned) {
    return l.isExternal ? "External storage · no fixed positions" : "No fixed positions";
  }
  const o = computeOccupancy(
    l.occupied,
    l.layoutType as LayoutType | null,
    l.layoutConfig as LayoutConfig | null,
  );
  return o.capacity === null ? "Positioned storage" : o.label;
}

function LocationOption({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        minHeight: TOUCH_TARGET_MIN_PX + 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 2,
        padding: "0.75rem 1rem",
        borderRadius: 10,
        textAlign: "left",
        background: selected ? "rgba(217,174,85,0.10)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${selected ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
        color: selected ? "var(--accent-gold)" : "var(--text-secondary)",
      }}
    >
      <span style={{ fontSize: "0.9375rem" }}>{title}</span>
      <span style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>{detail}</span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION PICKER
// ═══════════════════════════════════════════════════════════════════════════

export function PositionPicker({
  location,
  occupiedKeys,
  positions,
  onChange,
}: {
  location: DomainStorageLocation | null;
  occupiedKeys: Set<string>;
  positions: (Record<string, number> | null)[];
  onChange: (index: number, position: Record<string, number> | null) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  // Unpositioned storage renders NOTHING. No code may assume slots exist.
  if (!location || !location.isPositioned || !location.layoutType) {
    return (
      <p style={{ color: "var(--text-tertiary)", fontSize: "0.8125rem", lineHeight: 1.6 }}>
        {location
          ? `${location.name} does not use fixed positions, so no slot is needed.`
          : "Choose a location first."}
      </p>
    );
  }

  const type = location.layoutType as LayoutType;
  const config = (location.layoutConfig ?? {}) as LayoutConfig;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <FreeSlotSummary type={type} config={config} occupied={occupiedKeys} />

      {positions.map((pos, i) => (
        <SlotRow
          key={i}
          index={i}
          type={type}
          config={config}
          position={pos}
          occupiedKeys={occupiedKeys}
          otherPositions={positions.filter((_, j) => j !== i)}
          expanded={expanded === i}
          onToggle={() => setExpanded(expanded === i ? null : i)}
          onChange={(p) => {
            onChange(i, p);
            setExpanded(null);
          }}
        />
      ))}

      {positions.length > 1 && (
        <button
          type="button"
          onClick={() => autoAssign(type, config, occupiedKeys, positions, onChange)}
          style={{
            minHeight: TOUCH_TARGET_MIN_PX,
            background: "rgba(217,174,85,0.10)",
            border: "1px solid rgba(217,174,85,0.28)",
            borderRadius: 10,
            color: "var(--accent-gold)",
            fontSize: "0.8125rem",
          }}
        >
          Fill the next {positions.length} free slots
        </button>
      )}
    </div>
  );
}

function FreeSlotSummary({
  type,
  config,
  occupied,
}: {
  type: LayoutType;
  config: LayoutConfig;
  occupied: Set<string>;
}) {
  const total = capacity(type, config);
  if (total === null) return null;
  const free = total - occupied.size;
  return (
    <p style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
      {free} of {total} slots free
    </p>
  );
}

function SlotRow({
  index,
  type,
  config,
  position,
  occupiedKeys,
  otherPositions,
  expanded,
  onToggle,
  onChange,
}: {
  index: number;
  type: LayoutType;
  config: LayoutConfig;
  position: Record<string, number> | null;
  occupiedKeys: Set<string>;
  otherPositions: (Record<string, number> | null)[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (p: Record<string, number> | null) => void;
}) {
  const free = useMemo(() => {
    const takenByOthers = new Set(
      otherPositions
        .filter(Boolean)
        .map((p) => keyOf(type, config, p!))
        .filter(Boolean) as string[],
    );
    return enumeratePositions(type, config).filter((p) => {
      const k = keyOf(type, config, p);
      return k !== null && !occupiedKeys.has(k) && !takenByOthers.has(k);
    });
  }, [type, config, occupiedKeys, otherPositions]);

  const label = position ? describePosition(position) : "Choose a slot";

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: "100%",
          minHeight: TOUCH_TARGET_MIN_PX,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "0.625rem 0.875rem",
          borderRadius: 10,
          background: "rgba(255,255,255,0.04)",
          border: `1px solid ${position ? "rgba(217,174,85,0.3)" : "var(--border-strong)"}`,
          color: position ? "var(--accent-gold)" : "var(--text-tertiary)",
          fontSize: "0.875rem",
        }}
      >
        <span style={{ color: "var(--text-tertiary)", fontSize: "0.75rem" }}>
          Bottle {index + 1}
        </span>
        <span>{label}</span>
      </button>

      {expanded && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
            gap: 6,
            padding: "0.625rem 0",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {free.length === 0 && (
            <p style={{ color: "var(--text-tertiary)", fontSize: "0.8125rem" }}>
              No free slots remain in this location.
            </p>
          )}
          {free.slice(0, 200).map((p) => {
            const k = keyOf(type, config, p);
            return (
              <button
                key={k}
                type="button"
                onClick={() => onChange(positionToRecord(p))}
                style={{
                  minHeight: TOUCH_TARGET_MIN_PX,
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-secondary)",
                  fontSize: "0.75rem",
                }}
              >
                {describePosition(positionToRecord(p))}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function keyOf(
  type: LayoutType,
  config: LayoutConfig,
  position: Position | Record<string, number>,
): string | null {
  const r = validatePosition(type, config, position);
  return r.valid ? r.key : null;
}

/**
 * Human label for a position, derived from its own keys.
 * Works for any layout shape without knowing which one it is.
 */
function describePosition(p: Record<string, number>): string {
  const labels: Record<string, string> = {
    col: "Col",
    row: "Row",
    x: "X",
    y: "Y",
    shelf: "Shelf",
    index: "Pos",
    zone: "Zone",
  };
  return Object.entries(p)
    .map(([k, v]) => `${labels[k] ?? k} ${v}`)
    .join(" · ");
}

function autoAssign(
  type: LayoutType,
  config: LayoutConfig,
  occupied: Set<string>,
  positions: (Record<string, number> | null)[],
  onChange: (index: number, p: Record<string, number> | null) => void,
) {
  const taken = new Set(occupied);
  const free = enumeratePositions(type, config).filter((p) => {
    const k = keyOf(type, config, p);
    return k !== null && !taken.has(k);
  });

  positions.forEach((_, i) => {
    const next = free[i];
    if (next) onChange(i, positionToRecord(next));
  });
}

export { describePosition };
