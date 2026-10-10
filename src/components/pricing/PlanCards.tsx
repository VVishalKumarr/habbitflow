import { Check, Globe } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { FEATURE_LABELS, UNRELEASED_FEATURES, type Feature } from '../../config'
import { formatPrice, priceFor } from '../../config/pricing'
import { REGION_LABEL, useRegion, type Region } from '../../lib/region'
import { useSubscriptionStore, type Plan } from '../../store/subscription'
import { Skeleton } from '../ui/Spinner'

export type Interval = 'monthly' | 'yearly'

/** Features that are already described by a limit line. */
const COVERED_BY_LIMITS = new Set<Feature>(['basic_statistics', 'unlimited_trackers', 'full_history', 'advanced_statistics'])

function limitLines(plan: Plan): string[] {
  const t = plan.limits.trackers
  const h = plan.limits.history_days
  const f = plan.limits.friends
  return [
    t == null ? 'Unlimited trackers' : `${t} tracker${t === 1 ? '' : 's'}`,
    h == null ? 'Full history and 90-day charts' : `${h}-day charts`,
    f == null ? 'Unlimited friends' : `Up to ${f} friends`,
  ]
}

/** Bullets for a plan: the free plan lists its basics; paid plans list what they add over the plan below. */
export function planBullets(plan: Plan, below?: Plan): { intro?: string; items: string[] } {
  const own = limitLines(plan)
  if (!below) {
    return {
      items: [
        'Weekly timetable, tasks and streaks',
        'Pomodoro focus timer',
        ...own,
        ...(plan.features.includes('no_ads') ? [] : ['Includes ads']),
      ],
    }
  }
  const prev = limitLines(below)
  const items = own.filter((l, i) => l !== prev[i])
  for (const f of plan.features) {
    // Unknown keys (added in the database before the app knows them) and unreleased features are not advertised.
    const label = FEATURE_LABELS[f as Feature]
    if (label && !below.features.includes(f) && !COVERED_BY_LIMITS.has(f) && !UNRELEASED_FEATURES.has(f as Feature)) items.push(label)
  }
  return { intro: `Everything in ${below.name}, plus:`, items }
}

export function useIntervalToggle(): [Interval, ReactNode] {
  const [interval, setInterval] = useState<Interval>('yearly')
  const toggle = (
    <div className="inline-flex rounded-xl bg-subtle p-1" role="radiogroup" aria-label="Billing period">
      {(['monthly', 'yearly'] as const).map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={interval === i}
          onClick={() => setInterval(i)}
          className={`h-9 rounded-lg px-4 text-sm font-medium transition-colors ${interval === i ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'}`}
        >
          {i === 'monthly' ? 'Monthly' : 'Yearly · save more'}
        </button>
      ))}
    </div>
  )
  return [interval, toggle]
}

/** "Prices for India (₹) · Show International ($)" */
export function RegionSwitch() {
  const region = useRegion((s) => s.region)
  const setRegion = useRegion((s) => s.setRegion)
  const other: Region = region === 'IN' ? 'default' : 'IN'
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-2 text-sm text-muted">
      <Globe className="size-4" aria-hidden="true" />
      Prices for {REGION_LABEL[region]}
      <span aria-hidden="true">·</span>
      <button type="button" className="font-medium text-brand hover:underline" onClick={() => setRegion(other)}>
        Show {REGION_LABEL[other]}
      </button>
    </p>
  )
}

export function PlanCards({
  interval,
  renderAction,
  highlight = 'pro',
}: {
  interval: Interval
  /** buttons/notes at the bottom of each card */
  renderAction: (plan: Plan) => ReactNode
  highlight?: string
}) {
  const plans = useSubscriptionStore((s) => s.plans)
  const status = useSubscriptionStore((s) => s.plansStatus)
  const loadPlans = useSubscriptionStore((s) => s.loadPlans)
  const region = useRegion((s) => s.region)
  useEffect(() => {
    loadPlans()
  }, [loadPlans])

  if (status === 'error') return <p className="text-center text-muted">Pricing couldn’t be loaded. Please try again later.</p>
  if (!plans.length) {
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  return (
    <div className={`grid gap-5 ${plans.length >= 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2'}`}>
      {plans.map((plan, i) => {
        const price = priceFor(plan.prices, region)
        const free = plan.rank === 0
        const featured = plan.id === highlight
        const bullets = planBullets(plan, plans[i - 1])
        // rupees show as whole amounts (₹33), dollars keep cents ($1.25)
        const perMonthOfYear = price ? (price.currency === 'INR' ? Math.round(price.yearly / 1200) * 100 : Math.round(price.yearly / 12)) : 0
        const saving = price && price.monthly > 0 ? Math.round((1 - price.yearly / (price.monthly * 12)) * 100) : 0
        return (
          <section
            key={plan.id}
            aria-labelledby={`plan-${plan.id}`}
            className={`card relative flex flex-col p-6 sm:p-7 ${featured ? 'border-2 border-brand' : ''}`}
          >
            {featured && <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-0.5 text-xs font-semibold text-white">Most popular</span>}
            <h2 id={`plan-${plan.id}`} className={`text-lg font-semibold ${featured ? 'text-brand' : ''}`}>
              {plan.name}
            </h2>
            {price && (
              <>
                <p className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-4xl font-semibold tracking-tight">
                    {formatPrice(free ? 0 : interval === 'yearly' ? price.yearly : price.monthly, price.currency)}
                  </span>
                  {!free && <span className="text-muted">/{interval === 'yearly' ? 'year' : 'month'}</span>}
                </p>
                <p className="mt-1 min-h-10 text-sm text-muted">
                  {free
                    ? 'Free forever'
                    : interval === 'yearly'
                      ? `${formatPrice(perMonthOfYear, price.currency)}/month billed yearly${saving > 0 ? ` · save ${saving}%` : ''}`
                      : `or ${formatPrice(price.yearly, price.currency)}/year`}
                  {plan.trial_days > 0 && ` · ${plan.trial_days}‑day free trial`}
                </p>
              </>
            )}
            <div className="mt-5 flex-1">
              {bullets.intro && <p className="mb-2.5 text-sm font-medium text-muted">{bullets.intro}</p>}
              <ul className="space-y-2.5">
                {bullets.items.map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-[15px]">
                    <Check className={`mt-0.5 size-4 shrink-0 ${free ? 'text-success' : 'text-brand'}`} aria-hidden="true" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-7 flex flex-col gap-2 [&>*]:w-full">{renderAction(plan)}</div>
          </section>
        )
      })}
    </div>
  )
}
