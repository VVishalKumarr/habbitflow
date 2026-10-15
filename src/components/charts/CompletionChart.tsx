import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDate } from '../../lib/dates'
import { SrTable, TooltipBox, pct } from './ChartCard'

export interface TrendPoint {
  date: string
  rate: number | null
  completed: number
  scheduled: number
}

/** Completion-rate trend over time (days without scheduled tasks leave a gap). */
export function CompletionChart({ data, caption }: { data: TrendPoint[]; caption: string }) {
  const tickEvery = Math.max(1, Math.ceil(data.length / 6))

  return (
    <>
      <div className="h-64 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              interval={tickEvery - 1}
              minTickGap={8}
              tickFormatter={(d: string) => formatDate(d, { month: 'short', day: 'numeric' })}
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={pct}
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 12 }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload as TrendPoint
                return (
                  <TooltipBox
                    title={formatDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}
                    lines={[
                      { label: 'Rate', value: d.rate === null ? '—' : pct(d.rate) },
                      { label: 'Completed', value: `${d.completed} of ${d.scheduled}` },
                    ]}
                  />
                )
              }}
            />
            <Area
              type="monotone"
              dataKey="rate"
              stroke="var(--brand)"
              strokeWidth={2}
              fill="var(--brand)"
              fillOpacity={0.1}
              connectNulls
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)', fill: 'var(--brand)' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <SrTable
        caption={caption}
        headers={['Date', 'Completed', 'Scheduled', 'Rate']}
        rows={data.map((d) => [d.date, d.completed, d.scheduled, d.rate === null ? '—' : pct(d.rate)])}
      />
    </>
  )
}
