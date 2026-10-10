import { create } from 'zustand'
import { FEATURE_UPSELL, type Feature, type LimitKey } from '../config'
import type { RegionPrice } from '../config/pricing'
import { friendlyError, setPlanErrorHandler } from '../lib/errors'
import { supabase } from '../lib/supabase'

/** FREE: never paid · TRIAL · ACTIVE: on a paid plan · EXPIRED: had a paid plan, now free */
export type PlanState = 'FREE' | 'TRIAL' | 'ACTIVE' | 'EXPIRED'

/** 'free' | 'plus' | 'pro' (more can be added in the database) */
export type PlanId = string

/** What the server says this user may do (see my_entitlements() in the database). */
export interface Entitlements {
  plan: PlanId
  plan_name: string
  /** 0 = free; higher = more features */
  rank: number
  state: PlanState
  /** where the current plan comes from: a personal subscription (paid, trial, gift code) or an institution licence */
  source: 'subscription' | 'institution' | null
  institution_name: string | null
  /** institution licence has expired and is in its grace period */
  grace: boolean
  provider: string | null
  status: string | null
  expires_at: string | null
  cancel_at_period_end: boolean
  limits: Partial<Record<LimitKey, number | null>>
  features: Feature[]
  trial_available: boolean
}

export interface Plan {
  id: PlanId
  name: string
  rank: number
  /** per region ('IN', 'default'…), smallest currency unit */
  prices: Partial<Record<string, RegionPrice>>
  trial_days: number
  limits: Partial<Record<LimitKey, number | null>>
  features: Feature[]
  razorpay_plan_monthly: string | null
  razorpay_plan_yearly: string | null
  google_play_product_id: string | null
}

/** Used until the server answers, and if it can't be reached: most restrictive. */
const FREE_FALLBACK: Entitlements = {
  plan: 'free',
  plan_name: 'Free',
  rank: 0,
  state: 'FREE',
  source: null,
  institution_name: null,
  grace: false,
  provider: null,
  status: null,
  expires_at: null,
  cancel_at_period_end: false,
  limits: {},
  features: ['basic_statistics'],
  trial_available: false,
}

interface SubscriptionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  ent: Entitlements
  plans: Plan[]
  plansStatus: 'idle' | 'loading' | 'ready' | 'error'
  load: () => Promise<void>
  loadPlans: () => Promise<void>
  startTrial: () => Promise<void>
  /** Redeems a gift or licence code; returns the plan name and end date. */
  redeem: (code: string) => Promise<{ plan_name: string; expires_at: string }>
  reset: () => void
}

export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
  status: 'idle',
  ent: FREE_FALLBACK,
  plans: [],
  plansStatus: 'idle',

  load: async () => {
    set({ status: 'loading' })
    const { data, error } = await supabase.rpc('my_entitlements')
    if (error) set({ status: 'error', ent: FREE_FALLBACK })
    else set({ status: 'ready', ent: { ...FREE_FALLBACK, ...(data as Entitlements) } })
  },

  loadPlans: async () => {
    if (get().plansStatus === 'ready' || get().plansStatus === 'loading') return
    set({ plansStatus: 'loading' })
    const { data, error } = await supabase
      .from('plans')
      .select('id, name, rank, prices, trial_days, limits, features, razorpay_plan_monthly, razorpay_plan_yearly, google_play_product_id')
    if (error) set({ plansStatus: 'error' })
    else set({ plansStatus: 'ready', plans: (data as Plan[]).sort((a, b) => a.rank - b.rank) })
  },

  startTrial: async () => {
    const { data, error } = await supabase.rpc('start_trial')
    if (error) throw new Error(friendlyError(error))
    set({ ent: { ...FREE_FALLBACK, ...(data as Entitlements) } })
  },

  redeem: async (code) => {
    const { data, error } = await supabase.rpc('redeem_code', { p_code: code })
    if (error) throw new Error(friendlyError(error))
    const { redeemed, ...ent } = data as Entitlements & { redeemed: { plan_name: string; expires_at: string } }
    set({ status: 'ready', ent: { ...FREE_FALLBACK, ...ent } })
    return redeemed
  },

  reset: () => set({ status: 'idle', ent: FREE_FALLBACK }),
}))

export function useSubscription(): Entitlements & { loading: boolean; isPaid: boolean } {
  const ent = useSubscriptionStore((s) => s.ent)
  const status = useSubscriptionStore((s) => s.status)
  return { ...ent, loading: status === 'idle' || status === 'loading', isPaid: ent.plan !== 'free' }
}

const RECURRING = ['razorpay', 'google_play', 'stripe', 'lemonsqueezy']

/** Paid subscriptions renew; trials, gift codes, manual grants and institution licences just end. */
export const renewsAutomatically = (e: Entitlements) => RECURRING.includes(e.provider ?? '') && !e.cancel_at_period_end && e.state !== 'TRIAL'

/* ------------------------------------------------------------------ */
/* Upgrade dialog                                                      */
/* ------------------------------------------------------------------ */

interface UpgradeState {
  open: boolean
  message: string
  /** the feature or limit that triggered the dialog */
  key: Feature | LimitKey | null
  show: (key?: Feature | LimitKey, message?: string) => void
  close: () => void
}

export const useUpgrade = create<UpgradeState>((set) => ({
  open: false,
  message: '',
  key: null,
  show: (key, message) =>
    set({ open: true, key: key ?? null, message: message ?? (key && FEATURE_UPSELL[key]) ?? 'This feature is available on a paid plan.' }),
  close: () => set({ open: false }),
}))

/* ------------------------------------------------------------------ */
/* Feature checks (one place for every Pro check in the UI)            */
/* ------------------------------------------------------------------ */

export function hasFeature(feature: Feature): boolean {
  return useSubscriptionStore.getState().ent.features.includes(feature)
}

export function useFeatureAccess() {
  const features = useSubscriptionStore((s) => s.ent.features)
  const limits = useSubscriptionStore((s) => s.ent.limits)
  return {
    hasFeature: (f: Feature) => features.includes(f),
    /** null = unlimited, undefined = unknown yet */
    limit: (k: LimitKey) => limits[k],
    /**
     * Returns true when allowed; otherwise opens the upgrade dialog and returns false.
     * While the plan is still loading, server-enforced features are allowed (the
     * database refuses them if needed, so Pro members never see a false prompt).
     * Features checked only in the browser pass `{ clientOnly: true }` and are
     * refused silently until the plan is known.
     */
    requireFeature: (f: Feature, opts: { message?: string; clientOnly?: boolean } = {}) => {
      if (features.includes(f)) return true
      const status = useSubscriptionStore.getState().status
      if (status === 'idle' || status === 'loading') return !opts.clientOnly
      const message = opts.message
      useUpgrade.getState().show(f, message)
      return false
    },
  }
}

// Server-side plan errors (from any request) open the upgrade dialog.
setPlanErrorHandler((key) => useUpgrade.getState().show(key))
