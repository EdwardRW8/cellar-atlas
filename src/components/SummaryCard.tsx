import type { ReactNode } from "react";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * One Home panel.
 *
 * Renders as a button when it has somewhere to go, and as a plain region
 * otherwise — a card that does nothing should not look tappable.
 */
export function SummaryCard({
  title,
  value,
  detail,
  accent = "var(--accent-gold)",
  onClick,
  children,
}: {
  title: string;
  value?: string;
  detail?: string;
  accent?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
          }}
        >
          {title}
        </span>
        {onClick && (
          <span aria-hidden style={{ color: accent, fontSize: "0.875rem" }}>
            →
          </span>
        )}
      </div>

      {value && (
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.75rem",
            color: accent,
            marginTop: "0.375rem",
            lineHeight: 1.1,
          }}
        >
          {value}
        </div>
      )}

      {detail && (
        <div
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            marginTop: "0.25rem",
            lineHeight: 1.5,
          }}
        >
          {detail}
        </div>
      )}

      {children}
    </>
  );

  const style: React.CSSProperties = {
    width: "100%",
    textAlign: "left",
    minHeight: TOUCH_TARGET_MIN_PX,
    padding: "1rem",
    borderRadius: 14,
    background: "var(--surface-raised)",
    border: "1px solid var(--border-subtle)",
  };

  if (!onClick) {
    return (
      <section style={style} aria-label={title}>
        {body}
      </section>
    );
  }

  return (
    <button type="button" onClick={onClick} style={style}>
      {body}
    </button>
  );
}
