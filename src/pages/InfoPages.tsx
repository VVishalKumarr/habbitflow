import { Mail } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { appConfig, legalConfig } from '../config'

/** Public About Us and Contact Us pages (also linked from payment-provider applications). */

const SUPPORT_EMAIL = legalConfig.contactEmail || 'support@habbitflows.com'

function Page({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — ${appConfig.name}`
  }, [title])
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <div className="mt-8 space-y-8 leading-relaxed [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </div>
  )
}

const link = 'text-brand underline'

export function AboutPage() {
  const operator = legalConfig.businessName || appConfig.name
  return (
    <Page title="About us">
      <section>
        <p className="text-lg text-muted">{appConfig.tagline}</p>
        <p>
          {appConfig.name} is a study and habit planner for students. You build your weekly timetable once, tick tasks off each day, run focused Pomodoro sessions and
          see your streaks and progress over time. Schools and colleges can also use it to share timetables, homework and announcements with their students.
        </p>
      </section>

      <section>
        <h2>Who we are</h2>
        <p>
          {appConfig.name} is built and run by {operator}
          {legalConfig.country ? `, based in ${legalConfig.country}` : ''}. It is made by an independent developer, not a large company, and is shaped by feedback from the
          students and teachers who use it.
        </p>
      </section>

      <section>
        <h2>What we offer</h2>
        <ul>
          <li>
            <strong>Free plan</strong> — the weekly timetable, daily check-offs, streaks, the focus timer and friends, free forever.
          </li>
          <li>
            <strong>Plus and Pro</strong> — optional monthly or yearly subscriptions that remove ads and limits and add reports, focus sounds, leaderboards and more. See{' '}
            <Link to="/pro" className={link}>
              Pricing
            </Link>
            .
          </li>
          <li>
            <strong>For schools</strong> — accounts for institutions, with classes, timetables, assignments and reports.
          </li>
        </ul>
      </section>

      <section>
        <h2>Our approach to your data</h2>
        <p>
          We only collect what the app needs to work. Friends see your daily totals, never your task details, and you can download or delete all your data from Settings at
          any time. Payments are handled by our payment provider; we never see or store your card or UPI details. Read the{' '}
          <Link to="/privacy" className={link}>
            Privacy Policy
          </Link>{' '}
          for details.
        </p>
      </section>

      <section>
        <h2>Get in touch</h2>
        <p>
          Questions, feedback or a problem with your account? Visit the{' '}
          <Link to="/contact" className={link}>
            Contact us
          </Link>{' '}
          page or email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className={link}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </section>
    </Page>
  )
}

export function ContactPage() {
  return (
    <Page title="Contact us">
      <section>
        <p>We’re happy to help with questions about your account, subscriptions and payments, school accounts, or anything else about {appConfig.name}.</p>
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="mt-6 flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-brand"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">
            <Mail className="size-5" aria-hidden="true" />
          </span>
          <span>
            <span className="block text-sm text-muted">Email support</span>
            <span className="block font-semibold break-all">{SUPPORT_EMAIL}</span>
          </span>
        </a>
        <p className="text-sm text-muted">We aim to reply within two working days.</p>
      </section>

      <section>
        <h2>Help us help you faster</h2>
        <ul>
          <li>Write from the email address on your account, or include your username.</li>
          <li>
            For a payment question, include the date, amount and the payment ID from your receipt (it starts with <code>pay_</code>).
          </li>
          <li>Never send us your password — we will never ask for it.</li>
        </ul>
      </section>

      <section>
        <h2>Subscriptions and billing</h2>
        <p>
          You can see your plan, and cancel it at any time, on the{' '}
          <Link to="/pro" className={link}>
            Pricing
          </Link>{' '}
          page while signed in. Cancelling stops the next renewal; your plan stays active until the end of the period you’ve paid for. In the Android app, subscriptions are
          managed through Google Play.
        </p>
      </section>

      <section>
        <h2>Quick answers</h2>
        <p>
          Many common questions are answered in the{' '}
          <Link to="/help" className={link}>
            Help centre
          </Link>
          .
        </p>
      </section>

      {legalConfig.businessName && (
        <section>
          <h2>Business details</h2>
          <p>
            {legalConfig.businessName}
            {legalConfig.country ? `, ${legalConfig.country}` : ''}
          </p>
        </section>
      )}
    </Page>
  )
}
