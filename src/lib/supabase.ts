import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { CONFIG, isSupabaseConfigured } from "../config.js";

let adminClient: SupabaseClient | null = null;

/**
 * Returns the server-only admin Supabase client (using service role key).
 * Bypasses RLS - queries must explicitly filter by tenant workspace/assistant scope.
 */
export function getAdminClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured. Missing SUPABASE_URL or keys.");
  }
  if (!adminClient) {
    adminClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }
  return adminClient;
}

/**
 * Returns a public anon Supabase client.
 */
export function getAnonClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured.");
  }
  return createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
}

/**
 * Creates a scoped Supabase client with the user's JWT access token.
 * Enforces RLS based on the user's identity.
 */
export function createUserClient(accessToken: string): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured.");
  }
  return createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
