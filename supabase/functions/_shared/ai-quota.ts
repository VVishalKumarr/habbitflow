// One gate for every AI feature: reserve a unit before calling the model,
// settle it afterwards. Limits, counting and cost caps live in the database
// (ai_begin / ai_finish in 2026-10-15_ai_quotas_phase5.sql) — never here.
import { adminClient, json } from './http.ts'

export type AiFeature = 'chat' | 'voice_command' | 'timetable_generate' | 'timetable_evaluate' | 'study_plan' | 'reschedule'

export interface QuotaGranted {
  ok: true
  usage_id: string
  feature: AiFeature
  charged_to: 'personal' | 'institution'
  limit: number | null
  used: number
  remaining: number | null
  period: 'day' | 'week' | 'month'
  resets_at: string
  max_output_tokens: number
}

export interface QuotaRefused {
  ok: false
  code: 'quota_exceeded' | 'feature_disabled' | 'too_large' | 'rate_limited' | 'spend_cap' | 'pool_exhausted' | 'duplicate' | 'in_progress' | 'unknown_feature' | 'unauthenticated'
  error: string
  feature?: AiFeature
  limit?: number | null
  used?: number
  period?: string
  resets_at?: string
  plan?: string
  institution?: boolean
}

const STATUS: Record<QuotaRefused['code'], number> = {
  quota_exceeded: 429,
  rate_limited: 429,
  pool_exhausted: 429,
  spend_cap: 503,
  feature_disabled: 403,
  too_large: 413,
  duplicate: 409,
  in_progress: 409,
  unknown_feature: 400,
  unauthenticated: 401,
}

/** request_id from the client (so retries aren't charged twice), validated; otherwise a fresh one. */
export function requestId(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : crypto.randomUUID()
}

export async function beginAi(userId: string, feature: AiFeature, reqId: string, inputChars: number): Promise<QuotaGranted | QuotaRefused> {
  const { data, error } = await adminClient().rpc('ai_begin', { p_user: userId, p_feature: feature, p_request_id: reqId, p_input_chars: inputChars })
  if (error || !data) {
    console.error('ai_begin failed', error?.message)
    return { ok: false, code: 'spend_cap', error: 'AI features are unavailable right now. Please try again later.' }
  }
  return data as QuotaGranted | QuotaRefused
}

/** ok=false refunds the unit (our or the provider's failure). Token counts are the provider's measured usage. */
export async function finishAi(
  usageId: string,
  ok: boolean,
  measured: { tokensIn?: number; tokensOut?: number; audioSeconds?: number; model?: string; error?: string } = {},
): Promise<void> {
  const { error } = await adminClient().rpc('ai_finish', {
    p_usage: usageId,
    p_ok: ok,
    p_tokens_in: measured.tokensIn ?? null,
    p_tokens_out: measured.tokensOut ?? null,
    p_audio_seconds: measured.audioSeconds ?? null,
    p_model: measured.model ?? null,
    p_error: measured.error ?? null,
  })
  if (error) console.error('ai_finish failed', error.message)
}

/** Structured refusal: the app shows the message, the reset time and an upgrade/contact option. */
export function quotaResponse(req: Request, r: QuotaRefused): Response {
  return json(req, r, STATUS[r.code] ?? 429)
}

/** What the app shows after a successful request. */
export const quotaInfo = (q: QuotaGranted) => ({ feature: q.feature, limit: q.limit, used: q.used, remaining: q.remaining, period: q.period, resets_at: q.resets_at })
