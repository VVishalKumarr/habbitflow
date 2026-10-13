// Minimal Stripe REST client (no SDK). Configure with the STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET function secrets. Stripe takes form-encoded bodies.
import { env } from './http.ts'

export const stripeConfigured = () => Boolean(env('STRIPE_SECRET_KEY'))

/** Flattens { a: { b: 1 }, c: [x] } into Stripe's a[b]=1&c[0]=x form encoding. */
function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? form(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))))
    else if (typeof v === 'object') form(v as Record<string, unknown>, key, out)
    else out.append(key, String(v))
  }
  return out
}

export async function stripe<T>(path: string, init: { method?: string; body?: Record<string, unknown> } = {}): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: init.body ? form(init.body).toString() : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${(data as { error?: { message?: string } }).error?.message ?? 'error'}`)
  return data as T
}

export interface StripeSubscription {
  id: string
  status: string
  customer: string
  cancel_at_period_end: boolean
  metadata?: Record<string, string>
  start_date?: number
  current_period_start?: number
  current_period_end?: number
  ended_at?: number | null
  items?: { data: { current_period_start?: number; current_period_end?: number; price?: { id: string } }[] }
}

/** Stripe subscription status -> ours. */
export function mapStripeStatus(s: string): string {
  switch (s) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
      return 'cancelled'
    case 'incomplete_expired':
      return 'expired'
    default:
      return 'created' // incomplete / paused: not paid yet
  }
}

/** Period dates moved from the subscription to its items in newer API versions: read either. */
export function periodOf(sub: StripeSubscription): { start: string | null; end: string | null } {
  const item = sub.items?.data?.[0]
  const s = sub.current_period_start ?? item?.current_period_start ?? sub.start_date
  const e = sub.current_period_end ?? item?.current_period_end ?? sub.ended_at ?? undefined
  return { start: s ? new Date(s * 1000).toISOString() : null, end: e ? new Date(e * 1000).toISOString() : null }
}
