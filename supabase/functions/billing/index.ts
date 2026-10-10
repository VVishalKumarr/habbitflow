// Web subscriptions (Razorpay).
// POST { action: 'create', plan: 'plus' | 'pro', interval: 'monthly' | 'yearly' }  -> { subscription_id, key_id }
// POST { action: 'verify', razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
// POST { action: 'cancel' }  -> cancels at the end of the current period
// All signed in. Pro status is only ever set from data fetched from Razorpay
// after the signature is verified; nothing the browser claims is trusted.
import { adminClient, json, preflight, rateLimited, readJson, userFromRequest } from '../_shared/http.ts'
import { mapStatus, razorpay, razorpayConfigured, toIso, verifyCheckoutSignature, type RzpSubscription } from '../_shared/razorpay.ts'

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  if (!razorpayConfigured()) {
    return json(req, { error: 'Online payments aren’t set up yet.', code: 'payments_not_configured' }, 503)
  }

  const body = await readJson<Record<string, string>>(req)
  const admin = adminClient()

  if (body?.action === 'create') {
    if (await rateLimited(who.user.id, 'billing_create', 10, 3600)) return json(req, { error: 'Too many attempts.' }, 429)
    const interval = body.interval === 'yearly' ? 'yearly' : 'monthly'
    const planIdWanted = /^[a-z][a-z0-9_]{1,30}$/.test(body.plan ?? '') ? body.plan : 'pro'
    if (planIdWanted === 'free') return json(req, { error: 'Choose a paid plan.' }, 400)
    const { data: plan } = await admin.from('plans').select('id, razorpay_plan_monthly, razorpay_plan_yearly').eq('id', planIdWanted).maybeSingle()
    if (!plan) return json(req, { error: 'Unknown plan.' }, 400)
    const planId = interval === 'yearly' ? plan?.razorpay_plan_yearly : plan?.razorpay_plan_monthly
    if (!planId) return json(req, { error: 'This billing option isn’t available yet.', code: 'plan_not_configured' }, 503)

    const sub = await razorpay<RzpSubscription>('/subscriptions', {
      method: 'POST',
      body: {
        plan_id: planId,
        total_count: interval === 'yearly' ? 10 : 120, // renews until cancelled (Razorpay needs a cap)
        customer_notify: 1,
        notes: { user_id: who.user.id, plan: plan.id },
      },
    })
    await admin.from('subscriptions').upsert(
      { user_id: who.user.id, provider: 'razorpay', provider_subscription_id: sub.id, plan: plan.id, status: 'created' },
      { onConflict: 'provider,provider_subscription_id' },
    )
    return json(req, { subscription_id: sub.id, key_id: Deno.env.get('RAZORPAY_KEY_ID') })
  }

  if (body?.action === 'verify') {
    const { razorpay_payment_id: pay, razorpay_subscription_id: subId, razorpay_signature: sig } = body
    if (!pay || !subId || !sig || !(await verifyCheckoutSignature(pay, subId, sig))) {
      return json(req, { error: 'Payment could not be verified.' }, 400)
    }
    const { data: row } = await admin
      .from('subscriptions')
      .select('id')
      .eq('provider', 'razorpay')
      .eq('provider_subscription_id', subId)
      .eq('user_id', who.user.id)
      .maybeSingle()
    if (!row) return json(req, { error: 'Unknown subscription.' }, 404)
    // Ask Razorpay for the real state rather than trusting the callback.
    const sub = await razorpay<RzpSubscription>(`/subscriptions/${subId}`)
    await admin
      .from('subscriptions')
      .update({ status: mapStatus(sub.status), started_at: toIso(sub.current_start ?? sub.start_at), expires_at: toIso(sub.current_end) })
      .eq('id', row.id)

    // Plan change (e.g. Plus -> Pro): stop the old subscription renewing. It
    // stays active until the end of the period already paid for.
    if (mapStatus(sub.status) === 'active') {
      const { data: others } = await admin
        .from('subscriptions')
        .select('id, provider_subscription_id')
        .eq('user_id', who.user.id)
        .eq('provider', 'razorpay')
        .neq('id', row.id)
        .in('status', ['active', 'past_due'])
        .eq('cancel_at_period_end', false)
      for (const o of others ?? []) {
        await razorpay(`/subscriptions/${o.provider_subscription_id}/cancel`, { method: 'POST', body: { cancel_at_cycle_end: 1 } }).catch((e) =>
          console.error('old plan cancel failed', String(e)),
        )
        await admin.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', o.id)
      }
    }
    return json(req, { ok: true, status: mapStatus(sub.status) })
  }

  if (body?.action === 'cancel') {
    const { data: rows } = await admin
      .from('subscriptions')
      .select('id, provider_subscription_id')
      .eq('user_id', who.user.id)
      .eq('provider', 'razorpay')
      .in('status', ['active', 'past_due', 'created'])
    for (const r of rows ?? []) {
      await razorpay(`/subscriptions/${r.provider_subscription_id}/cancel`, { method: 'POST', body: { cancel_at_cycle_end: 1 } }).catch((e) =>
        console.error('cancel failed', String(e)),
      )
      await admin.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', r.id)
    }
    return json(req, { ok: true })
  }

  return json(req, { error: 'Unknown action.' }, 400)
})
