import { useCallback, useMemo, useRef, useState } from "react";
import { rackLayout, type Slot } from "@/domain/storage/slot-geometry";
import type { LayoutType, LayoutConfig } from "@/domain/storage/layout";
import { assessWindow, type WindowIndicator } from "@/domain/drinking-window";
import type { DomainBottle, DomainWine, WineColour } from "@/domain/types";

/**
 * Interactive rack.
 *
 * ── LAYOUT AGNOSTIC ──────────────────────────────────────────────────────
 * This component contains NO layout geometry. It asks `rackLayout()` for a
 * list of rectangles and draws them. A seventh layout type would need no
 * change here. It never reads `columns`, `heights`, `rows` or `shelves`.
 *
 * ── DRAG ROTATION ────────────────────────────────────────────────────────
 * V2 rotated a 3D rack by dragging. That is preserved in spirit without the
 * 3D machinery: dragging rotates the rack about its vertical axis, and slots
 * are foreshortened by the cosine of the angle while their horizontal offset
 * from centre gains a depth-driven vertical shear. The result reads as a rack
 * turning to face you.
 *
 * Pointer Events give mouse, touch and stylus in one code path, so touch is
 * not an afterthought. `touch-action: none` on the surface stops the browser
 * treating a rotate-drag as a page scroll — which is what would otherwise
 * introduce horizontal scrolling on a phone.
 */

const MAX_ROTATION = 55;
const ROTATION_PER_PX = 0.35;

export interface RackBottle {
  bottle: DomainBottle;
  wine: DomainWine | null;
}

const COLOUR_FOR_WINE: Record<WineColour, string> = {
  Red: "#8B2E3C",
  White: "#D8CB8E",
  Rosé: "#D98A96",
  Sparkling: "#C9B87A",
  Dessert: "#B5762E",
  Fortified: "#6B2A2A",
};

const STATUS_COLOUR: Record<WindowIndicator, string> = {
  ready: "#6EE7A0",
  young: "#F5B544",
  past: "#FF8A7A",
  unknown: "#9C8E7A",
};

export function RackRenderer({
  layoutType,
  layoutConfig,
  bottles,
  matchedBottleIds,
  filtering,
  onSelect,
  selectedKey,
}: {
  layoutType: LayoutType;
  layoutConfig: LayoutConfig;
  bottles: RackBottle[];
  /** Ids matching the active filter. Ignored when `filtering` is false. */
  matchedBottleIds: Set<string>;
  filtering: boolean;
  onSelect: (bottle: DomainBottle) => void;
  selectedKey: string | null;
}) {
  const [rotation, setRotation] = useState(0);
  const dragFrom = useRef<{ x: number; rotation: number } | null>(null);
  const moved = useRef(false);

  const layout = useMemo(
    () => rackLayout(layoutType, layoutConfig),
    [layoutType, layoutConfig],
  );

  /** Which bottle, if any, occupies each slot. */
  const occupants = useMemo(() => {
    const map = new Map<string, RackBottle>();
    for (const b of bottles) {
      if (b.bottle.isActive && b.bottle.positionKey) {
        map.set(b.bottle.positionKey, b);
      }
    }
    return map;
  }, [bottles]);

  // ── Drag rotation, one path for mouse and touch ────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!Number.isFinite(e.clientX)) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragFrom.current = { x: e.clientX, rotation };
      moved.current = false;
    },
    [rotation],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const from = dragFrom.current;
    // A non-finite coordinate would make rotation NaN and collapse the rack.
    if (!from || !Number.isFinite(e.clientX)) return;
    const dx = e.clientX - from.x;
    // A few pixels of slop, so a tap is never read as a drag.
    if (Math.abs(dx) > 4) moved.current = true;
    const next = from.rotation + dx * ROTATION_PER_PX;
    setRotation(Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, next)));
  }, []);

  const endDrag = useCallback(() => {
    dragFrom.current = null;
  }, []);

  const handleSlotClick = useCallback(
    (bottle: DomainBottle | null) => {
      // A rotate-drag must not also select a bottle.
      if (moved.current || !bottle) return;
      onSelect(bottle);
    },
    [onSelect],
  );

  if (layout.isEmpty) {
    return (
      <p
        style={{
          color: "var(--text-tertiary)",
          fontSize: "0.875rem",
          padding: "1.5rem 0",
          textAlign: "center",
        }}
      >
        This location has no fixed positions, so there is nothing to lay out.
      </p>
    );
  }

  const { width, height } = layout.bounds;
  const radians = (rotation * Math.PI) / 180;
  const squash = Math.cos(radians);
  const shear = Math.sin(radians);

  // Padding keeps rotated edges inside the viewBox.
  const padX = width * 0.12;
  const padY = 1.2;

  return (
    <div style={{ width: "100%", overflow: "hidden" }}>
      <svg
        viewBox={`${-padX} ${-padY} ${width + padX * 2} ${height + padY * 2}`}
        // 100% width with a viewBox: never wider than its container, so it
        // cannot introduce horizontal page scroll at any viewport.
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          touchAction: "none",
          cursor: dragFrom.current ? "grabbing" : "grab",
        }}
        role="group"
        aria-label="Interactive rack. Drag to rotate."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
      >
        {layout.slots.map((slot) => {
          const occupant = occupants.get(slot.key) ?? null;
          const faded =
            filtering && (!occupant || !matchedBottleIds.has(occupant.bottle.id));

          return (
            <SlotShape
              key={slot.key}
              slot={slot}
              occupant={occupant}
              centreX={width / 2}
              squash={squash}
              shear={shear}
              faded={faded}
              selected={slot.key === selectedKey}
              onClick={() => handleSlotClick(occupant?.bottle ?? null)}
            />
          );
        })}
      </svg>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: "0.75rem",
          // The shell reserves space for the fixed Add Wine button and the
          // bottom navigation. This is a small additional margin so the
          // control never sits flush against that reserved zone.
          marginBottom: "0.5rem",
        }}
      >
        <span style={{ fontSize: "0.6875rem", color: "var(--text-tertiary)" }}>
          Drag to rotate
        </span>
        <button
          type="button"
          onClick={() => setRotation(0)}
          disabled={rotation === 0}
          style={{
            minHeight: 44,
            padding: "0 0.875rem",
            borderRadius: 8,
            fontSize: "0.75rem",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid var(--border-subtle)",
            color: rotation === 0 ? "var(--text-tertiary)" : "var(--accent-gold)",
          }}
        >
          Face on
        </button>
      </div>
    </div>
  );
}

