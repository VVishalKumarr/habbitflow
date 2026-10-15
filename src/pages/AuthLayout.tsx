import { CalendarCheck2, ChartNoAxesColumn, Layers } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Logo } from '../components/layout/Logo'

const POINTS = [
  { icon: Layers, text: 'Separate trackers for home, exams, the gym or vacation.' },
  { icon: CalendarCheck2, text: 'A weekly timetable you tick off, day by day.' },
  { icon: ChartNoAxesColumn, text: 'Streaks and charts that show how consistent you are.' },
]

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh pt-safe pb-safe">
      <aside className="relative hidden w-[44%] max-w-xl flex-col justify-between overflow-hidden bg-brand p-12 text-white lg:flex dark:border-r dark:border-line dark:bg-surface dark:text-ink">
        <Link to="/" aria-label="HabbitFlows home" className="w-fit rounded-lg">
          <Logo inverted />
        </Link>
        <div>
          <h2 className="text-3xl leading-tight font-semibold tracking-tight">Build routines that actually stick.</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-white/90 dark:text-muted">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/15 dark:bg-brand-soft dark:text-brand-ink">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="pt-1.5">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-white/70 dark:text-muted">Small daily wins, tracked week after week.</p>
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-80 rounded-full bg-white/10 dark:hidden" aria-hidden="true" />
      </aside>

      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Link to="/" aria-label="HabbitFlows home" className="inline-block rounded-lg">
              <Logo />
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <p className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted">
            <Link to="/privacy" className="hover:text-ink hover:underline">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-ink hover:underline">
              Terms
            </Link>
            <Link to="/help" className="hover:text-ink hover:underline">
              Help
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
