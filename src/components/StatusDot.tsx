import type { WindowIndicator } from "@/domain/drinking-window";

const COLOURS: Record<WindowIndicator, string> = {
  ready: "var(--status-ready)",
  young: "var(--status-approaching)",
  past: "var(--status-past)",
  unknown: "var(--text-tertiary)",
};

const LABELS: Record<WindowIndicator, string> = {
  ready: "Ready to drink",
  young: "Not yet ready",
  past: "Past window",
  unknown: "Window unknown",
};

export function StatusDot({
  indicator,
  size = 8,
}: {
  indicator: WindowIndicator;
  size?: number;
}) {
  return (
    <span
      role="img"
      aria-label={LABELS[indicator]}
      title={LABELS[indicator]}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: COLOURS[indicator],
        boxShadow: `0 0 ${size}px ${COLOURS[indicator]}`,
        flexShrink: 0,
      }}
    />
  );
}
