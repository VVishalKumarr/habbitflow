import {
  ArrowRight,
  CalendarClock,
  ChartNoAxesColumn,
  Check,
  Flame,
  Heart,
  Layers,
  RotateCcw,
  Sparkles,
  Timer,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PlanCards, RegionSwitch, useIntervalToggle } from '../components/pricing/PlanCards'
import { ScoreBar, ScoreRing } from '../components/score/Score'
import { useInView, useRevealClass } from '../components/score/useReveal'
import { appConfig } from '../config'
import { potentialFor, scoreColor, tierOf } from '../lib/scores'
import { useAuth } from '../store/auth'

const base = import.meta.env.BASE_URL

const FEATURES = [
  { icon: CalendarClock, title: 'Weekly timetable', text: 'Build your week once — slots are rows, days are columns. It repeats every week.', glow: '#5750e0' },
  { icon: Check, title: 'Daily check-offs', text: 'Tick tasks as you go. Every tick moves your score in real time.', glow: '#22c55e' },
  { icon: TrendingUp, title: 'Scores & potential', text: 'Overall, consistency and streak power — plus the potential your best week proves you can hit.', glow: '#f2994a' },
  { icon: Timer, title: 'Focus timer', text: 'Named Pomodoro sessions, tracked separately so focus time counts on its own.', glow: '#ec4899' },
  { icon: Layers, title: 'Multiple trackers', text: 'Separate timetables for school, exam prep, the gym or the holidays.', glow: '#3b82f6' },
  { icon: Users, title: 'Friends', text: 'Compare totals and streaks with friends — never your task details.', glow: '#eab308' },
]

const FAQ = [
  ['Is HabbitFlows free?', 'Yes. The free plan covers the timetable, check-offs, scores, streaks, the focus timer and friends. Plus and Pro are optional upgrades.'],
  ['How are my scores calculated?', 'From your own check-offs: Overall is your completion over the last 30 days, Consistency is how many days you hit 80% or more, and Potential is based on your best 7-day run — what you’ve already shown you can do.'],
  ['Do I need an email address?', 'Yes — one email address, used to sign in with a code and to recover your account. We never send marketing emails unless you turn them on.'],
  ['Is there a phone app?', 'HabbitFlows works in any browser on phones, tablets and computers, and there is an Android app.'],
  ['Can friends see my tasks?', 'No. Friends only see daily totals such as completion and focus minutes, and you can switch even that off.'],
  ['Can I export my data?', 'Every account can download all its data from Settings. Pro adds CSV and PDF reports.'],
]

const SHOTS = [
  { src: `${base}landing/dashboard.jpg`, alt: 'HabbitFlows dashboard with a weekly timetable of tasks in time slots', caption: 'Your week at a glance' },
  { src: `${base}landing/progress.jpg`, alt: 'Progress page with completion statistics, a weekly bar chart and a trend line', caption: 'Progress you can see' },
  { src: `${base}landing/focus.jpg`, alt: 'Focus timer counting down a named Pomodoro session', caption: 'Focus sessions' },
]

/* ---------------------------------------------------------------- hero phone */

const SCREEN_MS = 4500

function ScoresScreen() {
  return (
    <div className="px-5 pt-4">
      <p className="text-lg leading-snug font-bold">Your week, rated</p>
      <div className="mx-auto mt-4 grid size-20 place-items-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-3xl shadow-[0_0_40px_-6px_#f2994a]">
        <Flame className="size-9 text-white" aria-hidden="true" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 rounded-3xl border border-white/10 bg-white/[0.05] p-4">
        <ScoreBar label="Overall" value={72} />
        <ScoreBar label="Potential" value={91} />
        <ScoreBar label="Consistency" value={81} />
        <ScoreBar label="Streak power" value={83} />
        <ScoreBar label="Focus" value={69} />
        <ScoreBar label="Sleep schedule" value={56} />
      </div>
    </div>
  )
}

const TODAY = [
  ['07:00', 'Morning run', true],
  ['08:30', 'Maths revision', true],
  ['11:00', 'Read 20 pages', true],
  ['15:00', 'Physics homework', false],
  ['21:30', 'Plan tomorrow', false],
] as const

