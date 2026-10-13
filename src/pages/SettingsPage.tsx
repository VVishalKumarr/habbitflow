import { AtSign, Cookie, Download, FileSpreadsheet, FileText, Heart, KeyRound, Lock, LogOut, Mail, MailCheck, Moon, Sparkles, Sun, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { SiteFooter } from '../components/layout/SiteFooter'
import {
  ChangePasswordDialog,
  ChangeUsernameDialog,
  DeleteAccountDialog,
  RecoveryEmailDialog,
  RemoveEmailDialog,
} from '../components/settings/AccountDialogs'
import { AiUsage } from '../components/settings/AiUsage'
import { NotificationPrefs } from '../components/settings/NotificationPrefs'
import { Spinner } from '../components/ui/Spinner'
import { appConfig } from '../config'
import { analytics } from '../lib/analytics'
import { addDays, formatDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/errors'
import { exportCsv, exportPdf } from '../lib/exports'
import { saveJsonFile } from '../lib/native'
import { supabase } from '../lib/supabase'
import type { AccentTheme, Profile } from '../lib/types'
import { useAuth } from '../store/auth'
import { useConsent } from '../store/consent'
import { RedeemCodeButton } from '../components/subscription/RedeemCode'
import { renewsAutomatically, useFeatureAccess, useSubscription } from '../store/subscription'
import { useTrackers } from '../store/trackers'
import { toast } from '../store/ui'

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[15px] font-medium">{label}</p>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex w-full rounded-xl bg-subtle p-1 sm:w-auto" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors sm:flex-none ${
            value === o.value ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

async function exportAll(username: string) {
  const [trackers, slots, tasks, completions, pomodoro] = await Promise.all([
    supabase.from('trackers').select('id, name, created_at, updated_at').order('created_at'),
    supabase.from('time_slots').select('id, tracker_id, start_time, end_time, created_at'),
    supabase.from('tasks').select('id, tracker_id, time_slot_id, day_of_week, title, description, category, created_at, updated_at'),
    (async () => {
      const rows: unknown[] = []
      for (let from = 0; ; from += 1000) {
        const r = await supabase.from('task_completions').select('task_id, completion_date, completed').order('id').range(from, from + 999)
        if (r.error) return r
        rows.push(...r.data)
        if (r.data.length < 1000) return { data: rows, error: null }
      }
    })(),
    supabase
      .from('pomodoro_sessions')
      .select('label, planned_minutes, focus_seconds, completed, session_date, started_at, ended_at')
      .order('ended_at'),
  ])
  for (const r of [trackers, slots, tasks, completions, pomodoro]) if (r.error) throw r.error
  const data = {
    app: 'HabbitFlows',
    exported_at: new Date().toISOString(),
    username,
    trackers: (trackers.data ?? []).map((t) => ({
      ...t,
      time_slots: (slots.data ?? []).filter((s) => s.tracker_id === t.id),
      tasks: (tasks.data ?? []).filter((x) => x.tracker_id === t.id),
    })),
    completions: completions.data,
    pomodoro_sessions: pomodoro.data,
  }
  await saveJsonFile(`habbitflows-${username}-${todayISO()}.json`, data)
}

const ACCENTS: { value: AccentTheme; label: string; swatch: string }[] = [
  { value: 'default', label: 'Default', swatch: '#5750e0' },
  { value: 'ocean', label: 'Ocean', swatch: '#0a7299' },
  { value: 'forest', label: 'Forest', swatch: '#2f7d4f' },
  { value: 'sunset', label: 'Sunset', swatch: '#c2410c' },
  { value: 'midnight', label: 'Midnight', swatch: '#334a8f' },
  { value: 'minimal', label: 'Minimal', swatch: '#2f3441' },
]

function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${checked ? 'bg-brand' : 'bg-line'}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] ${checked ? 'left-[22px]' : 'left-0.5'}`} aria-hidden="true" />
    </button>
  )
}

interface AccountInfo {
  recovery_email: string | null
  email_verified: boolean
  pending_email: string | null
}

type Dialog = 'username' | 'email' | 'remove-email' | 'password' | 'delete' | null

const EXPORT_RANGES = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
]

export default function SettingsPage() {
  const profile = useAuth((s) => s.profile)!
  const updateProfile = useAuth((s) => s.updateProfile)
  const signOut = useAuth((s) => s.signOut)
  const sub = useSubscription()
  const institutional = profile?.account_type === 'institutional'
  const loginEmail = useAuth((st) => st.session?.user.email ?? '')
  const { hasFeature, requireFeature } = useFeatureAccess()
  const trackers = useTrackers((s) => s.trackers)
  const selectedId = useTrackers((s) => s.selectedId)
  const openCookies = useConsent((s) => s.openSettings)
  const navigate = useNavigate()
  const [exporting, setExporting] = useState<'json' | 'csv' | 'pdf' | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [range, setRange] = useState(30)
  const [reportTracker, setReportTracker] = useState<string>(selectedId ?? '')

  const loadAccount = useCallback(() => {
    supabase.rpc('my_account').then(({ data }) => data && setAccount(data as AccountInfo))
  }, [])

  useEffect(() => {
    loadAccount()
    analytics.track('settings_opened')
  }, [loadAccount])

  useEffect(() => {
    if (!reportTracker && selectedId) setReportTracker(selectedId)
  }, [selectedId, reportTracker])

  const save = (patch: Partial<Pick<Profile, 'week_start' | 'time_format' | 'theme' | 'accent_theme' | 'leaderboard_opt_in' | 'share_progress'>>) =>
    updateProfile(patch)
      .then(() => toast.success('Preferences saved.'))
      .catch((e: Error) => toast.error(e.message))

  const onExport = async (kind: 'json' | 'csv' | 'pdf') => {
    if (kind !== 'json' && !requireFeature(kind === 'csv' ? 'csv_export' : 'pdf_export')) return
    setExporting(kind)
    const to = todayISO()
    const from = addDays(to, -(range - 1))
    try {
      if (kind === 'json') await exportAll(profile.username)
      else if (kind === 'csv') await exportCsv(from, to, profile.username)
      else {
        const t = trackers.find((x) => x.id === reportTracker) ?? trackers[0]
        if (!t) throw new Error('Create a tracker first.')
        await exportPdf({ trackerId: t.id, trackerName: t.name, from, to, username: profile.username })
      }
      analytics.track('export_downloaded', { format: kind })
      toast.success('Export ready.')
    } catch (e) {
      toast.error(friendlyError(e, 'Export failed.'))
    } finally {
      setExporting(null)
    }
  }

  const pickAccent = (accent: AccentTheme) => {
    if (accent !== 'default' && !requireFeature('custom_themes')) return
    save({ accent_theme: accent })
  }

  const emailStatus = !account ? (
    <span className="text-sm text-muted">Loading…</span>
  ) : account.recovery_email ? (
    <span className="flex min-w-0 items-center gap-1.5 text-sm">
      <MailCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
      <span className="truncate">{account.recovery_email}</span>
      <span className="shrink-0 text-muted">· verified</span>
    </span>
  ) : (
    <span className="text-sm text-danger">Not set — required for login codes and password resets.</span>
  )

  const planLabel = sub.state === 'TRIAL' ? `${sub.plan_name} trial` : sub.state === 'EXPIRED' ? 'Free (paid plan ended)' : sub.plan_name
  const themesOk = hasFeature('custom_themes')
  const on = (iso: string) => formatDate(iso.slice(0, 10), { month: 'long', day: 'numeric', year: 'numeric' })
  const planHint =
    sub.source === 'institution' && sub.expires_at
      ? sub.grace
        ? `${sub.institution_name}’s licence ended on ${on(sub.expires_at)}. Access continues for a short grace period while the school renews.`
        : `Through ${sub.institution_name}’s licence, until ${on(sub.expires_at)}.`
      : sub.isPaid && sub.expires_at
        ? `${renewsAutomatically(sub) ? 'Renews' : 'Ends'} on ${on(sub.expires_at)}`
        : sub.isPaid
          ? `All ${sub.plan_name} features are unlocked.`
          : 'Upgrade to remove ads and limits, or get Pro for reports, focus sounds and more.'

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-muted">Manage your account and preferences.</p>
      </div>

      <Section title="Account">
        <div className="flex items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-lg font-semibold text-brand-ink uppercase">
            {(institutional ? profile.display_name ?? loginEmail : profile.username).slice(0, 1) || <UserRound />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">{institutional ? 'Institutional account' : 'Username'}</p>
            <p className="truncate text-lg font-semibold">{institutional ? profile.display_name ?? loginEmail : profile.username}</p>
            {institutional && <p className="truncate text-sm text-muted">{loginEmail}</p>}
          </div>
          <button type="button" className="btn-secondary" onClick={signOut}>
            <LogOut className="size-4" aria-hidden="true" />
            Log out
          </button>
        </div>
        {!institutional && (
        <>
        <Row label="Username" hint="Friends find you by this name.">
          <button type="button" className="btn-secondary" onClick={() => setDialog('username')}>
            <AtSign className="size-4" aria-hidden="true" />
            Change Username
          </button>
        </Row>
        <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[15px] font-medium">Email</p>
            {emailStatus}
            {account?.pending_email && (
              <p className="mt-1 text-sm break-words text-muted">
                Waiting for confirmation: <span className="font-medium text-ink">{account.pending_email}</span>. Enter the code we emailed you.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setDialog('email')}>
              <Mail className="size-4" aria-hidden="true" />
              {account?.recovery_email ? 'Change email' : account?.pending_email ? 'Enter code' : 'Add email'}
            </button>
          </div>
        </div>
        </>
        )}
        {institutional && (
          <p className="text-sm text-muted">Your sign-in email and name are managed by your institution. Use “Forgot password” on the institution sign-in page if you can’t log in.</p>
        )}
        <div className="border-t border-line pt-5">
          <Row label="Password">
            <button type="button" className="btn-secondary" onClick={() => setDialog('password')}>
              <KeyRound className="size-4" aria-hidden="true" />
              Change password
            </button>
          </Row>
        </div>
      </Section>

      <Section title="Plan">
        <Row
          label={planLabel}
          hint={planHint}
        >
          <button
            type="button"
            className={sub.isPaid ? 'btn-secondary' : 'btn-primary'}
            onClick={() => {
              if (!sub.isPaid) analytics.track('upgrade_clicked', { source: 'settings' })
              navigate('/pro')
            }}
          >
            <Sparkles className="size-4" aria-hidden="true" />
            {sub.isPaid ? 'Manage plan' : 'See plans'}
          </button>
        </Row>
        <div className="border-t border-line pt-5">
          <Row label="Gift or licence code" hint="Got a code from us, a friend or your school? Redeem it for Plus or Pro.">
            <RedeemCodeButton />
          </Row>
        </div>
      </Section>

      <Section title="AI usage" description="How much of each AI feature you can use, and when it resets.">
        <AiUsage />
      </Section>

      <Section title="Appearance">
        <Row label="Theme">
          <Segmented
            label="Theme"
            value={profile.theme}
            onChange={(theme) => save({ theme })}
            options={[
              { value: 'light', label: 'Light', icon: <Sun className="size-4" aria-hidden="true" /> },
              { value: 'dark', label: 'Dark', icon: <Moon className="size-4" aria-hidden="true" /> },
            ]}
          />
        </Row>
        <div>
          <p className="flex items-center gap-2 text-[15px] font-medium">
            Colour theme
            {!themesOk && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-ink">Plus</span>}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Colour theme">
            {ACCENTS.map((a) => {
              const active = (themesOk ? profile.accent_theme : 'default') === a.value
              const locked = a.value !== 'default' && !themesOk
              return (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => pickAccent(a.value)}
                  className={`flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-xs font-medium transition-colors ${
                    active ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line hover:bg-subtle'
                  }`}
                >
                  <span className="flex size-7 items-center justify-center rounded-full" style={{ background: a.swatch }}>
                    {locked && <Lock className="size-3.5 text-white" aria-hidden="true" />}
                  </span>
                  {a.label}
                  {locked && <span className="sr-only"> (Plus)</span>}
                </button>
              )
            })}
          </div>
        </div>
      </Section>

      <Section title="Timetable">
        <Row label="First day of week" hint="Used by the timetable and weekly statistics.">
          <Segmented
            label="First day of week"
            value={profile.week_start}
            onChange={(week_start) => save({ week_start })}
            options={[
              { value: 0, label: 'Sunday' },
              { value: 1, label: 'Monday' },
            ]}
          />
        </Row>
        <Row label="Time format">
          <Segmented
            label="Time format"
            value={profile.time_format}
            onChange={(time_format) => save({ time_format })}
            options={[
              { value: '12h', label: '12-hour' },
              { value: '24h', label: '24-hour' },
            ]}
          />
        </Row>
      </Section>

      {institutional && (
        <Section title="Notifications" description="Choose which school notifications you get in the app, by email and as push notifications.">
          <NotificationPrefs />
        </Section>
      )}

      <Section title="Privacy" description="Your tasks are always private. Choose what friends can see.">
        <Row label="Share my progress with friends" hint="Friends can compare daily totals (completion %, tasks done, focus minutes). Never task names.">
          <Switch label="Share my progress with friends" checked={profile.share_progress} onChange={(v) => save({ share_progress: v })} />
        </Row>
        <Row label="Participate in leaderboards" hint="Show your weekly totals on your friends’ leaderboard. Off by default.">
          <Switch label="Participate in leaderboards" checked={profile.leaderboard_opt_in} onChange={(v) => save({ leaderboard_opt_in: v })} />
        </Row>
        <Row label="Cookies" hint="Choose whether analytics and advertising may be used on this device.">
          <button type="button" className="btn-secondary" onClick={openCookies}>
            <Cookie className="size-4" aria-hidden="true" />
            Cookie Settings
          </button>
        </Row>
      </Section>

      <Section title="Data">
        <Row label="Export all data" hint="Download everything — trackers, tasks, history and focus sessions — as JSON.">
          <button type="button" className="btn-secondary" onClick={() => onExport('json')} disabled={exporting !== null}>
            {exporting === 'json' ? <Spinner className="size-4" /> : <Download className="size-4" aria-hidden="true" />}
            Export
          </button>
        </Row>
        <div className="space-y-4 border-t border-line pt-5">
          <p className="flex items-center gap-2 text-[15px] font-medium">
            Reports
            {!hasFeature('csv_export') && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-ink">Pro</span>}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="export-range" className="field-label">
                Date range
              </label>
              <select id="export-range" className="input" value={range} onChange={(e) => setRange(Number(e.target.value))}>
                {EXPORT_RANGES.map((r) => (
                  <option key={r.days} value={r.days}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="export-tracker" className="field-label">
                Tracker (PDF report)
              </label>
              <select id="export-tracker" className="input" value={reportTracker} onChange={(e) => setReportTracker(e.target.value)} disabled={!trackers.length}>
                {trackers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => onExport('csv')} disabled={exporting !== null}>
              {exporting === 'csv' ? <Spinner className="size-4" /> : <FileSpreadsheet className="size-4" aria-hidden="true" />}
              CSV export
            </button>
            <button type="button" className="btn-secondary" onClick={() => onExport('pdf')} disabled={exporting !== null || !trackers.length}>
              {exporting === 'pdf' ? <Spinner className="size-4" /> : <FileText className="size-4" aria-hidden="true" />}
              PDF report
            </button>
          </div>
          {!hasFeature('csv_export') && <p className="text-sm text-muted">PDF/CSV export is a Pro feature.</p>}
        </div>
        <div className="border-t border-line pt-5">
          <Row label="Delete account" hint="Deleting your account permanently removes your trackers, tasks, progress, and account data.">
            <button type="button" className="btn border border-danger/40 text-danger hover:bg-danger-soft" onClick={() => setDialog('delete')}>
              <Trash2 className="size-4" aria-hidden="true" />
              Delete account
            </button>
          </Row>
        </div>
      </Section>

      {appConfig.supportUrl && (
        <Section title={appConfig.supportLabel}>
          <Row label="Enjoying HabbitFlows?" hint="It’s built by an independent developer. Support is optional and doesn’t change your plan.">
            <a href={appConfig.supportUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary">
              <Heart className="size-4" aria-hidden="true" />
              {appConfig.supportLabel}
            </a>
          </Row>
        </Section>
      )}

      <div className="md:hidden">
        <SiteFooter compact />
      </div>

      <ChangeUsernameDialog open={dialog === 'username'} onClose={() => setDialog(null)} />
      <RecoveryEmailDialog open={dialog === 'email'} onClose={() => setDialog(null)} current={account?.recovery_email ?? null} pending={account?.pending_email ?? null} onSaved={loadAccount} />
      <RemoveEmailDialog open={dialog === 'remove-email'} onClose={() => setDialog(null)} onSaved={loadAccount} />
      <ChangePasswordDialog open={dialog === 'password'} onClose={() => setDialog(null)} />
      <DeleteAccountDialog open={dialog === 'delete'} onClose={() => setDialog(null)} />
    </div>
  )
}
