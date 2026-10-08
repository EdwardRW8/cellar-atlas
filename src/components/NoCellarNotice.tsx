import { Link } from "react-router-dom";

/**
 * Shown on screens that need a cellar when the signed-in user has none yet.
 *
 * This is a first-run state, not a failure. These screens previously rendered
 * "Could not load your cellar" over a raw error, which told a brand-new user
 * the app was broken when nothing was wrong. Creation lives in one place —
 * Home — so this points there rather than offering a second way to do it.
 */
export function NoCellarNotice({ what }: { what: string }) {
  return (
    <div
      style={{
        padding: "1.25rem",
        borderRadius: 14,
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <h2
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.25rem",
          fontStyle: "italic",
          color: "var(--text-primary)",
          marginBottom: "0.5rem",
        }}
      >
        Create your cellar first
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "0.875rem",
          marginBottom: "1rem",
          lineHeight: 1.6,
        }}
      >
        {what} once you have a cellar.
      </p>
      <Link to="/" style={{ color: "var(--accent-gold)", fontSize: "0.875rem" }}>
        Go to Home to create it
      </Link>
    </div>
  );
}
