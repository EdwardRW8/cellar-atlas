import { EmptyState } from "@/components/EmptyState";

export default function Atlas() {
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
          Atlas
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
          Explore your cellar by country and region
        </p>
      </header>
      <EmptyState
        title="Nothing to map yet"
        description="The geographic view of your collection arrives in Phase 7."
      />
    </div>
  );
}
