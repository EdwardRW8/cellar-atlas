/**
 * Occupancy, derived from a layout's own configuration.
 *
 * Pure. Knows nothing about any specific layout type — it asks `capacity()`,
 * which dispatches on the type. A seventh layout type needs no change here.
 *
 * Unbounded storage (unpositioned, external) genuinely has no capacity, so
 * `capacity`, `free` and `percentFull` are null rather than zero. Zero would
 * be a lie: a merchant holding 200 bottles is not "0% full".
 */

import { capacity, type LayoutType, type LayoutConfig } from "./layout";

export interface Occupancy {
  occupied: number;
  /** Null when the layout is unbounded. */
  capacity: number | null;
  free: number | null;
  /** 0–100. Null when unbounded. */
  percentFull: number | null;
  isFull: boolean;
  /** A short human summary, e.g. "12 of 130 · 118 free". */
  label: string;
}

export function computeOccupancy(
  occupied: number,
  type: LayoutType | null,
  config: LayoutConfig | null,
): Occupancy {
  const total = type ? capacity(type, config ?? ({} as LayoutConfig)) : null;

  if (total === null) {
    return {
      occupied,
      capacity: null,
      free: null,
      percentFull: null,
      isFull: false,
      label: occupied === 0 ? "Empty" : `${occupied} bottle${occupied === 1 ? "" : "s"}`,
    };
  }

  const free = Math.max(0, total - occupied);
  const percentFull = total === 0 ? 0 : Math.round((occupied / total) * 100);

  return {
    occupied,
    capacity: total,
    free,
    percentFull,
    isFull: occupied >= total,
    label: `${occupied} of ${total} · ${free} free`,
  };
}

/**
 * Would a proposed config invalidate any occupied position?
 *
 * Mirrors `layout_change_conflicts()` in SQL so the UI can warn before the
 * server refuses. The database remains authoritative — this is a courtesy,
 * not a substitute.
 */
export interface GeometryConflict {
  bottleId: string;
  position: Record<string, number>;
  positionKey: string | null;
  reason: string;
}

export function findGeometryConflicts(
  bottles: {
    id: string;
    position: Record<string, number> | null;
    positionKey: string | null;
    isActive: boolean;
  }[],
  newType: LayoutType,
  newConfig: LayoutConfig,
  validate: (
    type: LayoutType,
    config: LayoutConfig,
    position: unknown,
  ) => { valid: true; key: string } | { valid: false; reason: string },
): GeometryConflict[] {
  return bottles
    .filter((b) => b.isActive && b.position !== null)
    .map((b) => {
      const result = validate(newType, newConfig, b.position);
      return result.valid
        ? null
        : {
            bottleId: b.id,
            position: b.position!,
            positionKey: b.positionKey,
            reason: result.reason,
          };
    })
    .filter((c): c is GeometryConflict => c !== null);
}
