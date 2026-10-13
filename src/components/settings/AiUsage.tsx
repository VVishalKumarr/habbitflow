import { Link } from 'react-router-dom'
import { resetsIn, type AiUsageRow } from '../../lib/aiQuota'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useAuth } from '../../store/auth'

const PER = { day: 'today', week: 'this week', month: 'this month' } as const

/** Each AI feature: allowance, use so far, what's left and when it resets. Read-only; the server enforces it. */
export function AiUsage() {
  const userId = useAuth((s) => s.session?.user.id)
  const { data, error, loading } = useLoad(async () => unwrap(await supabase.rpc('my_ai_usage')) as AiUsageRow[], [userId])

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>
  if (error || !data) return <p className="text-sm text-muted">AI usage isn’t available right now.</p>
  const school = data.find((r) => r.institution_name)?.institution_name
  const canUpgrade = data.some((r) => r.upgrade_available)

  return (
    <div className="space-y-4">
      <ul className="space-y-4">
        {data.map((r) => {
          const pct = r.limit ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0
          const out = r.enabled && r.limit !== null && r.remaining === 0
          return (
            <li key={r.feature}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="text-[15px] font-medium">{r.label}</p>
                <p className={`text-sm ${out ? 'font-medium text-danger' : 'text-muted'}`}>
                  {!r.enabled
                    ? 'Not included in your plan'
                    : r.limit === null
                      ? `Unlimited · ${r.used} used ${PER[r.period]}`
                      : `${r.used} of ${r.limit} used ${PER[r.period]}`}
                </p>
              </div>
              {r.enabled && r.limit !== null && (
                <>
                  <div
                    className="mt-1.5 h-2 overflow-hidden rounded-full bg-subtle"
                    role="progressbar"
                    aria-label={`${r.label} used`}
                    aria-valuemin={0}
                    aria-valuemax={r.limit}
                    aria-valuenow={r.used}
                  >
                    <div className={`h-full rounded-full ${out ? 'bg-danger' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {out ? 'Limit reached. ' : `${r.remaining} left. `}Resets {resetsIn(r.resets_at)}.
                  </p>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-sm text-muted">
        {school ? `Your limits combine your own plan with ${school}’s. Your school can change its part. ` : ''}
        Only counts are kept — never what you asked.{' '}
        {canUpgrade && (
          <Link to="/pro" className="font-medium text-brand hover:underline">
            Higher limits with Plus or Pro
          </Link>
        )}
      </p>
    </div>
  )
}
