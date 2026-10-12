// Shared helpers for HabbitFlow Edge Functions (Deno).
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2'

const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** CORS: only the configured site origins (plus the Capacitor app) may call these functions from a browser. */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const ok =
    allowed.length === 0 ||
    allowed.includes(origin) ||
    origin === 'https://localhost' || // Capacitor Android
    origin === 'capacitor://localhost'
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405)
  return null
}

export const env = (name: string) => Deno.env.get(name) ?? ''

/** Service-role client: bypasses RLS. Only ever used server-side. */
export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Client acting as the caller (RLS applies), plus the verified user. */
export async function userFromRequest(req: Request): Promise<{ user: User; client: SupabaseClient } | null> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY') || env('SB_PUBLISHABLE_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) return null
  return { user: data.user, client }
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
}

/** true = over the limit. Fails open only if the database is unreachable. */
export async function rateLimited(key: string, action: string, max: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await adminClient().rpc('hit_rate_limit', {
    p_key: key,
    p_action: action,
    p_max: max,
    p_window_seconds: windowSeconds,
  })
  if (error) {
    console.error('rate limit check failed', error.message)
    return false
  }
  return data === true
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const siteUrl = () => env('SITE_URL').replace(/\/+$/, '')

export const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 254
