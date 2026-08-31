/**
 * Supabase client.
 *
 * Credentials come from environment variables, never from source. V2
 * hard-coded its key — poor practice even for a publishable key, because it
 * makes rotating credentials a code change.
 *
 * In production these are set in Netlify → Site settings → Environment
 * variables. Vite inlines VITE_* vars at build time.
 *
 * The publishable key is safe in the browser ONLY because RLS is enabled on
 * every table. Without RLS it is a skeleton key.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && key);

export const missingConfigMessage =
  "Supabase is not configured. Set VITE_SUPABASE_URL and " +
  "VITE_SUPABASE_PUBLISHABLE_KEY in your Netlify environment variables.";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured) throw new Error(missingConfigMessage);
  if (!client) {
    client = createClient(url as string, key as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: "cellar_v3_auth",
      },
      // Realtime unused in Phase 1 — avoids a WebSocket dependency.
      realtime: { params: { eventsPerSecond: 0 } },
      global: { headers: { "x-client-info": "cellar-atlas" } },
    });
  }
  return client;
}
