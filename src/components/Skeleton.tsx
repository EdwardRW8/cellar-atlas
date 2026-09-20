/** Matches final layout to avoid shift. Never a spinner for lists. */
export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <span className="visually-hidden">Loading</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          style={{
            height: 76,
            borderRadius: 12,
            background:
              "linear-gradient(90deg, var(--surface-raised) 0%," +
              " rgba(255,255,255,0.03) 50%, var(--surface-raised) 100%)",
            border: "1px solid var(--border-subtle)",
          }}
        />
      ))}
    </div>
  );
}
