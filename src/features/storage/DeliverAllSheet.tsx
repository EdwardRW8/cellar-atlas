import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { PositionPicker } from "./StoragePickers";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";
import type { DomainBottle, DomainStorageLocation, DomainWine } from "@/domain/types";

/**
 * Deliver a merchant order home.
 *
 * ── WHY THIS NEEDS POSITIONS ─────────────────────────────────────────────
 * The first version always sent `position: null`. That works for
 * unpositioned storage but is refused outright by a positioned destination:
 * `validate_position` raises "A staircase location requires a position", so
 * delivering six bottles into a rack failed six times over.
 *
 * The database was right. The UI was wrong: it never asked where the bottles
 * were going.
 *
 * So a positioned destination now requires a slot for every bottle before
 * Deliver is enabled. An unpositioned destination is unchanged — pick, confirm,
 * done, with no extra step.
 *
 * ── GEOMETRY IS NOT REIMPLEMENTED HERE ───────────────────────────────────
 * Slot enumeration, validity, occupancy and duplicate prevention all come from
 * `PositionPicker`, which already takes an ARRAY of positions and an
 * occupied-key set because Add Wine needed exactly this for multi-bottle
 * acquisitions. It also carries "Fill the next N free slots", which makes a
 * twelve-bottle delivery one tap rather than twelve.
 *
 * No staircase or grid rule appears in this file.
 */
