import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCellar, useWine } from "@/hooks/useCellar";
import { assessWindow } from "@/domain/drinking-window";
import type { DomainBottle } from "@/domain/types";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { BottleActionSheet } from "./BottleActions";
import { Sheet } from "@/components/Sheet";
import { EditWineForm } from "./EditWineForm";
import { ValuationHistory } from "./ValuationHistory";
import { RecordValuationSheet } from "./RecordValuationSheet";
import { describePosition } from "@/features/storage/StoragePickers";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

export default function WineDetailScreen() {
  const { wineId } = useParams();
  const navigate = useNavigate();
  const data = useWine(wineId);
  const { locations, run, refresh } = useCellar();
  const [actionBottle, setActionBottle] = useState<DomainBottle | null>(null);
  const [editing, setEditing] = useState(false);
  const [valuing, setValuing] = useState(false);

  const locationName = useMemo(
    () => new Map(locations.map((l) => [l.id, l.name])),
    [locations],
  );

  if (!data) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <EmptyState
          title="Wine not found"
          description="It may have been removed."
          action={<Button onClick={() => navigate("/cellar")}>Back to cellar</Button>}
        />
      </div>
    );
  }

  const { summary, bottles, activeBottles } = data;
  const { wine } = summary;
  const window = assessWindow({ from: wine.drinkFrom, until: wine.drinkUntil });

  const inactive = bottles.filter((b) => !b.isActive);

  return (
    <div style={{ padding: "1rem 1rem 2rem" }}>
      <button
        onClick={() => navigate("/cellar")}
        style={{
          minHeight: 44,
          color: "var(--text-tertiary)",
          fontSize: "0.8125rem",
          marginBottom: "0.5rem",
        }}
      >
        ← Cellar
      </button>

      <header style={{ marginBottom: "1.25rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.75rem",
            fontStyle: "italic",
            lineHeight: 1.2,
          }}
        >
          {wine.name}
          {wine.vintage ? ` ${wine.vintage}` : ""}
        </h1>
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            marginTop: "0.25rem",
          }}
        >
          {wine.producer}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "0.5rem" }}>
          <StatusDot indicator={window.indicator} />
          <span style={{ fontSize: "0.8125rem", color: "var(--text-tertiary)" }}>
            {window.label}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: "1rem" }}>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit wine
          </Button>
        </div>

        {/* A wine created before wine type was required. Correctable here. */}
        {wine.colour === null && (
          <p
            style={{
              marginTop: "0.75rem",
              padding: "0.625rem 0.875rem",
              borderRadius: 10,
              background: "rgba(245,181,68,0.08)",
              border: "1px solid rgba(245,181,68,0.3)",
              color: "var(--status-approaching)",
              fontSize: "0.75rem",
              lineHeight: 1.6,
            }}
          >
            No wine type recorded. Use Edit wine to add one.
          </p>
        )}
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
          gap: 8,
          marginBottom: "1.5rem",
        }}
      >
        <Stat label="In cellar" value={activeBottles.length.toString()} />
        <Stat label="Total ever" value={bottles.length.toString()} />
        <Stat label="Locations" value={summary.locations.length.toString()} />
        <Stat
          label="Value"
          value={
            summary.totalValue !== null
              ? new Intl.NumberFormat("en-GB", {
                  style: "currency",
                  currency: "GBP",
                  maximumFractionDigits: 0,
                }).format(summary.totalValue)
              : "—"
          }
        />
      </section>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.5rem 1rem",
          marginBottom: "1.5rem",
        }}
      >
        {(
          [
            ["Type", wine.colour ?? "—"],
            ["Grapes", wine.grapes.join(", ") || "—"],
            ["Country", wine.geography.country?.name ?? "—"],
            ["Region", wine.geography.region?.name ?? wine.geography.unmatched ?? "—"],
            ["Appellation", wine.geography.appellation?.name ?? "—"],
            [
              "Window",
              wine.drinkFrom || wine.drinkUntil
                ? `${wine.drinkFrom ?? "?"} – ${wine.drinkUntil ?? "?"}`
                : "Unknown",
            ],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>{k}</dt>
            <dd
              style={{
                fontSize: "0.875rem",
                color: "var(--text-secondary)",
                textAlign: "right",
              }}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>

      <section>
        <h2
          style={{
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: "0.625rem",
          }}
        >
          Bottles in cellar ({activeBottles.length})
        </h2>

        {activeBottles.length === 0 ? (
          <p
            style={{
              color: "var(--text-tertiary)",
              fontSize: "0.875rem",
              padding: "1rem 0",
            }}
          >
            No bottles of this wine remain in your cellar.
          </p>
        ) : (
          <ul
            style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}
          >
            {activeBottles.map((b, i) => (
              <li key={b.id}>
                <BottleRow
                  bottle={b}
                  index={i + 1}
                  locationName={
                    b.storageLocationId
                      ? (locationName.get(b.storageLocationId) ?? "Unknown")
                      : "No location"
                  }
                  onAction={() => setActionBottle(b)}
                  onOpen={() => navigate(`/cellar/bottle/${b.id}`)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {inactive.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2
            style={{
              fontSize: "0.6875rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              marginBottom: "0.625rem",
            }}
          >
            History ({inactive.length})
          </h2>
          <ul
            style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}
          >
            {inactive.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => navigate(`/cellar/bottle/${b.id}`)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    minHeight: TOUCH_TARGET_MIN_PX,
                    padding: "0.625rem 0.875rem",
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-tertiary)",
                    fontSize: "0.8125rem",
                  }}
                >
                  {b.status}
                  {b.statusChangedAt
                    ? ` · ${new Date(b.statusChangedAt).toLocaleDateString("en-GB")}`
                    : ""}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Valuation: history, holding cost, value and unrealised gain. */}
      <ValuationHistory
        wineId={wine.id}
        bottles={bottles.filter((b) => b.isActive && b.wineDefinitionId === wine.id)}
        onRecordValuation={() => setValuing(true)}
      />

      {actionBottle && (
        <BottleActionSheet
          bottle={actionBottle}
          wineName={wine.name}
          onClose={() => setActionBottle(null)}
        />
      )}

      <Sheet open={valuing} onClose={() => setValuing(false)} title="Record valuation">
        <RecordValuationSheet
          wine={wine}
          activeBottles={bottles.filter(
            (b) => b.isActive && b.wineDefinitionId === wine.id,
          )}
          onCancel={() => setValuing(false)}
          onSubmit={async (v) => {
            // Wine-level or bottle-level, both through the existing
            // SECURITY INVOKER RPC. The scope is carried by which id is set.
            const outcome = await run(
              v.wineId
                ? `Value all bottles of ${wine.name}`
                : `Value a bottle of ${wine.name}`,
              (m) =>
                m.recordValuation({
                  wineId: v.wineId,
                  bottleId: v.bottleId,
                  amount: v.amount,
                  basis: v.basis,
                  currency: v.currency,
                }),
            );
            if (outcome.ok) {
              setValuing(false);
              await refresh();
            }
            return { ok: outcome.ok, error: outcome.error };
          }}
        />
      </Sheet>

      <Sheet open={editing} onClose={() => setEditing(false)} title="Edit wine">
        <EditWineForm
          wine={wine}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            // The established mutation path: SECURITY INVOKER RPC, expected
            // version, operation id. Bottles, acquisitions, tastings and
            // history are untouched — only the definition changes.
            const outcome = await run(`Edit ${wine.name}`, (m) =>
              m.updateWine({
                wineId: wine.id,
                version: wine.version,
                patch,
              }),
            );
            if (outcome.ok) {
              setEditing(false);
              await refresh();
            }
            return { ok: outcome.ok, error: outcome.error };
          }}
        />
      </Sheet>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "0.75rem",
        borderRadius: 12,
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.25rem",
          color: "var(--text-primary)",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "0.625rem",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  );
}

/**
 * One PHYSICAL bottle.
 *
 * Amendment 6: when several bottles exist, the user must be able to tell them
 * apart and choose deliberately. Each row shows its own location and position
 * so the event lands on the right bottle.
 */
function BottleRow({
  bottle,
  index,
  locationName,
  onAction,
  onOpen,
}: {
  bottle: DomainBottle;
  index: number;
  locationName: string;
  onAction: () => void;
  onOpen: () => void;
}) {
  const where = bottle.position
    ? `${locationName} · ${describePosition(bottle.position)}`
    : locationName;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 6,
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <button
        onClick={onOpen}
        style={{
          flex: 1,
          textAlign: "left",
          minHeight: TOUCH_TARGET_MIN_PX,
          padding: "0.625rem 0.875rem",
        }}
      >
        <span
          style={{ display: "block", fontSize: "0.875rem", color: "var(--text-primary)" }}
        >
          Bottle {index}
          <span style={{ color: "var(--text-tertiary)", fontSize: "0.75rem" }}>
            {" "}
            · {bottle.bottleSize}
          </span>
        </span>
        <span
          style={{
            display: "block",
            fontSize: "0.75rem",
            color: "var(--text-tertiary)",
            marginTop: 2,
          }}
        >
          {where}
        </span>
      </button>

      <button
        onClick={onAction}
        aria-label={`Actions for bottle ${index} at ${where}`}
        style={{
          minWidth: TOUCH_TARGET_MIN_PX,
          minHeight: TOUCH_TARGET_MIN_PX,
          borderLeft: "1px solid var(--border-subtle)",
          color: "var(--accent-gold)",
          fontSize: "1.125rem",
        }}
      >
        ⋯
      </button>
    </div>
  );
}
