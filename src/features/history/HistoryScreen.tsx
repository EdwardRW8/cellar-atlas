import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  groupByDay,
  describeEvent,
  describeWine,
  EVENT_FILTERS,
  type HistoryEvent,
} from "@/domain/history";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Cellar history.
 *
 * ── READ-ONLY, DELIBERATELY ──────────────────────────────────────────────
 * `bottle_events` is an append-only ledger with no UPDATE or DELETE policy.
 * This screen therefore offers NO editing affordance of any kind: no edit
 * button, no swipe action, no long-press menu. An architecture test asserts
 * that this file imports no mutation.
 *
 * Rows are not even tappable-to-edit — tapping opens the bottle, which is a
 * navigation, not a change.
 *
 * ── PAGINATED ────────────────────────────────────────────────────────────
 * A large cellar has thousands of events. Pages of 50 are fetched through
 * `cellar_history`, keyed on the last `occurred_at` seen.
 */

const PAGE_SIZE = 50;

export default function HistoryScreen() {
  const { repository, state } = useCellar();
  const navigate = useNavigate();

  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null, replace: boolean) => {
      if (!repository) return;
      replace ? setLoading(true) : setLoadingMore(true);
      setError(null);
      try {
        const page = await repository.loadHistory({
          limit: PAGE_SIZE,
          before,
          eventTypes: types.length ? types : null,
        });
        setExhausted(page.length < PAGE_SIZE);
        setEvents((prev) => (replace ? page : [...prev, ...page]));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load history");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [repository, types],
  );

  // Re-fetch from the top whenever the filter changes.
  useEffect(() => {
    void load(null, true);
  }, [load]);

  const days = useMemo(() => groupByDay(events), [events]);
  const oldest = events.at(-1)?.occurredAt ?? null;

  const toggle = (type: string) =>
    setTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );

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
          History
        </h1>
        <p
          style={{
            fontSize: "0.6875rem",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginTop: "0.25rem",
          }}
        >
          Everything that has happened
        </p>
      </header>

      {/* Filters. Horizontal scroll is confined to this strip. */}
      <div
        style={{
          display: "flex",
          gap: 6,
          overflowX: "auto",
          paddingBottom: 4,
          marginBottom: "1rem",
        }}
      >
        {EVENT_FILTERS.map((f) => {
          const on = types.includes(f.type);
          return (
            <button
              key={f.type}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(f.type)}
              style={{
                flexShrink: 0,
                minHeight: TOUCH_TARGET_MIN_PX - 8,
                padding: "0.5rem 0.875rem",
                borderRadius: 999,
                fontSize: "0.8125rem",
                whiteSpace: "nowrap",
                background: on ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${on ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
                color: on ? "var(--accent-gold)" : "var(--text-secondary)",
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

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
          <Button variant="secondary" onClick={() => void load(null, true)}>
            Try again
          </Button>
        </div>
      )}

      {loading || state === "loading" ? (
        <Skeleton rows={4} />
      ) : days.length === 0 ? (
        <EmptyState
          title={types.length > 0 ? "Nothing matches" : "No history yet"}
          description={
            types.length > 0
              ? "No events of that kind have been recorded."
              : "As you add, move and drink bottles, everything appears here."
          }
          action={
            types.length > 0 ? (
              <Button variant="secondary" onClick={() => setTypes([])}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {days.map((day) => (
            <section key={day.date} style={{ marginBottom: "1.5rem" }}>
              <h2
                style={{
                  fontSize: "0.6875rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                  marginBottom: "0.625rem",
                }}
              >
                {day.label}
              </h2>

              <ul
                style={{
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {day.events.map((e) => (
                  <li key={e.id}>
                    {/* Navigation only. Nothing here edits history. */}
                    <button
                      type="button"
                      onClick={() => navigate(`/cellar/bottle/${e.bottleId}`)}
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
                        {describeEvent(e)}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.75rem",
                          color: "var(--text-tertiary)",
                          marginTop: 2,
                        }}
                      >
                        {describeWine(e)}
                        {e.reason ? ` · ${e.reason}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {!exhausted && (
            <Button
              variant="secondary"
              fullWidth
              disabled={loadingMore}
              onClick={() => void load(oldest, false)}
            >
              {loadingMore ? "Loading…" : "Load older"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
