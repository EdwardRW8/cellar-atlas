import { useState, type FormEvent } from "react";
import { useAuth } from "@/app/providers/AuthProvider";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";

type Mode = "signin" | "signup";

export function SignIn() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    setMessage(null);
    try {
      if (mode === "signup") {
        const { needsConfirmation } = await signUp(email, password);
        setMessage({
          ok: true,
          text: needsConfirmation
            ? "Account created. Check your email to confirm, then sign in."
            : "Account created. Signing you in…",
        });
        if (needsConfirmation) setMode("signin");
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof Error ? err.message : "Something went wrong",
      });
    }
    setBusy(false);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div style={{ width: "min(380px,100%)" }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "2.5rem",
              fontWeight: 300,
              fontStyle: "italic",
            }}
          >
            Cellar Atlas
          </h1>
          <p
            style={{
              fontSize: "0.6875rem",
              letterSpacing: "0.25em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              marginTop: "0.375rem",
            }}
          >
            Wine Collection
          </p>
        </div>

        <div
          style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 16,
            padding: "1.5rem",
          }}
        >
          <div style={{ display: "flex", gap: 6, marginBottom: "1.25rem" }} role="tablist">
            {(
              [
                ["signin", "Sign In"],
                ["signup", "Create Account"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  setMessage(null);
                }}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 10,
                  fontSize: "0.75rem",
                  letterSpacing: "0.06em",
                  background:
                    mode === m ? "rgba(217,174,85,0.10)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${mode === m ? "rgba(217,174,85,0.35)" : "var(--border-subtle)"}`,
                  color: mode === m ? "var(--accent-gold)" : "var(--text-tertiary)",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <form
            onSubmit={submit}
            style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Field
              label="Password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={mode === "signup" ? "At least 6 characters" : undefined}
              required
            />

            {message && (
              <div
                role="alert"
                style={{
                  padding: "0.75rem",
                  borderRadius: 10,
                  background: message.ok
                    ? "rgba(110,231,160,0.08)"
                    : "rgba(255,138,122,0.08)",
                  border: `1px solid ${message.ok ? "rgba(110,231,160,0.25)" : "rgba(255,138,122,0.25)"}`,
                  fontSize: "0.8125rem",
                  color: message.ok ? "var(--status-ready)" : "var(--status-past)",
                }}
              >
                {message.text}
              </div>
            )}

            <Button type="submit" disabled={busy || !email || !password} fullWidth>
              {busy ? "Please wait…" : mode === "signup" ? "Create Account" : "Sign In"}
            </Button>
          </form>
        </div>

        <p
          style={{
            textAlign: "center",
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginTop: "1.25rem",
          }}
        >
          Syncs across all your devices
        </p>
      </div>
    </div>
  );
}
