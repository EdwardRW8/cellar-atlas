import { EmptyState } from "@/components/EmptyState";

export default function Storage() {
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
          Storage
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
          Where your wine lives
        </p>
      </header>
      <EmptyState
        title="No storage locations yet"
        description="Racks, shelves, cases and merchant storage arrive in Phase 4."
      />
    </div>
  );
}
