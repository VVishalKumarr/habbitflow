// Shared wording for AI quota refusals and the usage view (limits are enforced on the server).
import type { FunctionError } from './functions'

export const QUOTA_CODES = new Set(['quota_exceeded', 'feature_disabled', 'pool_exhausted', 'spend_cap', 'rate_limited', 'too_large'])

export interface AiUsageRow {
  feature: string
  label: string
  period: 'day' | 'week' | 'month'
  enabled: boolean
  /** null = unlimited */
  limit: number | null
  used: number
  remaining: number | null
  resets_at: string
  plan_key: string
  institution_name: string | null
  upgrade_available: boolean
}

/** "in 3 h 20 min", "in 2 days", "on 1 Nov" */
export function resetsIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now
  if (ms <= 60_000) return 'in a minute'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  const d = Math.round(h / 24)
  if (d <= 6) return `in ${d} day${d === 1 ? '' : 's'}`
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

/** Plain-text explanation of a refusal: what happened, when it resets, what to do. */
export function quotaMessage(err: FunctionError): string {
  const d = (err.details ?? {}) as { resets_at?: string; institution?: boolean }
  const parts = [err.message]
  if (d.resets_at && err.code !== 'feature_disabled' && err.code !== 'too_large') parts.push(`It resets ${resetsIn(d.resets_at)}.`)
  if (err.code === 'quota_exceeded' || err.code === 'feature_disabled') {
    parts.push(d.institution ? 'Your school sets these limits — ask your school administrator if you need more.' : 'Higher limits come with Plus and Pro (Settings → Plan).')
  }
  return parts.join(' ')
}
