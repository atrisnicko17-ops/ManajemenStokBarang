import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | null = null;

export const DEFAULT_SUPABASE_PROJECT_URL =
  'https://xlnimeszzyaryntlplcn.supabase.co';

function resolvePublishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function getConfiguredSupabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_PROJECT_URL;
}

export function isSupabaseConfigured(): boolean {
  const url = getConfiguredSupabaseUrl();
  const key = resolvePublishableKey();
  return Boolean(
    url &&
      key &&
      url.startsWith('https://') &&
      !url.includes('your-project-ref') &&
      !key.includes('your_key_here')
  );
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  if (!browserClient) {
    browserClient = createClient(
      getConfiguredSupabaseUrl(),
      resolvePublishableKey()!,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }
    );
  }
  return browserClient;
}
