import { EmptyState } from "@/components/EmptyState";

export default function Cellar() {
  return (
    <div style={{ padding: "1.25rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.875rem",
            fontStyle: "italic",
          }}
        >
          Cellar
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
          Every wine you own
        </p>
      </header>
      <EmptyState
        title="No wines yet"
        description="Wine and bottle management arrives in Phase 3."
      />
    </div>
  );
}
