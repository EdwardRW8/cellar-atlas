import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  groupByMonth,
  summariseTastings,
  describeRating,
  describeTastedWine,
  wasTastedElsewhere,
  type TastingRecord,
} from "@/domain/tasting-log";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import { Sheet } from "@/components/Sheet";
import { Field } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Tasting log.
 *
 * Unlike History, tastings ARE editable — a tasting note is subjective and
 * people mistype ratings. Editing changes `tasting_records` only; the
 * `tasting_recorded` bottle event is untouched, so the record of when you
 * tasted the wine stays true.
 *
 * Tastings with a null `bottle_id` — wines tasted elsewhere — appear here
 * like any other, marked so the reader knows the wine was never in the cellar.
 */
export default function TastingLogScreen() {
  const { repository, run, state } = useCellar();
  const navigate = useNavigate();

  const [tastings, setTastings] = useState<TastingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TastingRecord | null>(null);

  const load = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    setError(null);
    try {
      setTastings(await repository.loadAllTastings());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tastings");
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const months = useMemo(() => groupByMonth(tastings), [tastings]);
  const stats = useMemo(() => summariseTastings(tastings), [tastings]);

  return (
    <div style={{ padding: "1.25rem" }}>
      <header style={{ marginBottom: "1rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.875rem",
            fontStyle: "italic",
          }}
        >
          Tastings
        </h1>
        {stats.total > 0 && (
          <p
            style={{
              fontSize: "0.8125rem",
              color: "var(--text-secondary)",
              marginTop: "0.375rem",
            }}
          >
            {stats.total} tasting{stats.total === 1 ? "" : "s"} · {stats.distinctWines} wine
            {stats.distinctWines === 1 ? "" : "s"}
            {stats.averageRating !== null && (
              <>
                {" "}
                · {stats.averageRating} average of {stats.rated} rated
              </>
            )}
          </p>
        )}
      </header>

      {error && (
        <div
          role="alert"
          style={{
            padding: "1rem",
            borderRadius: 12,
            marginBottom: "1rem",
            background: "var(--surface-raised)",
            border: "1px solid rgba(255,138,122,0.3)",
          }}
        >
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.875rem",
              marginBottom: "0.75rem",
            }}
          >
            {error}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {loading || state === "loading" ? (
        <Skeleton rows={4} />
      ) : months.length === 0 ? (
        <EmptyState
          title="No tastings yet"
          description="Record a tasting from any bottle, and it will appear here — along with wines you taste elsewhere."
          action={<Button onClick={() => navigate("/cellar")}>Open the cellar</Button>}
        />
      ) : (
        months.map((month) => (
          <section key={month.month} style={{ marginBottom: "1.5rem" }}>
            <h2
              style={{
                fontSize: "0.6875rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
                marginBottom: "0.625rem",
              }}
            >
              {month.label}
            </h2>

            <ul
              style={{
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {month.tastings.map((t) => (
                <li
                  key={t.id}
                  style={{
                    padding: "0.875rem 1rem",
                    borderRadius: 12,
                    background: "var(--surface-raised)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.9375rem",
                        color: "var(--text-primary)",
                      }}
                    >
                      {describeTastedWine(t)}
                    </span>
                    <span
                      style={{
                        fontSize: "0.8125rem",
                        color: "var(--accent-gold)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {describeRating(t.rating)}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    {t.producer ?? "Unknown producer"} · {t.tastedOn}
                    {t.context ? ` · ${t.context}` : ""}
                    {wasTastedElsewhere(t) && " · tasted elsewhere"}
                  </div>

                  {t.notes && (
                    <p
                      style={{
                        fontSize: "0.8125rem",
                        color: "var(--text-secondary)",
                        marginTop: "0.5rem",
                        lineHeight: 1.6,
                      }}
                    >
                      {t.notes}
                    </p>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: "0.75rem" }}>
                    <Button variant="secondary" onClick={() => setEditing(t)}>
                      Edit
                    </Button>
                    {t.wineId && (
                      <Button
                        variant="ghost"
                        onClick={() => navigate(`/cellar/wine/${t.wineId}`)}
                      >
                        Open wine
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title="Edit tasting">
        {editing && (
          <EditTastingForm
            tasting={editing}
            onCancel={() => setEditing(null)}
            onSave={async (patch) => {
              const r = await run(`Edit tasting`, (m) =>
                m.updateTasting({
                  tastingId: editing.id,
                  version: editing.version,
                  patch,
                }),
              );
              if (r.ok) {
                setEditing(null);
                await load();
              }
              return r.ok;
            }}
            onDelete={async (reason) => {
              const r = await run(`Remove tasting`, (m) =>
                m.deleteTasting({
                  tastingId: editing.id,
                  version: editing.version,
                  reason,
                }),
              );
              if (r.ok) {
                setEditing(null);
                await load();
              }
              return r.ok;
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function EditTastingForm({
  tasting,
  onCancel,
  onSave,
  onDelete,
}: {
  tasting: TastingRecord;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: (reason: string) => Promise<boolean>;
}) {
  const [rating, setRating] = useState<number | null>(tasting.rating);
  const [notes, setNotes] = useState(tasting.notes ?? "");
  const [context, setContext] = useState(tasting.context ?? "");
  const [tastedOn, setTastedOn] = useState(tasting.tastedOn);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (removing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.875rem",
            lineHeight: 1.6,
          }}
        >
          The tasting is kept with your reason attached, so the record that you tasted this
          wine stays intact. It simply stops appearing here.
        </p>
        <Field
          label="Why are you removing it?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Recorded twice"
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="ghost" fullWidth onClick={() => setRemoving(false)}>
            Back
          </Button>
          <Button
            variant="danger"
            fullWidth
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              await onDelete(reason.trim());
              setBusy(false);
            }}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <span
          style={{
            display: "block",
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            marginBottom: "0.5rem",
          }}
        >
          Rating
        </span>
        <div role="radiogroup" aria-label="Rating" style={{ display: "flex", gap: 6 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} of 5`}
              onClick={() => setRating(rating === n ? null : n)}
              style={{
                flex: 1,
                minHeight: TOUCH_TARGET_MIN_PX,
                borderRadius: 10,
                fontSize: "0.9375rem",
                background:
                  rating === n ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${
                  rating === n ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"
                }`,
                color: rating === n ? "var(--accent-gold)" : "var(--text-secondary)",
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <Field
        label="Tasted on"
        type="date"
        value={tastedOn}
        onChange={(e) => setTastedOn(e.target.value)}
      />
      <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <Field
        label="Context"
        value={context}
        onChange={(e) => setContext(e.target.value)}
        placeholder="With dinner, at the estate…"
      />

      <Button
        fullWidth
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onSave({
            rating,
            notes: notes.trim() || null,
            context: context.trim() || null,
            tasted_on: tastedOn,
          });
          setBusy(false);
        }}
      >
        {busy ? "Saving…" : "Save changes"}
      </Button>

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="ghost" fullWidth onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </div>
    </div>
  );
}
