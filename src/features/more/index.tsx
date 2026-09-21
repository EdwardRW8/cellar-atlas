import { useNavigate } from "react-router-dom";
import { useAuth } from "@/app/providers/AuthProvider";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";

const LATER = [{ label: "Backup & data", note: "Phase 10" }];

export default function More() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();

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

      {/* Phase 8: the two new destinations. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          marginBottom: "2rem",
        }}
      >
        {(
          [
            ["Intelligence", "/intelligence", "What your cellar is doing"],
            ["Cellar profile", "/profile", "How you drink and buy"],
            ["Tastings", "/tastings", "Every wine you have tasted"],
            ["History", "/history", "Everything that has happened"],
            ["Import wines", "/import", "Add a collection from a CSV file"],
          ] as const
        ).map(([label, path, detail]) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            style={{
              width: "100%",
              textAlign: "left",
              minHeight: TOUCH_TARGET_MIN_PX + 12,
              padding: "0.875rem 1rem",
              borderRadius: 12,
              background: "var(--surface-raised)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <span
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: "0.9375rem", color: "var(--text-primary)" }}>
                {label}
              </span>
              <span aria-hidden style={{ color: "var(--accent-gold)" }}>
                →
              </span>
            </span>
            <span
              style={{
                display: "block",
                fontSize: "0.75rem",
                color: "var(--text-tertiary)",
                marginTop: 2,
              }}
            >
              {detail}
            </span>
          </button>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          marginBottom: "2rem",
        }}
      >
        {LATER.map((s) => (
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
