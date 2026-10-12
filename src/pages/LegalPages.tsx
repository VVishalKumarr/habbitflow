import { AlertTriangle } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { adsConfig, aiConfig, analyticsConfig, appConfig, legalConfig, paymentsConfig, sentryConfig } from '../config'
import { legalComplete } from '../config/legal'
import { useConsent } from '../store/consent'

/** Shows a configured value, or a clearly marked placeholder. Never invents details. */
function Val({ v, label }: { v: string; label: string }) {
  return v ? <>{v}</> : <mark className="rounded bg-danger-soft px-1 text-danger">[{label} — not configured]</mark>
}

function DraftNotice() {
  if (legalConfig.reviewed && legalComplete()) return null
  return (
    <div role="note" className="mt-6 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <p>
        <strong>Draft.</strong> This text was generated as a starting point and is not legal advice. It must be completed and reviewed by an appropriate legal professional before
        public launch.
      </p>
    </div>
  )
}

function Doc({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — ${appConfig.name}`
  }, [title])
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        Effective date: <Val v={legalConfig.effectiveDate} label="effective date" />
      </p>
      <DraftNotice />
      <div className="legal mt-8 space-y-8 leading-relaxed [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">{children}</div>
    </div>
  )
}

const operator = () => <Val v={legalConfig.businessName} label="legal business name" />
const contact = () =>
  legalConfig.contactEmail ? (
    <a href={`mailto:${legalConfig.contactEmail}`} className="text-brand underline">
      {legalConfig.contactEmail}
    </a>
  ) : (
    <Val v="" label="contact email" />
  )

export function PrivacyPage() {
  const openCookies = useConsent((s) => s.openSettings)
  const analyticsName = analyticsConfig.provider === 'plausible' ? 'Plausible Analytics' : analyticsConfig.provider === 'umami' ? 'Umami' : ''
  const ads = Boolean(adsConfig.adsenseClientId)
  const payments = paymentsConfig.web === 'razorpay' && paymentsConfig.razorpayKeyId ? 'Razorpay' : ''
  const play = Boolean(paymentsConfig.googlePlayProductId)
  const ai = aiConfig.provider === 'anthropic' ? 'Anthropic (Claude)' : aiConfig.provider

  return (
    <Doc title="Privacy Policy">
      <section>
        <h2>Who we are</h2>
        <p>
          {appConfig.name} (“we”, “us”) is operated by {operator()}, based in <Val v={legalConfig.country} label="country" />. This policy explains what information the {appConfig.name}{' '}
          website and Android app collect, why, and the choices you have. Questions: {contact()}.
        </p>
      </section>

      <section>
        <h2>Information we collect</h2>
        <p>
          <strong>Account.</strong> Your username and password. Passwords are stored only as a secure one-way hash by our authentication provider; we can’t see them. If you add one,
          your optional recovery email address.
        </p>
        <p>
          <strong>Your content.</strong> Trackers, time slots, tasks (titles, optional descriptions, categories), task completion history, focus sessions (task name, length, date),
          friend connections, and settings such as theme, week start and time format.
        </p>
        <p>
          <strong>Subscriptions.</strong> If you buy Pro: your plan, its status and dates, and the payment provider’s subscription reference. We never receive or store card, UPI or bank
          details.
        </p>
        <p>
          <strong>Technical information.</strong> Our hosting and database providers process IP addresses and basic request logs to deliver and secure the service.
          {sentryConfig.dsn && ' If the app crashes, an error report (error message, browser/app version, page path) is sent to Sentry with passwords, tokens and email addresses removed.'}
          {analyticsName && ` With your permission, anonymous usage statistics are collected with ${analyticsName} (see Analytics).`}
        </p>
      </section>

      <section>
        <h2>How we use it</h2>
        <ul>
          <li>To provide the service: save your timetable, show your progress, sync between devices.</li>
          <li>To secure your account: log in, password recovery (only if you added a recovery email), rate-limiting abuse.</li>
          <li>To provide the paid-plan features you bought and enforce plan limits.</li>
          <li>To show friends the totals you choose to share (see Friends).</li>
          <li>To fix problems and improve the app{analyticsName ? ', using anonymous statistics if you allow them' : ''}.</li>
        </ul>
        <p>We don’t sell your personal information, and we don’t use your task contents for advertising.</p>
      </section>

      <section>
        <h2>Friends and sharing</h2>
        <p>
          Your tasks are private. Accepted friends can see only daily totals — completion percentage, number of tasks completed and focus minutes — and only while “Share my progress
          with friends” is on in Settings. Leaderboards are off unless you opt in. Friends never see task names, descriptions, your timetable, your email or your subscription.
        </p>
      </section>

      <section>
        <h2>Service providers</h2>
        <p>We use these providers to run {appConfig.name}. They process data on our behalf and only as needed to provide their service:</p>
        <ul>
          <li>
            <strong>Supabase</strong> — database, authentication and server functions
            {legalConfig.dataRegion ? ` (data stored in ${legalConfig.dataRegion})` : ''}.
          </li>
          <li>
            <strong>Your browser’s or phone’s push service</strong> (for example Google, Mozilla or Apple) — delivers push notifications, encrypted for your device, only if you
            turn them on.
          </li>
          <li>
            <strong>{legalConfig.hostingProvider || 'Our web hosting provider'}</strong> — serves the website.
          </li>
          {legalConfig.emailProvider && (
            <li>
              <strong>{legalConfig.emailProvider}</strong> — sends account emails (recovery-email confirmation, password reset, school invitations) and the notification emails you turn on.
            </li>
          )}
          {analyticsName && (
            <li>
              <strong>{analyticsName}</strong> — privacy-friendly usage statistics, only with your consent.
            </li>
          )}
          {sentryConfig.dsn && (
            <li>
              <strong>Sentry</strong> — error reports with sensitive data removed.
            </li>
          )}
          {ads && (
            <li>
              <strong>Google AdSense</strong> — ads on some public and progress pages, only with your consent and never for paying members.
            </li>
          )}
          {payments && (
            <li>
              <strong>{payments}</strong> — processes Pro payments on the website.
            </li>
          )}
          {play && (
            <li>
              <strong>Google Play</strong> — processes Pro purchases in the Android app.
            </li>
          )}
          {ai && (
            <li>
              <strong>{ai}</strong> — powers the in-app help assistant and the timetable assistant (see AI assistant).
            </li>
          )}
        </ul>
      </section>

      {ai && (
        <section>
          <h2>AI assistant</h2>
          <p>
            When you ask the assistant a question, we send your question, the conversation so far, the page you’re on and which plan you’re on (Free, Plus or Pro) to {ai} to generate an
            answer. We don’t send your tasks, statistics, email, password or payment details. Please don’t type personal information into the assistant.
          </p>
          <p>
            The timetable assistant sends {ai} only what each request needs: your command text; or your answers to the timetable questions; or your timetable’s activity names,
            categories and times. For students of a school that uses HabbitFlow it also sends class times and subjects, and homework and exam titles and dates. It never sends your name,
            email, school name, marks or attendance. Voice commands are turned into text by your browser or phone; we never receive or store audio. We don’t store prompts or
            answers — only counts and token numbers for usage limits. {ai} does not use this data to train its models.
          </p>
        </section>
      )}

      <section>
        <h2>Email and push notifications</h2>
        <p>
          Only if you turn them on (Settings → Notifications), we send the same text you see in the app by email, or as a push notification. Push messages are encrypted for your
          device and pass through your browser’s or phone’s push service (for example Google, Mozilla or Apple); emails are sent through our email provider. Turning push off
          removes the device from your account.
        </p>
      </section>

      <section>
        <h2>Accounts provided by a school</h2>
        <p>
          If you use HabbitFlow through your school or college, your class teacher can see and change your personal timetable (time slots, activities and notes) if your school
          allows it. They can’t see which tasks you ticked, your streaks or your progress. You get a notification for every change, it’s listed in your timetable History
          with the teacher’s name, and you can undo it. Your school can switch this off.
        </p>
        <p>
          Your school can calculate a development score from your published marks, homework, attendance and school programmes, which you and your teachers can see.
          Your personal timetable and goals are only used if you switch on “Share my habit consistency with my school”, and then only as counts (how many planned activities
          you ticked, completed skill goals) — never the tasks themselves.
        </p>
      </section>

      <section>
        <h2>Cookies and local storage</h2>
        <p>
          Necessary storage keeps you logged in and remembers settings (theme, timer settings, your cookie choice). It is always on.
          {analyticsName || ads
            ? ' Optional analytics and advertising technologies are only loaded after you agree, and you can change your choice at any time.'
            : ' We don’t currently use optional analytics or advertising cookies.'}{' '}
          <button type="button" className="text-brand underline" onClick={openCookies}>
            Open Cookie Settings
          </button>
          .
        </p>
      </section>

      {analyticsName && (
        <section>
          <h2>Analytics</h2>
          <p>
            With your consent we record anonymous product events (for example “tracker created” or “task completed”) and page paths with {analyticsName}. Events never include
            passwords, task contents, email addresses, tokens or payment details.
          </p>
        </section>
      )}

      {ads && (
        <section>
          <h2>Advertising</h2>
          <p>
            With your consent, Google AdSense may show ads on some pages and may use cookies to do so. Ads never appear on the focus timer, when ticking off tasks or on account and
            password pages, and paying members (Plus and Pro) see no ads. Learn more in{' '}
            <a href="https://policies.google.com/technologies/ads" className="text-brand underline" target="_blank" rel="noopener noreferrer">
              Google’s advertising policies
            </a>
            .
          </p>
        </section>
      )}

      <section>
        <h2>Payments</h2>
        <p>
          {payments || play
            ? `Pro payments are handled by ${[payments, play ? 'Google Play (Android)' : ''].filter(Boolean).join(' and ')}. We receive only the subscription status, not your payment details.`
            : 'Paid plans are not being sold at the moment. When they are, payments will be handled by a payment provider and we will not receive your card or bank details.'}
        </p>
      </section>

      <section>
        <h2>How long we keep data</h2>
        <p>
          We keep your account and content until you delete them or your account. Deleting a tracker, task or session removes it immediately. Deleting your account removes your
          profile, trackers, tasks, history, focus sessions, friend connections and recovery email. Short-lived security records (such as rate-limit counters) are deleted within a
          day. Provider backups and logs may take a limited time to expire. Payment providers keep transaction records as the law requires.
        </p>
      </section>

      <section>
        <h2>Your choices and rights</h2>
        <ul>
          <li>Download all your data at any time: Settings → Data → Export.</li>
          <li>Change or remove your recovery email, and change your username or password, in Settings.</li>
          <li>Delete your account in Settings → Data → Delete account.</li>
          <li>Withdraw consent for analytics or advertising in Cookie Settings.</li>
        </ul>
        <p>
          Depending on where you live, you may have further rights (for example to access, correct or object to processing, or to complain to a data protection authority). Contact us at{' '}
          {contact()}.
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          Data is sent over encrypted connections (HTTPS). Every table is protected by database access rules so one user can’t read another’s data. Passwords are hashed, password
          reset links are single-use and expire, and sensitive actions require your current password. No system is perfectly secure, so please use a strong, unique password.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          {appConfig.name} is not intended for children under {legalConfig.minimumAge}. If you believe a child has created an account, contact us and we’ll delete it.
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>We’ll update this page when our practices change and revise the effective date. Significant changes will be announced in the app.</p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          {operator()} · {contact()} · <Val v={legalConfig.country} label="country" />
        </p>
        <p>
          See also our{' '}
          <Link to="/terms" className="text-brand underline">
            Terms of Service
          </Link>
          .
        </p>
      </section>
    </Doc>
  )
}

export function TermsPage() {
  return (
    <Doc title="Terms of Service">
      <section>
        <h2>1. Acceptance of Terms</h2>
        <p>
          These Terms govern your use of the {appConfig.name} website and apps, operated by {operator()}. By creating an account or using {appConfig.name}, you agree to these Terms
          and to our{' '}
          <Link to="/privacy" className="text-brand underline">
            Privacy Policy
          </Link>
          . If you don’t agree, please don’t use the service.
        </p>
      </section>
      <section>
        <h2>2. Account Registration</h2>
        <p>
          You need a username and password. You must be at least {legalConfig.minimumAge} years old (or the minimum age required where you live) and provide accurate information.
          One person may create more than one account, but accounts are personal and may not be sold or transferred.
        </p>
      </section>
      <section>
        <h2>3. Account Security</h2>
        <p>
          Keep your password secret and use a strong, unique one. You’re responsible for activity on your account. Without a confirmed recovery email we cannot reset a forgotten
          password. Tell us promptly at {contact()} if you suspect unauthorised use.
        </p>
      </section>
      <section>
        <h2>4. Acceptable Use</h2>
        <ul>
          <li>Don’t break the law, harass other users, or use offensive usernames.</li>
          <li>Don’t try to access other people’s data, bypass plan limits or security, or disrupt the service (including automated scraping or excessive requests).</li>
          <li>Don’t reverse-engineer paid features or resell the service.</li>
        </ul>
      </section>
      <section>
        <h2>5. User Content</h2>
        <p>
          You own what you put into {appConfig.name} (tasks, notes, names). You give us permission to store and process it only to provide the service to you — for example to show
          it to you, and to show the totals you choose to share with friends. You’re responsible for your content.
        </p>
      </section>
      <section>
        <h2>6. Free and Paid Plans</h2>
        <p>
          The free plan is free of charge and has limits shown on the Pricing page. Plus and Pro are optional paid subscriptions with additional features, and prices may differ by region. We may change features and limits
          over time; if a limit is reduced we won’t delete content you already created.
        </p>
      </section>
      <section>
        <h2>7. Subscriptions</h2>
        <p>
          Pro renews automatically at the end of each billing period (monthly or yearly) until cancelled. The price and billing period are shown before you pay. Free trials, when
          offered, are limited to one per account and end automatically without charge unless you subscribe.
        </p>
      </section>
      <section>
        <h2>8. Payments</h2>
        <p>
          Payments are processed by third-party payment providers (on the website) or Google Play (in the Android app), under their terms. Prices may include or exclude taxes as
          shown at checkout. If a renewal payment fails, paid features may stop until payment succeeds.
        </p>
      </section>
      <section>
        <h2>9. Cancellations</h2>
        <p>
          You can cancel at any time from the Pricing page (website) or Google Play (Android). Cancelling stops future renewals; Pro remains active until the end of the paid period.
          Your data stays in your account after Pro ends.
        </p>
      </section>
      <section>
        <h2>10. Refunds</h2>
        <p>
          <Val v="" label="refund policy — decide and describe it here" /> Purchases made through Google Play are subject to Google Play’s refund policies. Nothing in these Terms
          limits refund rights you have under the law where you live.
        </p>
      </section>
      <section>
        <h2>11. Advertising</h2>
        <p>
          The free plan may show a limited number of ads on some pages, only with your consent where required. Paying members (Plus and Pro) don’t see ads. We are not responsible for the content of
          third-party ads.
        </p>
      </section>
      <section>
        <h2>12. Third-party Services</h2>
        <p>
          {appConfig.name} relies on third-party providers (listed in the Privacy Policy). Their services are governed by their own terms, and we are not responsible for their
          availability.
        </p>
      </section>
      <section>
        <h2>13. Service Availability</h2>
        <p>
          We work to keep {appConfig.name} available and your data safe, but the service is provided “as is” and may occasionally be unavailable for maintenance or reasons outside
          our control. Please keep your own exports of important data.
        </p>
      </section>
      <section>
        <h2>14. Intellectual Property</h2>
        <p>
          The {appConfig.name} software, name, logo and design belong to {operator()} and are protected by law. These Terms don’t give you any rights to them other than to use the
          service.
        </p>
      </section>
      <section>
        <h2>15. Account Termination</h2>
        <p>
          You can delete your account at any time in Settings. We may suspend or close accounts that seriously or repeatedly break these Terms, or where required by law. Where
          reasonable we’ll give notice and the chance to export your data first.
        </p>
      </section>
      <section>
        <h2>16. Disclaimer</h2>
        <p>
          {appConfig.name} is a personal productivity tool. It does not provide medical, psychological, educational or professional advice. To the extent permitted by law, the
          service is provided without warranties of any kind.
        </p>
      </section>
      <section>
        <h2>17. Limitation of Liability</h2>
        <p>
          To the extent permitted by law, {operator()} is not liable for indirect or consequential losses, or for loss of data, arising from your use of the service. Our total
          liability is limited to the amount you paid us in the 12 months before the claim. Nothing in these Terms excludes liability that can’t be excluded by law.
        </p>
      </section>
      <section>
        <h2>18. Changes to Terms</h2>
        <p>We may update these Terms. We’ll change the effective date and, for significant changes, tell you in the app. Continuing to use the service means you accept the new Terms.</p>
      </section>
      <section>
        <h2>19. Governing Law</h2>
        <p>
          These Terms are governed by the laws of <Val v={legalConfig.country} label="country/jurisdiction" />, without affecting mandatory consumer protections where you live.
        </p>
      </section>
      <section>
        <h2>20. Contact</h2>
        <p>
          {operator()} · {contact()}
        </p>
      </section>
    </Doc>
  )
}
