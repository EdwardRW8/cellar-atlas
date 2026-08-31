export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "3rem",
      }}
    >
      <span className="visually-hidden">{label}</span>
      <span
        aria-hidden
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.25rem",
          fontStyle: "italic",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
    </div>
  );
}