export function DeliverAllSheet({
  bottles,
  wines,
  destinations,
  allBottles,
  onCancel,
  onDeliver,
}: {
  bottles: DomainBottle[];
  wines: Map<string, DomainWine>;
  destinations: DomainStorageLocation[];
  /** Every bottle in the cellar — used to work out which slots are taken. */
  allBottles: DomainBottle[];
  onCancel: () => void;
  onDeliver: (
    selected: DomainBottle[],
    destinationId: string,
    positions: (Record<string, number> | null)[],
  ) => Promise<{
    delivered: string[];
    failed: { bottleId: string; error: string }[];
  }>;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(bottles.map((b) => b.id)),
  );
  const [destinationId, setDestinationId] = useState<string | null>(
    destinations[0]?.id ?? null,
  );
  const [positions, setPositions] = useState<(Record<string, number> | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    delivered: number;
    failed: { bottleId: string; error: string }[];
    sourceName: string;
  } | null>(null);

  const destination = destinations.find((d) => d.id === destinationId) ?? null;
  const needsPositions = destination?.isPositioned === true;

  const chosen = useMemo(
    () => bottles.filter((b) => selected.has(b.id)),
    [bottles, selected],
  );

  /** Slots already taken at the destination. */
  const occupiedKeys = useMemo(() => {
    if (!destination) return new Set<string>();
    return new Set(
      allBottles
        .filter(
          (b) =>
            b.isActive && b.storageLocationId === destination.id && b.positionKey !== null,
        )
        .map((b) => b.positionKey!),
    );
  }, [allBottles, destination]);

  // Keep one position slot per selected bottle. Changing destination or
  // selection resets them: a slot valid in one rack means nothing in another.
  useEffect(() => {
    setPositions(needsPositions ? chosen.map(() => null) : []);
  }, [needsPositions, chosen.length, destinationId]);

  const allAssigned =
    !needsPositions ||
    (positions.length === chosen.length && positions.every((p) => p !== null));

  const nameOf = (b: DomainBottle) => {
    const w = wines.get(b.wineDefinitionId);
    return w ? `${w.name}${w.vintage ? ` ${w.vintage}` : ""}` : "Unknown wine";
  };

  // ── RESULT ──────────────────────────────────────────────────────────────
  if (result) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {result.delivered > 0 && (
          <p role="status" style={noticeStyle("var(--status-ready)", "110,231,160")}>
            {result.delivered} bottle{result.delivered === 1 ? "" : "s"} delivered.
          </p>
        )}

        {result.failed.length > 0 && (
          <div role="alert" style={noticeStyle("var(--status-approaching)", "245,181,68")}>
            {/*
              Truthful state only. The earlier wording claimed these were
              "queued and will retry", which was false — nothing enqueues
              them, so the user would have waited for a retry that never came.
            */}
            <p style={{ marginBottom: result.failed.length > 0 ? "0.5rem" : 0 }}>
              {result.failed.length} bottle{result.failed.length === 1 ? "" : "s"} could not
              be delivered and remain{result.failed.length === 1 ? "s" : ""} at{" "}
              {result.sourceName}.
            </p>
            <ul
              style={{
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {result.failed.slice(0, 5).map((f) => (
                <li key={f.bottleId} style={{ fontSize: "0.75rem" }}>
                  {humaniseFailure(f.error)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button fullWidth onClick={onCancel}>
          Done
        </Button>
      </div>
    );
  }

  // ── FORM ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", lineHeight: 1.6 }}>
        Choose where these bottles are going. Each is recorded as a delivery, so your
        history shows the order arriving.
      </p>

      {destinations.length === 0 ? (
        <p
          role="alert"
          style={{ color: "var(--status-approaching)", fontSize: "0.8125rem" }}
        >
          There is nowhere to deliver to yet. Create a storage location first.
        </p>
      ) : (
        <>
          <fieldset style={{ border: "none" }}>
            <legend style={legendStyle}>Deliver to</legend>
            <div
              role="radiogroup"
              aria-label="Destination"
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              {destinations.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="radio"
                  aria-checked={destinationId === d.id}
                  onClick={() => setDestinationId(d.id)}
                  style={optionStyle(destinationId === d.id)}
                >
                  <span style={{ display: "block" }}>{d.name}</span>
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.6875rem",
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    {d.isPositioned ? "Needs a slot for each bottle" : "No fixed positions"}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: "none" }}>
            <legend style={legendStyle}>
              Bottles ({selected.size} of {bottles.length})
            </legend>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {bottles.map((b) => {
                const on = selected.has(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        next.has(b.id) ? next.delete(b.id) : next.add(b.id);
                        return next;
                      })
                    }
                    style={{
                      ...optionStyle(on),
                      minHeight: TOUCH_TARGET_MIN_PX,
                      fontSize: "0.8125rem",
                    }}
                  >
                    {on ? "✓ " : "　"}
                    {nameOf(b)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Positions, only where the destination requires them. */}
          {needsPositions && chosen.length > 0 && (
            <fieldset style={{ border: "none" }}>
              <legend style={legendStyle}>Slots in {destination!.name}</legend>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-tertiary)",
                  marginBottom: "0.5rem",
                  lineHeight: 1.6,
                }}
              >
                {destination!.name} uses fixed positions, so every bottle needs a slot
                before it can be delivered.
              </p>
              <PositionPicker
                location={destination}
                occupiedKeys={occupiedKeys}
                positions={positions}
                onChange={(index, position) =>
                  setPositions((prev) => {
                    const next = [...prev];
                    next[index] = position;
                    return next;
                  })
                }
              />
            </fieldset>
          )}

          {needsPositions && !allAssigned && chosen.length > 0 && (
            <p style={{ fontSize: "0.75rem", color: "var(--status-approaching)" }}>
              {positions.filter((p) => p === null).length} bottle
              {positions.filter((p) => p === null).length === 1 ? "" : "s"} still need a
              slot.
            </p>
          )}

          <Button
            fullWidth
            disabled={busy || chosen.length === 0 || !destinationId || !allAssigned}
            onClick={async () => {
              setBusy(true);
              const outcome = await onDeliver(
                chosen,
                destinationId!,
                needsPositions ? positions : chosen.map(() => null),
              );
              setBusy(false);
              setResult({
                delivered: outcome.delivered.length,
                failed: outcome.failed,
                sourceName: sourceNameOf(bottles, destinations),
              });
            }}
          >
            {busy
              ? "Delivering…"
              : `Deliver ${chosen.length} bottle${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </>
      )}

      <Button variant="ghost" fullWidth onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * A readable reason, never a raw Postgres error.
 *
 * Constraint names and SQLSTATE codes mean nothing to someone unpacking a
 * wine delivery.
 */
export function humaniseFailure(error: string): string {
  const e = error.toLowerCase();
  // Deliberately NOT a bare `includes("position")`: a constraint name such as
  // `bottles_position_key_check` contains the word without being a
  // missing-position error, and would be mistranslated.
  if (
    e.includes("requires a position") ||
    e.includes("invalid position") ||
    e.includes("position is not valid")
  )
    return "That slot is no longer available.";
  if (e.includes("version conflict") || e.includes("conflict"))
    return "This bottle changed on another device.";
  if (e.includes("already occupied") || e.includes("unique"))
    return "That slot has just been taken.";
  if (e.includes("permission") || e.includes("denied") || e.includes("row-level"))
    return "You do not have permission to move this bottle.";
  return "Could not be delivered.";
}

/** The source is whatever the bottles are currently in. */
function sourceNameOf(
  bottles: DomainBottle[],
  destinations: DomainStorageLocation[],
): string {
  const id = bottles[0]?.storageLocationId;
  if (!id) return "their current location";
  return destinations.find((d) => d.id === id)?.name ?? "their current location";
}

const legendStyle: React.CSSProperties = {
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.5rem",
};

const optionStyle = (on: boolean): React.CSSProperties => ({
  width: "100%",
  textAlign: "left",
  minHeight: TOUCH_TARGET_MIN_PX,
  padding: "0.625rem 0.875rem",
  borderRadius: 10,
  background: on ? "rgba(217,174,85,0.12)" : "rgba(255,255,255,0.04)",
  border: `1px solid ${on ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
  color: on ? "var(--accent-gold)" : "var(--text-secondary)",
});

const noticeStyle = (colour: string, rgb: string): React.CSSProperties => ({
  padding: "0.875rem 1rem",
  borderRadius: 10,
  background: `rgba(${rgb},0.08)`,
  border: `1px solid rgba(${rgb},0.3)`,
  color: colour,
  fontSize: "0.875rem",
  lineHeight: 1.6,
});
