// Web subscriptions: Razorpay (India, ₹) and Stripe (everywhere else, $).
// POST { action: 'create', plan: 'plus' | 'pro', interval: 'monthly' | 'yearly' }  -> { subscription_id, key_id }   (Razorpay)
// POST { action: 'verify', razorpay_payment_id, razorpay_subscription_id, razorpay_signature }                    (Razorpay)
// POST { action: 'stripe_checkout', plan, interval }  -> { url }   Stripe Checkout page
// POST { action: 'stripe_portal' }                    -> { url }   Stripe customer portal (card, cancel, invoices)
// POST { action: 'cancel' }  -> cancels at the end of the current period (both providers)
// All signed in. Plans are only ever granted from data fetched from the
// provider after verification; nothing the browser claims is trusted.
import { adminClient, json, preflight, rateLimited, readJson, siteUrl, userFromRequest } from '../_shared/http.ts'
import { mapStatus, razorpay, razorpayConfigured, toIso, verifyCheckoutSignature, type RzpSubscription } from '../_shared/razorpay.ts'
import { stripe, stripeConfigured, type StripeSubscription } from '../_shared/stripe.ts'

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  const body = await readJson<Record<string, string>>(req)
  const admin = adminClient()
  const notConfigured = () => json(req, { error: 'Online payments aren’t set up yet.', code: 'payments_not_configured' }, 503)

  if (body?.action === 'stripe_checkout') {
    if (!stripeConfigured()) return notConfigured()
    if (await rateLimited(who.user.id, 'billing_create', 10, 3600)) return json(req, { error: 'Too many attempts.' }, 429)
    const interval = body.interval === 'yearly' ? 'yearly' : 'monthly'
    const planIdWanted = /^[a-z][a-z0-9_]{1,30}$/.test(body.plan ?? '') ? body.plan : 'pro'
    if (planIdWanted === 'free') return json(req, { error: 'Choose a paid plan.' }, 400)
    const { data: plan } = await admin.from('plans').select('id, stripe_price_monthly, stripe_price_yearly').eq('id', planIdWanted).maybeSingle()
    if (!plan) return json(req, { error: 'Unknown plan.' }, 400)
    const price = interval === 'yearly' ? plan.stripe_price_yearly : plan.stripe_price_monthly
    if (!price) return json(req, { error: 'This billing option isn’t available yet.', code: 'plan_not_configured' }, 503)
    const { data: acct } = await admin.from('account_private').select('recovery_email, email_verified_at').eq('user_id', who.user.id).maybeSingle()
    const email = acct?.email_verified_at ? acct.recovery_email : who.user.email?.endsWith('@habitflow.local') ? null : who.user.email
    const session = await stripe<{ url: string }>('/checkout/sessions', {
      method: 'POST',
      body: {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        success_url: `${siteUrl()}/pro?checkout=success`,
        cancel_url: `${siteUrl()}/pro?checkout=cancelled`,
        client_reference_id: who.user.id,
        customer_email: email ?? undefined,
        subscription_data: { metadata: { user_id: who.user.id, plan: plan.id } },
        metadata: { user_id: who.user.id, plan: plan.id },
      },
    })
    return json(req, { url: session.url })
  }

  if (body?.action === 'stripe_portal') {
    if (!stripeConfigured()) return notConfigured()
    const { data: row } = await admin
      .from('subscriptions')
      .select('provider_subscription_id')
      .eq('user_id', who.user.id)
      .eq('provider', 'stripe')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!row?.provider_subscription_id) return json(req, { error: 'No card subscription found.' }, 404)
    const sub = await stripe<StripeSubscription>(`/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`)
    const portal = await stripe<{ url: string }>('/billing_portal/sessions', { method: 'POST', body: { customer: sub.customer, return_url: `${siteUrl()}/settings` } })
    return json(req, { url: portal.url })
  }

  if (body?.action === 'cancel') {
    if (stripeConfigured()) {
      const { data: rows } = await admin
        .from('subscriptions')
        .select('id, provider_subscription_id')
        .eq('user_id', who.user.id)
        .eq('provider', 'stripe')
        .in('status', ['active', 'past_due', 'trialing'])
      for (const r of rows ?? []) {
        await stripe(`/subscriptions/${r.provider_subscription_id}`, { method: 'POST', body: { cancel_at_period_end: true } }).catch((e) =>
          console.error('stripe cancel failed', String(e)),
        )
        await admin.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', r.id)
      }
    }
    if (!razorpayConfigured()) return json(req, { ok: true })
  }

  if (!razorpayConfigured()) return notConfigured()

  if (body?.action === 'create') {
    if (await rateLimited(who.user.id, 'billing_create', 10, 3600)) return json(req, { error: 'Too many attempts.' }, 429)
    const interval = body.interval === 'yearly' ? 'yearly' : 'monthly'
    const planIdWanted = /^[a-z][a-z0-9_]{1,30}$/.test(body.plan ?? '') ? body.plan : 'pro'
    if (planIdWanted === 'free') return json(req, { error: 'Choose a paid plan.' }, 400)
    // 'default' (international) charges the US$ plans; 'IN', or an older app
    // that sends no region, the ₹ plans.
    const usd = body.region === 'default'
    const { data: plan } = await admin
      .from('plans')
      .select('id, razorpay_plan_monthly, razorpay_plan_yearly, razorpay_plan_monthly_usd, razorpay_plan_yearly_usd')
      .eq('id', planIdWanted)
      .maybeSingle()
    if (!plan) return json(req, { error: 'Unknown plan.' }, 400)
    const planId = usd
      ? interval === 'yearly' ? plan.razorpay_plan_yearly_usd : plan.razorpay_plan_monthly_usd
      : interval === 'yearly' ? plan.razorpay_plan_yearly : plan.razorpay_plan_monthly
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
