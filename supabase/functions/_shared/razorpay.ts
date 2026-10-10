// Minimal Razorpay REST client + signature checks (no SDK needed).
import { env } from './http.ts'

export const razorpayConfigured = () => Boolean(env('RAZORPAY_KEY_ID') && env('RAZORPAY_KEY_SECRET'))

export async function razorpay<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`)}`,
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Razorpay ${res.status}: ${(data as { error?: { description?: string } }).error?.description ?? 'error'}`)
  return data as T
}

export interface RzpSubscription {
  id: string
  status: string
  plan_id: string
  current_start: number | null
  current_end: number | null
  start_at?: number | null
  ended_at?: number | null
  notes?: Record<string, string>
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Checkout success callback: signature = HMAC(payment_id|subscription_id, key_secret). */
export async function verifyCheckoutSignature(paymentId: string, subscriptionId: string, signature: string): Promise<boolean> {
  return timingSafeEqual(await hmacHex(env('RAZORPAY_KEY_SECRET'), `${paymentId}|${subscriptionId}`), signature)
}

/** Webhooks: signature = HMAC(raw body, webhook secret). */
export async function verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
  const secret = env('RAZORPAY_WEBHOOK_SECRET')
  if (!secret || !signature) return false
  return timingSafeEqual(await hmacHex(secret, rawBody), signature)
}

/** Razorpay subscription status -> our status. */
export function mapStatus(s: string): string {
  switch (s) {
    case 'active':
      return 'active'
    case 'pending':
    case 'halted':
      return 'past_due'
    case 'cancelled':
      return 'cancelled'
    case 'completed':
    case 'expired':
      return 'expired'
    default:
      return 'created' // created / authenticated / paused: not paid yet
  }
}

export const toIso = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : null)
