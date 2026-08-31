import { EmptyState } from "@/components/EmptyState";

export default function Home() {
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
          Home
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
          Your cellar today
        </p>
      </header>
      <EmptyState
        title="Nothing to report yet"
        description="Once you add wines, this is where the day's insight and actions will appear."
      />
    </div>
  );
}
