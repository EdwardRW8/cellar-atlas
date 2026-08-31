import { useAuth } from "@/app/providers/AuthProvider";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";

const SECTIONS = [
  { label: "Pairings", note: "Phase 9" },
  { label: "Tastings", note: "Phase 9" },
  { label: "History", note: "Phase 9" },
  { label: "Members", note: "Phase 3" },
  { label: "Backup & data", note: "Phase 10" },
];

export default function More() {
  const { session, signOut } = useAuth();

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
          More
        </h1>
      </header>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          marginBottom: "2rem",
        }}
      >
        {SECTIONS.map((s) => (
          <Card
            key={s.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ color: "var(--text-secondary)", fontSize: "0.9375rem" }}>
              {s.label}
            </span>
            <span
              style={{
                fontSize: "0.6875rem",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
              }}
            >
              {s.note}
            </span>
          </Card>
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "1.5rem" }}>
        <p
          style={{
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: "0.375rem",
          }}
        >
          Signed in as
        </p>
        <p style={{ color: "var(--text-secondary)", marginBottom: "1.25rem" }}>
          {session?.user.email}
        </p>
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