/**
 * One slot.
 *
 * Rotation is applied per slot rather than to the whole group, because the
 * vertical shear depends on how far the slot sits from the axis — that is
 * what produces the sense of depth.
 */
function SlotShape({
  slot,
  occupant,
  centreX,
  squash,
  shear,
  faded,
  selected,
  onClick,
}: {
  slot: Slot;
  occupant: RackBottle | null;
  centreX: number;
  squash: number;
  shear: number;
  faded: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const offsetFromAxis = slot.x + slot.width / 2 - centreX;
  const x = centreX + offsetFromAxis * squash - slot.width / 2;
  const y = slot.y + offsetFromAxis * shear * 0.14;

  const wine = occupant?.wine ?? null;
  const fill = wine?.colour
    ? (COLOUR_FOR_WINE[wine.colour] ?? "#6B5A46")
    : occupant
      ? "#6B5A46"
      : "transparent";

  const window = wine
    ? assessWindow({ from: wine.drinkFrom, until: wine.drinkUntil })
    : null;

  const label = occupant
    ? `${wine ? `${wine.name}${wine.vintage ? ` ${wine.vintage}` : ""}` : "Bottle"}` +
      ` at ${describeSlot(slot)}`
    : `Empty slot ${describeSlot(slot)}`;

  return (
    <g
      opacity={faded ? 0.18 : 1}
      style={{
        transition: "opacity 160ms ease",
        cursor: occupant ? "pointer" : "default",
      }}
      onClick={onClick}
      role={occupant ? "button" : undefined}
      aria-label={label}
      tabIndex={occupant ? 0 : undefined}
      onKeyDown={(e) => {
        if (occupant && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* Chamfered slots are drawn with a cut top-left corner. The flag comes
          from the domain; this component does not decide which slots have it. */}
      {slot.isChamfered ? (
        <polygon
          points={chamferPoints(x, y, slot.width, slot.height)}
          fill={fill}
          stroke={selected ? "var(--accent-gold)" : "rgba(255,255,255,0.16)"}
          strokeWidth={selected ? 0.08 : 0.03}
        />
      ) : (
        <rect
          x={x}
          y={y}
          width={slot.width}
          height={slot.height}
          rx={0.12}
          fill={fill}
          stroke={selected ? "var(--accent-gold)" : "rgba(255,255,255,0.16)"}
          strokeWidth={selected ? 0.08 : 0.03}
        />
      )}

      {window && (
        <circle
          cx={x + slot.width - 0.22}
          cy={y + 0.22}
          r={0.1}
          fill={STATUS_COLOUR[window.indicator]}
        />
      )}
    </g>
  );
}

function chamferPoints(x: number, y: number, w: number, h: number): string {
  const cut = Math.min(w, h) * 0.38;
  return [
    `${x + cut},${y}`,
    `${x + w},${y}`,
    `${x + w},${y + h}`,
    `${x},${y + h}`,
    `${x},${y + cut}`,
  ].join(" ");
}

/** Human label from the slot's own keys — no layout knowledge needed. */
function describeSlot(slot: Slot): string {
  return Object.entries(slot.position)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

export default RackRenderer;
