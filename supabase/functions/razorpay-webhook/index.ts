// Razorpay webhook (configure in Razorpay Dashboard -> Webhooks with the
// subscription.* events and the RAZORPAY_WEBHOOK_SECRET secret).
// Rejects anything without a valid HMAC signature.
import { adminClient } from '../_shared/http.ts'
import { mapStatus, razorpay, razorpayConfigured, toIso, verifyWebhookSignature, type RzpSubscription } from '../_shared/razorpay.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const raw = await req.text()
  if (!(await verifyWebhookSignature(raw, req.headers.get('x-razorpay-signature') ?? ''))) {
    return new Response('Invalid signature', { status: 401 })
  }

  let event: { event?: string; payload?: { subscription?: { entity?: RzpSubscription } } }
  try {
    event = JSON.parse(raw)
  } catch {
    return new Response('Bad payload', { status: 400 })
  }
  const hinted = event.payload?.subscription?.entity
  if (!event.event?.startsWith('subscription.') || !hinted?.id) return new Response('ignored', { status: 200 })

  // Don't trust the event body's status (a replayed or out-of-order event could
  // be stale): ask Razorpay for the subscription's current state.
  let sub: RzpSubscription
  try {
    sub = razorpayConfigured() ? await razorpay<RzpSubscription>(`/subscriptions/${encodeURIComponent(hinted.id)}`) : hinted
  } catch (e) {
    console.error('webhook fetch failed', String(e))
    return new Response('retry', { status: 500 })
  }

  const admin = adminClient()
  const { data: row } = await admin
    .from('subscriptions')
    .select('id, user_id, plan')
    .eq('provider', 'razorpay')
    .eq('provider_subscription_id', sub.id)
    .maybeSingle()

  // Subscriptions are created by our billing function with the user id in notes.
  const userId = row?.user_id ?? sub.notes?.user_id
  if (!userId) return new Response('unknown subscription', { status: 200 })

  const fields = {
    user_id: userId,
    provider: 'razorpay',
    provider_subscription_id: sub.id,
    // the plan chosen at checkout (stored on our row, and in the Razorpay notes)
    plan: row?.plan ?? sub.notes?.plan ?? 'pro',
    status: mapStatus(sub.status),
    started_at: toIso(sub.current_start ?? sub.start_at),
    expires_at: toIso(sub.current_end ?? sub.ended_at),
    ...(sub.status === 'cancelled' || event.event === 'subscription.cancelled' ? { cancel_at_period_end: true } : {}),
  }
  const { error } = await admin.from('subscriptions').upsert(fields, { onConflict: 'provider,provider_subscription_id' })
  if (error) {
    console.error('webhook upsert failed', error.message)
    return new Response('retry', { status: 500 })
  }
  return new Response('ok', { status: 200 })
})
