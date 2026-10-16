import type { Feature, LimitKey } from '../config'

type PlanErrorHandler = (key: Feature | LimitKey, message: string) => void
let onPlanError: PlanErrorHandler | null = null

/** The upgrade dialog registers itself here (avoids a store import cycle). */
export function setPlanErrorHandler(fn: PlanErrorHandler) {
  onPlanError = fn
}

const LIMIT_TEXT: Record<string, string> = {
  trackers: 'You’ve reached the free tracker limit.',
  friends: 'You’ve reached the free friend limit.',
}

/**
 * Server-side plan errors look like "PLAN_LIMIT:trackers:2" or
 * "PRO_REQUIRED:csv_export". They open the upgrade dialog and return a
 * short message.
 */
export function planError(msg: string): { key: Feature | LimitKey; message: string } | null {
  const limit = /PLAN_LIMIT:(\w+)/.exec(msg)
  if (limit) return { key: limit[1] as LimitKey, message: LIMIT_TEXT[limit[1]] ?? 'You’ve reached a free plan limit.' }
  const pro = /PRO_REQUIRED:(\w+)/.exec(msg)
  if (pro) return { key: pro[1] as Feature, message: 'This feature needs a paid plan.' }
  return null
}

/** Turn Supabase / network errors into short, human messages. */
export function friendlyError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as { message?: string; code?: string } | null
  const msg = e?.message ?? ''
  if (!msg && !e?.code) return fallback
  const plan = planError(msg)
  if (plan) {
    onPlanError?.(plan.key, plan.message)
    return plan.message
  }
  const denied = /NOT_ALLOWED:(.+)/.exec(msg)
  if (denied) return denied[1]
  if (/STALE_TIMETABLE/.test(msg)) return 'Your timetable changed after this suggestion was made. Nothing was saved — please ask again.'
  const undo = /CANNOT_UNDO:(.+)/.exec(msg)
  if (undo) return undo[1]
  const invalid = /INVALID_CHANGE:(.+)/.exec(msg)
  if (invalid) return `This change couldn’t be saved (${invalid[1]}). Nothing was changed.`
  if (/captcha/i.test(msg)) return 'The security check failed. Please complete it again and retry.'
  if (/failed to fetch|network|load failed/i.test(msg)) return 'Network error — check your connection and try again.'
  if (e?.code === '23P01' || /overlaps/i.test(msg)) return 'That time slot overlaps an existing slot.'
  if (e?.code === '23505') return 'That already exists.'
  if (e?.code === '23514') return 'Some values are invalid.'
  if (/jwt|not authenticated|refresh token/i.test(msg)) return 'Your session expired. Please log in again.'
  return msg || fallback
}
