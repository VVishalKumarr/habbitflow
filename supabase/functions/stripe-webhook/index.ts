// Stripe webhook (Stripe Dashboard -> Developers -> Webhooks -> endpoint
// .../functions/v1/stripe-webhook with the checkout.session.completed and
// customer.subscription.* events; its signing secret is STRIPE_WEBHOOK_SECRET).
// Rejects anything without a valid signature, and never trusts the event body:
// the subscription is fetched from Stripe before anything is saved.
import { adminClient, env } from '../_shared/http.ts'
import { mapStripeStatus, periodOf, stripe, stripeConfigured, type StripeSubscription } from '../_shared/stripe.ts'
import { verifyStripeSignature } from '../_shared/stripe-signature.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const raw = await req.text()
  if (!stripeConfigured() || !(await verifyStripeSignature(raw, req.headers.get('stripe-signature') ?? '', env('STRIPE_WEBHOOK_SECRET')))) {
    return new Response('Invalid signature', { status: 401 })
  }
  let event: { type?: string; data?: { object?: { id?: string; object?: string; subscription?: string | null; client_reference_id?: string | null } } }
  try {
    event = JSON.parse(raw)
  } catch {
    return new Response('Bad payload', { status: 400 })
  }
  const obj = event.data?.object
  const subId = obj?.object === 'subscription' ? obj.id : obj?.subscription
  if (!subId || !(event.type === 'checkout.session.completed' || event.type?.startsWith('customer.subscription.') || event.type?.startsWith('invoice.'))) {
    return new Response('ignored', { status: 200 })
  }

  let sub: StripeSubscription
  try {
    sub = await stripe<StripeSubscription>(`/subscriptions/${encodeURIComponent(subId)}`)
  } catch (e) {
    console.error('stripe fetch failed', String(e))
    return new Response('retry', { status: 500 })
  }

  const admin = adminClient()
  const { data: row } = await admin.from('subscriptions').select('id, user_id, plan').eq('provider', 'stripe').eq('provider_subscription_id', sub.id).maybeSingle()
  // Our checkout puts the user and plan in the subscription metadata.
  const userId = row?.user_id ?? sub.metadata?.user_id ?? (event.type === 'checkout.session.completed' ? obj?.client_reference_id : null)
  if (!userId) return new Response('unknown subscription', { status: 200 })

  const period = periodOf(sub)
  const status = mapStripeStatus(sub.status)
  const { error } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      provider: 'stripe',
      provider_subscription_id: sub.id,
      plan: row?.plan ?? sub.metadata?.plan ?? 'pro',
      status,
      started_at: period.start,
      expires_at: period.end,
      cancel_at_period_end: sub.cancel_at_period_end || status === 'cancelled',
    },
    { onConflict: 'provider,provider_subscription_id' },
  )
  if (error) {
    console.error('stripe upsert failed', error.message)
    return new Response('retry', { status: 500 })
  }

  // Plan change (e.g. Plus -> Pro): the older subscription stops renewing and
  // stays active until the end of the period already paid for.
  if (status === 'active') {
    const { data: others } = await admin
      .from('subscriptions')
      .select('id, provider_subscription_id')
      .eq('user_id', userId)
      .eq('provider', 'stripe')
      .neq('provider_subscription_id', sub.id)
      .in('status', ['active', 'past_due'])
      .eq('cancel_at_period_end', false)
    for (const o of others ?? []) {
      await stripe(`/subscriptions/${o.provider_subscription_id}`, { method: 'POST', body: { cancel_at_period_end: true } }).catch((e) =>
        console.error('old plan cancel failed', String(e)),
      )
      await admin.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', o.id)
    }
  }
  return new Response('ok', { status: 200 })
})
