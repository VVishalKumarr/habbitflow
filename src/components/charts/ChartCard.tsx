import type { ReactNode } from 'react'

export function ChartCard({ title, subtitle, action, children, className = '' }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Shared tooltip body so every chart's hover looks the same. */
export function TooltipBox({ title, lines }: { title: string; lines: { label: string; value: string; swatch?: string }[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-pop">
      <p className="mb-1 font-medium">{title}</p>
      {lines.map((l) => (
        <p key={l.label} className="flex items-center gap-2 text-muted">
          {l.swatch && <span className="size-2.5 rounded-full" style={{ background: l.swatch }} aria-hidden="true" />}
          <span>{l.label}</span>
          <span className="ml-auto pl-3 font-medium text-ink tabular-nums">{l.value}</span>
        </p>
      ))}
    </div>
  )
}

/** Screen-reader table mirroring a chart's data. */
export function SrTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: (string | number)[][] }) {
  return (
    // Wrapped: tables ignore sr-only's 1px width and would widen the page.
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const pct = (v: number) => `${Math.round(v * 100)}%`
