import type { ReactNode } from "react";
import { useAuth } from "@/app/providers/AuthProvider";
import { SignIn } from "./SignIn";
import { Spinner } from "@/components/Spinner";
import { missingConfigMessage } from "@/data/supabase-client";

export function AuthGate({ children }: { children: ReactNode }) {
  const { session, ready, configured } = useAuth();

  if (!configured) {
    return (
      <div style={{ padding: "2rem", maxWidth: 520, margin: "0 auto" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.75rem",
            fontStyle: "italic",
            marginBottom: "1rem",
          }}
        >
          Configuration needed
        </h1>
        <p
          style={{ color: "var(--text-secondary)", fontSize: "0.9375rem", lineHeight: 1.7 }}
        >
          {missingConfigMessage}
        </p>
      </div>
    );
  }

  if (!ready) return <Spinner label="Opening the cellar" />;
  if (!session) return <SignIn />;
  return <>{children}</>;
}
