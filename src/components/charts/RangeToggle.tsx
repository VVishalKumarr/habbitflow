import { Lock } from 'lucide-react'
import { useFeatureAccess } from '../../store/subscription'

export const RANGES = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
]

/**
 * 7D / 30D / 90D switch. Ranges longer than the plan's history window need
 * `advanced_statistics`; picking one without it opens the upgrade dialog.
 */
export function RangeToggle({ value, onChange, size = 'sm' }: { value: number; onChange: (days: number) => void; size?: 'sm' | 'md' }) {
  const { hasFeature, requireFeature, limit } = useFeatureAccess()
  const history = limit('history_days')
  const locked = (days: number) => !hasFeature('advanced_statistics') && history != null && days > history

  return (
    <div className="flex rounded-xl bg-subtle p-1" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r.days}
          type="button"
          onClick={() => {
            if (locked(r.days) && !requireFeature('advanced_statistics', { clientOnly: true })) return
            onChange(r.days)
          }}
          aria-pressed={value === r.days}
          className={`flex items-center gap-1 rounded-lg font-semibold transition-colors ${size === 'md' ? 'h-9 flex-1 px-4 text-sm sm:flex-none' : 'h-8 px-3 text-xs'} ${
            value === r.days ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'
          }`}
        >
          {r.label}
          {locked(r.days) && (
            <>
              <Lock className="size-3" aria-hidden="true" />
              <span className="sr-only"> (paid plans)</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}
