import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCellar, useBottle } from "@/hooks/useCellar";
import { assessWindow } from "@/domain/drinking-window";
import { describePosition } from "@/features/storage/StoragePickers";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { BottleActionSheet } from "./BottleActions";

interface EventRow {
  id: string;
  event_type: string;
  occurred_at: string;
  reason: string | null;
  notes: string | null;
}

export default function BottleDetailScreen() {
  const { bottleId } = useParams();
  const navigate = useNavigate();
  const data = useBottle(bottleId);
  const { repository } = useCellar();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [showActions, setShowActions] = useState(false);

  useEffect(() => {
    if (!bottleId || !repository) return;
    void repository
      .loadEvents(bottleId)
      .then((rows) => setEvents(rows as unknown as EventRow[]))
      .catch(() => setEvents([]));
  }, [bottleId, repository]);

  if (!data?.wine) {
    return (
      <div style={{ padding: "1.25rem" }}>
        <EmptyState
          title="Bottle not found"
          action={<Button onClick={() => navigate("/cellar")}>Back to cellar</Button>}
        />
      </div>
    );
  }

  const { bottle, wine, location } = data;
  const window = assessWindow({ from: wine.drinkFrom, until: wine.drinkUntil });

  return (
    <div style={{ padding: "1rem 1rem 2rem" }}>
      <button
        onClick={() => navigate(`/cellar/wine/${wine.id}`)}
        style={{
          minHeight: 44,
          color: "var(--text-tertiary)",
          fontSize: "0.8125rem",
          marginBottom: "0.5rem",
        }}
      >
        ← {wine.name}
      </button>

      <header style={{ marginBottom: "1.25rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
            fontStyle: "italic",
          }}
        >
          {wine.name}
          {wine.vintage ? ` ${wine.vintage}` : ""}
        </h1>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
          {wine.producer} · one bottle
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
          <StatusDot indicator={window.indicator} />
          <span style={{ fontSize: "0.8125rem", color: "var(--text-tertiary)" }}>
            {window.label}
          </span>
        </div>
      </header>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.5rem 1rem",
          marginBottom: "1.5rem",
        }}
      >
        <Row k="Status" v={bottle.status.replace("_", " ")} />
        <Row k="Size" v={bottle.bottleSize} />
        <Row k="Location" v={location?.name ?? "None"} />
        {bottle.position && <Row k="Position" v={describePosition(bottle.position)} />}
        <Row
          k="Current value"
          v={
            bottle.currentValue !== null
              ? new Intl.NumberFormat("en-GB", {
                  style: "currency",
                  currency: "GBP",
                }).format(bottle.currentValue)
              : "—"
          }
        />
        <Row k="Provenance" v={bottle.acquisitionItemId ? "Purchased" : "Unknown"} />
      </dl>

      {bottle.isActive && (
        <Button fullWidth onClick={() => setShowActions(true)}>
          Actions
        </Button>
      )}

      <section style={{ marginTop: "1.75rem" }}>
        <h2
          style={{
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: "0.75rem",
          }}
        >
          History ({events.length})
        </h2>
        {events.length === 0 ? (
          <p style={{ color: "var(--text-tertiary)", fontSize: "0.875rem" }}>
            No events recorded yet.
          </p>
        ) : (
          <ol
            style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}
          >
            {events.map((e) => (
              <li
                key={e.id}
                style={{
                  padding: "0.75rem 0.875rem",
                  borderRadius: 10,
                  background: "var(--surface-raised)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span
                    style={{
                      fontSize: "0.875rem",
                      color: "var(--text-primary)",
                      textTransform: "capitalize",
                    }}
                  >
                    {e.event_type.replace("_", " ")}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>
                    {new Date(e.occurred_at).toLocaleDateString("en-GB")}
                  </span>
                </div>
                {(e.reason || e.notes) && (
                  <p
                    style={{
                      fontSize: "0.8125rem",
                      color: "var(--text-secondary)",
                      marginTop: 4,
                    }}
                  >
                    {e.reason ?? e.notes}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {showActions && (
        <BottleActionSheet
          bottle={bottle}
          wineName={wine.name}
          onClose={() => setShowActions(false)}
        />
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "contents" }}>
      <dt style={{ fontSize: "0.75rem", color: "var(--text-tertiary)" }}>{k}</dt>
      <dd
        style={{
          fontSize: "0.875rem",
          color: "var(--text-secondary)",
          textAlign: "right",
          textTransform: "capitalize",
        }}
      >
        {v}
      </dd>
    </div>
  );
}