function TodayScreen() {
  return (
    <div className="px-5 pt-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-white/50">Wednesday</p>
          <p className="text-lg font-bold">Today</p>
        </div>
        <ScoreRing value={60} size={64} />
      </div>
      <ul className="mt-4 space-y-2">
        {TODAY.map(([time, title, done], i) => (
          <li
            key={title}
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-2.5 animate-fade-in"
            style={{ animationDelay: `${i * 80}ms`, animationFillMode: 'backwards', animationDuration: '400ms' }}
          >
            <span className={`grid size-6 shrink-0 place-items-center rounded-full ${done ? 'bg-lime-400 text-black' : 'border border-white/25'}`}>
              {done && <Check className="size-4" strokeWidth={3} aria-hidden="true" />}
            </span>
            <span className={`min-w-0 flex-1 truncate text-sm ${done ? 'text-white/50 line-through' : ''}`}>{title}</span>
            <span className="text-xs text-white/40 tabular-nums">{time}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 rounded-2xl bg-lime-400/10 px-3 py-2 text-center text-xs text-lime-300">2 more ticks → new personal best 🔥</p>
    </div>
  )
}

function RingsScreen() {
  return (
    <div className="px-5 pt-4">
      <p className="text-center text-lg font-bold">Habit ratings</p>
      <div className="mt-2 rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs">
        {[
          ['Strongest habit', 'Maths revision'],
          ['Needs work', 'Sleep schedule'],
          ['Next level', '+19 to potential'],
        ].map(([k, v]) => (
          <p key={k} className="flex justify-between py-0.5">
            <span className="text-white/50">{k}</span>
            <span className="font-semibold">{v}</span>
          </p>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {[
          ['Maths', 92],
          ['Gym', 78],
          ['Reading', 64],
          ['Sleep', 41],
        ].map(([label, v]) => (
          <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.05] py-3">
            <ScoreRing label={String(label)} value={Number(v)} size={84} />
          </div>
        ))}
      </div>
    </div>
  )
}

const SCREENS = [
  { name: 'Scores', el: <ScoresScreen /> },
  { name: 'Today', el: <TodayScreen /> },
  { name: 'Ratings', el: <RingsScreen /> },
]

function HeroPhone() {
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const t = window.setTimeout(() => setI((n) => (n + 1) % SCREENS.length), SCREEN_MS)
    return () => window.clearTimeout(t)
  }, [i, paused])

  return (
    <div className="relative mx-auto w-[300px] sm:w-[320px]" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="phone h-[620px]">
        <div className="mx-auto mt-2 h-6 w-28 rounded-full bg-black" aria-hidden="true" />
        <div className="mt-3 flex gap-1.5 px-5" role="tablist" aria-label="App preview">
          {SCREENS.map((s, n) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={n === i}
              aria-label={s.name}
              onClick={() => setI(n)}
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15"
            >
              {n < i && <span className="block h-full w-full bg-white" />}
              {n === i && (
                <span
                  key={`${i}-${paused}`}
                  className={`block h-full w-full bg-white ${paused ? '' : 'animate-progress'}`}
                  style={{ animationDuration: `${SCREEN_MS}ms` }}
                />
              )}
            </button>
          ))}
        </div>
        <div key={i} className="animate-sheet">
          {SCREENS[i].el}
        </div>
      </div>
      {/* floating chips */}
      <div className="glass animate-float absolute top-[46%] -left-14 hidden items-center gap-2 px-3 py-2 text-sm text-white shadow-xl sm:flex">
        <Flame className="size-4 text-orange-400" aria-hidden="true" /> 12-day streak
      </div>
      <div className="glass animate-float absolute -right-8 bottom-28 hidden items-center gap-2 px-3 py-2 text-sm text-white shadow-xl sm:flex" style={{ animationDelay: '-3s' }}>
        <Sparkles className="size-4 text-lime-300" aria-hidden="true" /> Potential 91
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ try-it demo */

const DEMO = [
  ['07:00', 'Morning run'],
  ['08:30', 'Maths revision'],
  ['11:00', 'Read 20 pages'],
  ['15:00', 'Physics homework'],
  ['18:00', 'Gym'],
  ['21:30', 'Plan tomorrow'],
] as const

const QUIPS: Record<string, string> = {
  Rising: 'Every legend starts somewhere. Tick one more.',
  Good: 'Solid day. Your potential says you can go higher.',
  High: 'Locked in. One more and you’re elite.',
  Elite: 'Elite discipline. Main-character energy. 🔥',
}

function TryIt() {
  const [done, setDone] = useState<boolean[]>([true, true, false, false, false, false])
  const [ref, inView] = useInView<HTMLDivElement>(0.3)
  const score = Math.round((done.filter(Boolean).length / DEMO.length) * 100)
  const potential = potentialFor(score)
  const tier = tierOf(score)

  return (
    <div ref={ref} className="grid items-center gap-8 lg:grid-cols-2">
      <ul className="space-y-2.5">
        {DEMO.map(([time, title], n) => (
          <li key={title}>
            <button
              type="button"
              aria-pressed={done[n]}
              onClick={() => setDone((d) => d.map((v, k) => (k === n ? !v : v)))}
              className={`group flex w-full items-center gap-4 rounded-2xl border px-4 py-3.5 text-left transition-all active:scale-[0.99] ${
                done[n] ? 'border-lime-400/40 bg-lime-400/10' : 'border-line bg-surface hover:border-brand/60'
              }`}
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-full transition-all ${
                  done[n] ? 'scale-110 bg-lime-400 text-black' : 'border-2 border-line group-hover:border-brand'
                }`}
              >
                {done[n] && <Check className="size-4" strokeWidth={3} aria-hidden="true" />}
              </span>
              <span className={`flex-1 font-medium ${done[n] ? 'text-muted line-through' : ''}`}>{title}</span>
              <span className="text-sm text-muted tabular-nums">{time}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="card relative overflow-hidden p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full blur-3xl" style={{ background: scoreColor(score), opacity: 0.18 }} aria-hidden="true" />
        <div className="relative flex flex-col items-center gap-6 sm:flex-row">
          <ScoreRing value={score} run={inView} size={150} sub="today" />
          <div className="w-full flex-1 space-y-4">
            <ScoreBar label="Today" value={score} potential={potential} run={inView} />
            <ScoreBar label="Potential" value={potential} run={inView} />
          </div>
        </div>
        <p className="relative mt-6 text-center text-lg font-semibold" aria-live="polite">
          {QUIPS[tier]}
        </p>
        <button type="button" className="btn-ghost relative mx-auto mt-2 flex" onClick={() => setDone(DEMO.map(() => false))}>
          <RotateCcw className="size-4" aria-hidden="true" /> Reset
        </button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- rated rings */

const RINGS = [
  ['Maths revision', 92, 'Strongest'],
  ['Gym', 78, '3× a week'],
  ['Reading', 64, '+12 this month'],
  ['Sleep schedule', 41, 'Needs work'],
] as const

function RatedRings() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div ref={ref} className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {RINGS.map(([label, v, sub], n) => (
        <div key={label} className="card flex flex-col items-center py-6 transition-transform hover:-translate-y-1" style={{ transitionDelay: `${n * 60}ms` }}>
          <ScoreRing label={label} value={v} run={inView} size={120} />
          <p className="mt-3 text-xs text-muted">{sub}</p>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ page */

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const r = useRevealClass(delay)
  return (
    <div ref={r.ref} className={`${r.className} ${className}`} style={r.style}>
      {children}
    </div>
  )
}

function SectionTitle({ id, kicker, title, text }: { id: string; kicker: string; title: string; text?: string }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold tracking-widest text-orange-400 uppercase">{kicker}</p>
      <h2 id={id} className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">
        {title}
      </h2>
      {text && <p className="mt-4 text-lg text-muted">{text}</p>}
    </Reveal>
  )
}

export default function LandingPage() {
  const signedIn = useAuth((s) => s.status === 'authenticated')
  const [interval, toggle] = useIntervalToggle()

  const primary = signedIn ? (
    <Link to="/dashboard" className="btn-cta">
      Open your dashboard <ArrowRight className="size-5" aria-hidden="true" />
    </Link>
  ) : (
    <Link to="/register" className="btn-cta">
      Get my score — free <ArrowRight className="size-5" aria-hidden="true" />
    </Link>
  )

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-brand/30 blur-[120px]" />
          <div className="absolute top-1/3 -right-40 size-[420px] rounded-full bg-orange-500/20 blur-[120px]" />
          <div className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.06)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
        </div>
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pt-12 pb-20 sm:px-6 md:pt-20 lg:grid-cols-[1.1fr_1fr]">
          <div className="text-center lg:text-left">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm font-medium">
              <span className="size-2 animate-pulse rounded-full bg-lime-400" aria-hidden="true" /> Your habits, rated
            </p>
            <h1 className="mt-6 text-5xl leading-[1.02] font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
              Rate your routine.{' '}
              <span className="bg-gradient-to-r from-orange-400 via-amber-300 to-lime-300 bg-clip-text text-transparent">Unlock your potential.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg text-muted lg:mx-0">
              {appConfig.name} turns your week into a timetable you tick off — and scores your discipline like a game. See your Overall, your streak power, and the Potential
              you’re one good week away from.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start">
              {primary}
              {!signedIn && (
                <Link to="/login" className="inline-flex min-h-12 items-center rounded-full border border-white/15 px-6 font-semibold hover:bg-white/5">
                  Login
                </Link>
              )}
            </div>
            <p className="mt-5 text-sm text-muted">Free forever plan · Web &amp; Android · Your tasks stay private</p>
          </div>
          <HeroPhone />
        </div>
      </section>

      {/* Try it */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="try-title">
        <SectionTitle id="try-title" kicker="Try it now" title="Tick a task. Watch your score move." text="This is how every day feels in HabbitFlows. Go on — tap a few." />
        <Reveal className="mt-12">
          <TryIt />
        </Reveal>
      </section>

      {/* Rated rings */}
      <section className="border-y border-line bg-surface/40 py-20" aria-labelledby="rings-title">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionTitle id="rings-title" kicker="Habit ratings" title="Every habit gets a score" text="Find your strongest habit, spot the one dragging you down, and see exactly how far your potential goes." />
          <Reveal className="mt-12">
            <RatedRings />
          </Reveal>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6" aria-labelledby="features-title">
        <SectionTitle id="features-title" kicker="Features" title="Everything a routine needs" />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text, glow }, n) => (
            <Reveal key={title} delay={n * 70}>
              <div className="card group relative h-full overflow-hidden p-6 transition-transform hover:-translate-y-1">
                <div
                  className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full opacity-20 blur-2xl transition-opacity group-hover:opacity-40"
                  style={{ background: glow }}
                  aria-hidden="true"
                />
                <span className="relative flex size-12 items-center justify-center rounded-2xl text-white" style={{ background: glow, boxShadow: `0 8px 24px -6px ${glow}` }}>
                  <Icon className="size-6" aria-hidden="true" />
                </span>
                <h3 className="relative mt-5 text-lg font-semibold">{title}</h3>
                <p className="relative mt-1.5 text-muted">{text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Real screenshots */}
      <section className="border-y border-line bg-surface/40 py-20" aria-labelledby="shots-title">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionTitle id="shots-title" kicker="The real app" title="See it in action" />
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {SHOTS.map((s, n) => (
              <Reveal key={s.src} delay={n * 90}>
                <figure className="group min-w-0">
                  <div className="overflow-hidden rounded-2xl border border-line shadow-pop">
                    <img src={s.src} alt={s.alt} width={1440} height={900} loading="lazy" className="w-full transition-transform duration-500 group-hover:scale-105" />
                  </div>
                  <figcaption className="mt-3 text-center text-sm text-muted">{s.caption}</figcaption>
                </figure>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-20" aria-labelledby="pricing-title">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <Reveal className="text-center">
            <p className="text-sm font-semibold tracking-widest text-orange-400 uppercase">Pricing</p>
            <h2 id="pricing-title" className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">
              Start free. Level up later.
            </h2>
            <div className="mt-6">{toggle}</div>
          </Reveal>
          <div className="mt-10">
            <PlanCards
              interval={interval}
              renderAction={(plan) =>
                plan.rank === 0 ? (
                  <Link to={signedIn ? '/dashboard' : '/register'} className="btn-secondary h-11 rounded-full">
                    {signedIn ? 'Open app' : 'Create Free Account'}
                  </Link>
                ) : (
                  <Link to="/pro" className={plan.id === 'pro' ? 'btn-cta min-h-11 text-sm' : 'btn-secondary h-11 rounded-full'}>
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

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 pb-20 sm:px-6" aria-labelledby="faq-title">
        <Reveal>
          <h2 id="faq-title" className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Questions
          </h2>
        </Reveal>
        <div className="mt-8 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group card p-5 open:border-brand/40">
              <summary className="cursor-pointer list-none font-medium marker:hidden">
                <span className="flex items-center justify-between gap-4">
                  {q}
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-subtle text-muted transition-transform group-open:rotate-45" aria-hidden="true">
                    +
                  </span>
                </span>
              </summary>
              <p className="mt-3 text-muted">{a}</p>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted">
          More questions? Read the{' '}
          <Link to="/help" className="text-brand underline">
            help articles
          </Link>{' '}
          or{' '}
          <Link to="/contact" className="text-brand underline">
            contact us
          </Link>
          .
        </p>
      </section>

      {/* Final CTA */}
      <section className="px-4 pb-20 sm:px-6">
        <Reveal className="relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-[#1b1840] via-[#15131f] to-[#2a160c] px-6 py-16 text-center text-white">
          <div className="pointer-events-none absolute -bottom-32 left-1/2 size-96 -translate-x-1/2 rounded-full bg-orange-500/30 blur-[100px]" aria-hidden="true" />
          <ChartNoAxesColumn className="relative mx-auto size-10 text-orange-300" aria-hidden="true" />
          <h2 className="relative mt-4 text-3xl font-extrabold tracking-tight sm:text-5xl">Your potential is waiting.</h2>
          <p className="relative mx-auto mt-4 max-w-lg text-white/70">Set up your week in two minutes and get your first score today.</p>
          <div className="relative mt-8 flex justify-center">{primary}</div>
        </Reveal>
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
