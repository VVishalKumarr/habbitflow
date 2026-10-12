import { CheckCircle2, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PlanCards, RegionSwitch, useIntervalToggle } from '../components/pricing/PlanCards'
import { ConfirmModal } from '../components/ui/ConfirmModal'
import { Spinner } from '../components/ui/Spinner'
import { analytics } from '../lib/analytics'
import { formatDate } from '../lib/dates'
import { getPaymentService } from '../lib/payments'
import { useRegion } from '../lib/region'
import { useAuth } from '../store/auth'
import { renewsAutomatically, useSubscription, useSubscriptionStore, type Plan } from '../store/subscription'
import { toast } from '../store/ui'

const FAQ = [
  ['Do I lose anything if I stay on Free?', 'No. Free is free forever. Limits only apply to adding new things — your existing trackers and history are never deleted.'],
  ['What’s the difference between Plus and Pro?', 'Plus removes ads and limits: unlimited trackers, full history, themes and more friends. Pro adds reports (PDF/CSV), focus sounds and leaderboards on top.'],
  ['What happens if my plan ends?', 'You keep all your data. Paid features switch off and the free limits apply to new items again.'],
  ['Can I switch or cancel any time?', 'Yes. Upgrading starts the new plan straight away; cancelling stops the next renewal and your plan stays active until the end of the period you paid for.'],
  ['Why are prices different in my country?', 'We price fairly for each region, so HabbitFlows is affordable wherever you are.'],
  ['How is payment handled?', 'By our payment provider. We never see or store your card or UPI details. In the Android app, plans are bought through Google Play.'],
]

export default function ProPage() {
  const signedIn = useAuth((s) => s.status === 'authenticated')
  const username = useAuth((s) => s.profile?.username ?? '')
  const sub = useSubscription()
  const load = useSubscriptionStore((s) => s.load)
  const startTrial = useSubscriptionStore((s) => s.startTrial)
  const plans = useSubscriptionStore((s) => s.plans)
  const region = useRegion((s) => s.region)
  const [interval, toggle] = useIntervalToggle()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const payments = getPaymentService(region)
  const trialPlan = [...plans].reverse().find((p) => p.trial_days > 0)

  useEffect(() => {
    if (signedIn) load()
  }, [signedIn, load])

  const upgrade = async (plan: Plan) => {
    analytics.track('upgrade_clicked', { source: 'pro_page', interval, plan: plan.id })
    setBusy(plan.id)
    try {
      const res = await payments.checkout(plan.id, interval, { username })
      if (res.status === 'cancelled') return
      await load()
      analytics.track('subscription_started', { interval, provider: payments.id, plan: plan.id })
      toast.success(
        res.status === 'completed'
          ? `Welcome to ${plan.name}! Your features are unlocked.`
          : `Payment received — ${plan.name} will switch on as soon as it’s confirmed.`,
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const trial = async () => {
    setBusy('trial')
    try {
      await startTrial()
      analytics.track('trial_started')
      toast.success(`Your ${trialPlan?.name ?? 'Pro'} trial has started.`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const cancel = async () => {
    try {
      await payments.cancel?.()
      await load()
      toast.success(`Your subscription won’t renew. ${sub.plan_name} stays active until the end of this period.`)
      setConfirmCancel(false)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const renderAction = (plan: Plan) => {
    const free = plan.rank === 0
    if (!signedIn) {
      return free ? (
        <Link to="/register" className="btn-secondary h-11">
          Create Free Account
        </Link>
      ) : (
        <Link
          to="/register"
          className={plan.id === 'pro' ? 'btn-primary h-11' : 'btn-secondary h-11'}
          onClick={() => analytics.track('upgrade_clicked', { source: 'pro_page_signed_out', plan: plan.id })}
        >
          Get {plan.name}
        </Link>
      )
    }

    // The user's current plan
    if (plan.id === sub.plan) {
      if (free) return <p className="rounded-xl bg-subtle px-4 py-3 text-center text-sm font-medium">Your current plan</p>
      return (
        <>
          <p className="flex flex-wrap items-center justify-center gap-x-2 rounded-xl bg-success-soft px-4 py-3 text-center text-sm font-medium">
            <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
            {sub.state === 'TRIAL' ? `You’re on a ${plan.name} trial` : `You’re on ${plan.name}`}
            {sub.expires_at &&
              ` · ${renewsAutomatically(sub) ? 'renews' : 'ends'} ${formatDate(sub.expires_at.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })}`}
          </p>
          {sub.provider === 'razorpay' && !sub.cancel_at_period_end && payments.cancel && (
            <button type="button" className="btn-ghost" onClick={() => setConfirmCancel(true)}>
              Cancel subscription
            </button>
          )}
          {sub.provider === 'google_play' && <p className="text-center text-sm text-muted">Manage this subscription in Google Play → Payments & subscriptions.</p>}
        </>
      )
    }

    // Plans below the current one
    if (plan.rank < sub.rank) return free ? null : <p className="rounded-xl bg-subtle px-4 py-3 text-center text-sm text-muted">Included in your plan</p>

    // Upgrades
    return (
      <>
        {!payments.unavailableReason && (
          <button
            type="button"
            className={plan.id === 'pro' ? 'btn-primary h-11' : 'btn-secondary h-11'}
            onClick={() => upgrade(plan)}
            disabled={busy !== null}
          >
            {busy === plan.id && <Spinner className="size-4" />}
            {sub.isPaid ? `Switch to ${plan.name}` : `Upgrade to ${plan.name}`}
          </button>
        )}
        {sub.trial_available && trialPlan?.id === plan.id && (
          <button type="button" className={payments.unavailableReason ? 'btn-primary h-11' : 'btn-secondary h-11'} onClick={trial} disabled={busy !== null}>
            {busy === 'trial' && <Spinner className="size-4" />}
            Start {plan.trial_days}-day free trial
          </button>
        )}
      </>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="text-center">
        <p className="text-sm font-semibold text-brand">Pricing</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Choose your plan</h1>
        <p className="mx-auto mt-3 max-w-xl text-muted">Everything you need to build habits is free. Plus removes ads and limits; Pro adds reports, focus sounds and leaderboards.</p>
        <div className="mt-6">{toggle}</div>
      </div>

      <div className="mt-10">
        <PlanCards interval={interval} renderAction={renderAction} />
      </div>

      <div className="mt-6 flex flex-col items-center gap-3">
        {signedIn && payments.unavailableReason && (
          <p className="flex max-w-xl items-start gap-2 rounded-xl bg-subtle px-4 py-3 text-sm text-muted">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {payments.unavailableReason}
          </p>
        )}
        {signedIn && sub.state === 'EXPIRED' && <p className="text-sm text-muted">Your paid plan has ended. All your data is still here.</p>}
        <RegionSwitch />
      </div>

      <section className="mx-auto mt-16 max-w-3xl" aria-labelledby="pro-faq">
        <h2 id="pro-faq" className="text-xl font-semibold">
          Questions
        </h2>
        <dl className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
          {FAQ.map(([q, a]) => (
            <div key={q} className="p-5">
              <dt className="font-medium">{q}</dt>
              <dd className="mt-1 text-muted">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ConfirmModal
        open={confirmCancel}
        title={`Cancel ${sub.plan_name}?`}
        message={`Your subscription won’t renew. You keep ${sub.plan_name} until the end of the current period, and all your data stays.`}
        confirmLabel="Cancel subscription"
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
      />
    </div>
  )
}
