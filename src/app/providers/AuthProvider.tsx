import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase, isSupabaseConfigured } from "@/data/supabase-client";

interface AuthContextValue {
  session: Session | null;
  /** False until the initial session check completes. Routing must wait. */
  ready: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const configured = isSupabaseConfigured;

  useEffect(() => {
    if (!configured) {
      setReady(true);
      return;
    }

    const sb = getSupabase();
    let active = true;

    sb.auth
      .getSession()
      .then(({ data }) => {
        if (active) {
          setSession(data.session);
          setReady(true);
        }
      })
      .catch(() => {
        // An offline start still resolves — a persisted session may exist
        // locally and the app should open rather than hang.
        if (active) setReady(true);
      });

    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [configured]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      ready,
      configured,

      async signIn(email, password) {
        const { error } = await getSupabase().auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw new Error(error.message);
      },

      async signUp(email, password) {
        const { data, error } = await getSupabase().auth.signUp({
          email,
          password,
        });
        if (error) throw new Error(error.message);
        // No session returned means email confirmation is required.
        return { needsConfirmation: !data.session };
      },

      async signOut() {
        await getSupabase().auth.signOut();
        setSession(null);
      },
    }),
    [session, ready, configured],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
