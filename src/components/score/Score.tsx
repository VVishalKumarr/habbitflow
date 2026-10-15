import { scoreColor, tierOf } from '../../lib/scores'
import { useCountUp } from './useReveal'

/** Big number + coloured bar, with an optional potential marker (Umax-style rating row). */
export function ScoreBar({ label, value, potential, run = true, hint }: { label: string; value: number; potential?: number; run?: boolean; hint?: string }) {
  const shown = useCountUp(value, run)
  const width = run ? value : 0
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-muted" title={hint}>
        {label}
      </p>
      <p className="mt-0.5 text-3xl font-bold tracking-tight tabular-nums">{shown}</p>
      <div className="relative mt-2 h-2 rounded-full bg-ink/10" role="img" aria-label={`${label}: ${value} out of 100${potential ? `, potential ${potential}` : ''}`}>
        {potential !== undefined && potential > value && (
          <div
            className="absolute inset-y-0 left-0 rounded-full opacity-25 transition-[width] duration-1000 ease-out"
            style={{ width: `${run ? potential : 0}%`, background: scoreColor(potential) }}
          />
        )}
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-1000 ease-out"
          style={{ width: `${width}%`, background: scoreColor(value), boxShadow: `0 0 12px ${scoreColor(value)}` }}
        />
      </div>
    </div>
  )
}

/** Ring gauge with a tier badge in the middle. */
export function ScoreRing({ label, value, run = true, size = 120, sub }: { label?: string; value: number; run?: boolean; size?: number; sub?: string }) {
  const shown = useCountUp(value, run)
  const stroke = Math.max(6, size / 12)
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const color = scoreColor(value)
  return (
    <div className="flex flex-col items-center">
      {label && <p className="mb-2 text-sm font-semibold">{label}</p>}
      <div className="relative" style={{ width: size, height: size }} role="img" aria-label={`${label ?? 'Score'}: ${value} out of 100, ${tierOf(value)}`}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-ink/10" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - (run ? value : 0) / 100)}
            style={{ transition: 'stroke-dashoffset 1s ease-out', filter: `drop-shadow(0 0 6px ${color})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="rounded-full px-1.5 py-px text-[10px] font-bold text-black" style={{ background: color }}>
            {tierOf(value)}
          </span>
          <span className="font-bold tracking-tight tabular-nums" style={{ fontSize: size / 4.2 }}>
            {shown}
          </span>
          {sub && <span className="text-[10px] text-muted">{sub}</span>}
        </div>
      </div>
    </div>
  )
}
