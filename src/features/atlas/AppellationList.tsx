import {
  metricValue,
  formatMetric,
  type AtlasNode,
  type AtlasMetric,
} from "@/domain/atlas-aggregation";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Appellation view — RANKED BARS, DELIBERATELY NO MAP.
 *
 * This is the sharpest expression of "do not fake geography". There is no
 * trustworthy open dataset of appellation boundaries: the INAO holds the
 * French ones and does not licence them uniformly, and other countries are no
 * better. Any shape drawn here would be invented.
 *
 * So nothing is drawn. The user is told why, plainly, rather than being shown
 * a confident-looking approximation. A ranked comparison answers the actual
 * question — "where in Bordeaux is my wine?" — without pretending to know
 * where Pauillac ends.
 *
 * A test asserts this component renders no <svg>, <path>, <circle> or
 * <polygon>. That is not incidental; it is the requirement.
 */
export function AppellationList({
  appellations,
  regionName,
  metric,
}: {
  appellations: AtlasNode[];
  regionName: string;
  metric: AtlasMetric;
}) {
  if (appellations.length === 0) {
    return (
      <p
        style={{
          color: "var(--text-tertiary)",
          fontSize: "0.875rem",
          padding: "1rem 0",
          lineHeight: 1.6,
        }}
      >
        No appellations recorded within {regionName}. Wines here are held at region level.
      </p>
    );
  }

  const max = Math.max(...appellations.map((a) => metricValue(a, metric)), 0);

  return (
    <div>
      <ul
        style={{
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {appellations.map((a) => {
          const value = metricValue(a, metric);
          const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;

          return (
            <li
              key={a.id}
              style={{
                minHeight: TOUCH_TARGET_MIN_PX,
                padding: "0.625rem 0.875rem",
                borderRadius: 10,
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
                <span style={{ fontSize: "0.9375rem", color: "var(--text-primary)" }}>
                  {a.name}
                </span>
                <span style={{ fontSize: "0.8125rem", color: "var(--accent-gold)" }}>
                  {formatMetric(a, metric)}
                </span>
              </div>

              <div
                aria-hidden
                style={{
                  height: 4,
                  borderRadius: 2,
                  marginTop: "0.5rem",
                  background: "var(--border-subtle)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${width}%`,
                    background: "var(--accent-gold)",
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <p
        style={{
          fontSize: "0.6875rem",
          color: "var(--text-tertiary)",
          marginTop: "0.875rem",
          lineHeight: 1.6,
        }}
      >
        Appellations are compared, not mapped. No reliable open boundary data exists for
        wine appellations, and drawing an approximation would look authoritative while being
        wrong.
      </p>
    </div>
  );
}

export default AppellationList;
