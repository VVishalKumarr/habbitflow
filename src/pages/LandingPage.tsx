import { CalendarClock, ChartNoAxesColumn, CheckCircle2, Heart, Layers, ShieldCheck, Smartphone, Timer, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PlanCards, RegionSwitch, useIntervalToggle } from '../components/pricing/PlanCards'
import { appConfig } from '../config'
import { useAuth } from '../store/auth'

const base = import.meta.env.BASE_URL

const FEATURES = [
  { icon: CalendarClock, title: 'Weekly timetable', text: 'Create your own time slots and drop tasks into them. Your routine repeats every week.' },
  { icon: CheckCircle2, title: 'Daily check-offs', text: 'Tick tasks off each day. Completion is saved per date, so every week starts fresh.' },
  { icon: ChartNoAxesColumn, title: 'Clear progress', text: 'Streaks, weekly bars, trends and per-habit history show how consistent you really are.' },
  { icon: Layers, title: 'Multiple trackers', text: 'Keep separate timetables for school, exams, the gym or holidays.' },
  { icon: Timer, title: 'Focus timer', text: 'A Pomodoro timer with named sessions, tracked separately from your timetable.' },
  { icon: Users, title: 'Friends', text: 'Add friends by username and compare totals — never your task details.' },
]

const STEPS = [
  { title: 'Create a tracker', text: 'Name it after a routine — “School days”, “Exam prep”, “Gym”.' },
  { title: 'Add time slots and tasks', text: 'Build your week once: slots are rows, days are columns.' },
  { title: 'Tick things off', text: 'Check tasks as you do them and watch your streaks and charts grow.' },
]

const FAQ = [
  ['Is HabbitFlows free?', 'Yes. The free plan covers the timetable, check-offs, streaks, the focus timer and friends. Plus and Pro are optional upgrades.'],
  ['Do I need an email address?', 'Yes — one email address, used to sign in with a code and to recover your account if you forget your password.'],
  ['Is there a phone app?', 'HabbitFlows works in any browser on phones, tablets and computers, and there is an Android app build.'],
  ['Can friends see my tasks?', 'No. Friends only see daily totals such as completion percentage and focus minutes, and you can switch even that off.'],
  ['Can I export my data?', 'Every account can download all its data as JSON from Settings. Pro adds CSV and PDF reports.'],
]

const SHOTS = [
  { src: `${base}landing/dashboard.jpg`, alt: 'HabbitFlows dashboard with a weekly timetable of tasks in time slots', caption: 'Your week at a glance' },
  { src: `${base}landing/progress.jpg`, alt: 'Progress page with completion statistics, a weekly bar chart and a trend line', caption: 'Progress you can see' },
  { src: `${base}landing/focus.jpg`, alt: 'Focus timer counting down a named Pomodoro session', caption: 'Focus sessions' },
]

export default function LandingPage() {
  const signedIn = useAuth((s) => s.status === 'authenticated')
  const [interval, toggle] = useIntervalToggle()

  const primary = signedIn ? (
    <Link to="/dashboard" className="btn-primary h-12 px-6 text-base">
      Open your dashboard
    </Link>
  ) : (
    <Link to="/register" className="btn-primary h-12 px-6 text-base">
      Create Free Account
    </Link>
  )

  return (
    <>
      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 md:py-20 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-brand-soft px-3 py-1 text-sm font-medium text-brand-ink">
              <Smartphone className="size-4" aria-hidden="true" /> Web &amp; Android · free to start
            </p>
            <h1 className="mt-5 text-4xl leading-[1.1] font-semibold tracking-tight sm:text-5xl">{appConfig.tagline}</h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              HabbitFlows turns your routine into a weekly timetable you can tick off, day by day — with streaks, charts and a focus timer to keep you going.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {primary}
              {!signedIn && (
                <Link to="/login" className="btn-secondary h-12 px-6 text-base">
                  Login
                </Link>
              )}
            </div>
            <p className="mt-4 flex items-center gap-2 text-sm text-muted">
              <ShieldCheck className="size-4" aria-hidden="true" /> Free to start · your tasks stay private
            </p>
          </div>
          <img
            src={SHOTS[0].src}
            alt={SHOTS[0].alt}
            width={1440}
            height={900}
            className="w-full rounded-2xl border border-line shadow-pop"
          />
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6" aria-labelledby="features-title">
        <h2 id="features-title" className="text-center text-3xl font-semibold tracking-tight">
          Everything a routine needs
        </h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="card p-6">
              <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1.5 text-muted">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="how-title">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="how-title" className="text-center text-3xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand font-semibold text-white">{i + 1}</span>
                <div>
                  <h3 className="font-semibold">{s.title}</h3>
                  <p className="mt-1 text-muted">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6" aria-labelledby="shots-title">
        <h2 id="shots-title" className="text-center text-3xl font-semibold tracking-tight">
          See it in action
        </h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {SHOTS.slice(1).map((s) => (
            <figure key={s.src} className="min-w-0">
              <img src={s.src} alt={s.alt} width={1440} height={900} loading="lazy" className="w-full rounded-2xl border border-line shadow-card" />
              <figcaption className="mt-3 text-center text-sm text-muted">{s.caption}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="pricing-title">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="text-center">
            <h2 id="pricing-title" className="text-3xl font-semibold tracking-tight">
              Simple, fair pricing
            </h2>
            <p className="mt-2 text-muted">Start free. Upgrade only if you want more.</p>
            <div className="mt-5">{toggle}</div>
          </div>
          <div className="mt-10">
            <PlanCards
              interval={interval}
              renderAction={(plan) =>
                plan.rank === 0 ? (
                  <Link to={signedIn ? '/dashboard' : '/register'} className="btn-secondary h-11">
                    {signedIn ? 'Open app' : 'Create Free Account'}
                  </Link>
                ) : (
                  <Link to="/pro" className={plan.id === 'pro' ? 'btn-primary h-11' : 'btn-secondary h-11'}>
                    Get {plan.name}
                  </Link>
                )
              }
            />
          </div>
          <div className="mt-6">
            <RegionSwitch />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6" aria-labelledby="faq-title">
        <h2 id="faq-title" className="text-center text-3xl font-semibold tracking-tight">
          FAQ
        </h2>
        <div className="mt-8 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group card p-5">
              <summary className="cursor-pointer list-none font-medium marker:hidden">
                <span className="flex items-center justify-between gap-4">
                  {q}
                  <span className="text-muted transition-transform group-open:rotate-45" aria-hidden="true">
                    +
                  </span>
                </span>
              </summary>
              <p className="mt-2 text-muted">{a}</p>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted">
          More questions? Read the{' '}
          <Link to="/help" className="text-brand underline">
            help articles
          </Link>
          , our{' '}
          <Link to="/privacy" className="text-brand underline">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link to="/terms" className="text-brand underline">
            Terms
          </Link>
          .
        </p>
      </section>

      {appConfig.supportUrl && (
        <section className="mx-auto max-w-3xl px-4 pb-16 sm:px-6" aria-labelledby="support-title">
          <div className="card flex flex-col items-center gap-3 p-8 text-center">
            <Heart className="size-7 text-brand" aria-hidden="true" />
            <h2 id="support-title" className="text-xl font-semibold">
              {appConfig.supportLabel}
            </h2>
            <p className="max-w-md text-muted">HabbitFlows is built by an independent developer. If it helps you, you can chip in — completely optional.</p>
            <a href={appConfig.supportUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary mt-2">
              {appConfig.supportLabel}
            </a>
          </div>
        </section>
      )}
    </>
  )
}
