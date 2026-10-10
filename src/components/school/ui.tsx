import { AlertCircle, type LucideIcon } from 'lucide-react'
import { useId, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Spinner } from '../ui/Spinner'

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2 whitespace-nowrap">{actions}</div>}
    </div>
  )
}

export function Panel({ title, description, actions, children, className = '' }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card min-w-0 p-4 sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ icon: Icon, label, value, hint, tone = 'brand' }: { icon: LucideIcon; label: string; value: ReactNode; hint?: ReactNode; tone?: 'brand' | 'danger' | 'success' | 'muted' }) {
  const toneClass = { brand: 'bg-brand-soft text-brand', danger: 'bg-danger-soft text-danger', success: 'bg-success-soft text-success', muted: 'bg-subtle text-muted' }[tone]
  return (
    <div className="card flex items-start gap-3 p-4">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${toneClass}`}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
    </div>
  )
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'brand' | 'danger' | 'success' | 'warning' }) {
  const toneClass = {
    muted: 'bg-subtle text-muted',
    brand: 'bg-brand-soft text-brand-ink',
    danger: 'bg-danger-soft text-danger',
    success: 'bg-success-soft text-success',
    warning: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${toneClass}`}>{children}</span>
}

export function SelectField({ label, children, hint, error, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; error?: string | null }) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select id={id} className="input pr-8" aria-invalid={error ? true : undefined} {...rest}>
        {children}
      </select>
      {error ? <p className="field-error">{error}</p> : hint ? <p className="mt-1.5 text-sm text-muted">{hint}</p> : null}
    </div>
  )
}

export function TextArea({ label, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <textarea id={id} className="input h-auto min-h-24 py-2.5" {...rest} />
      {hint && <p className="mt-1.5 text-sm text-muted">{hint}</p>}
    </div>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

export function Loading() {
  return (
    <div className="flex justify-center py-12 text-muted">
      <Spinner />
    </div>
  )
}

/** A responsive list row: stacks on phones, one line on wider screens. */
export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <li className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4 ${className}`}>{children}</li>
}

export function List({ children, empty }: { children: ReactNode; empty?: ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children
  if (Array.isArray(items) && items.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty ?? 'Nothing here yet.'}</p>
  return <ul className="divide-y divide-line">{items}</ul>
}
