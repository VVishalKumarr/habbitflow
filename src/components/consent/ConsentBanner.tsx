import { Cookie } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adsConfig, analyticsConfig } from '../../config'
import { isNative } from '../../lib/native'
import { useConsent } from '../../store/consent'
import { Modal } from '../ui/Modal'

function Toggle({ id, label, description, checked, disabled, onChange }: { id: string; label: string; description: string; checked: boolean; disabled?: boolean; onChange?: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line p-4">
      <div className="min-w-0">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <p className="mt-0.5 text-sm text-muted">{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${checked ? 'bg-brand' : 'bg-line'}`}
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] ${checked ? 'left-[22px]' : 'left-0.5'}`} aria-hidden="true" />
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

export { Toggle as SwitchRow }

/** Cookie Settings dialog (opened from the banner or the footer). */
export function CookieSettingsModal() {
  const open = useConsent((s) => s.settingsOpen)
  const close = useConsent((s) => s.closeSettings)
  const save = useConsent((s) => s.save)
  // (zustand v5: never select a fresh object; read the snapshot instead)
  const [draft, setDraft] = useState(() => ({ analytics: useConsent.getState().analytics, advertising: useConsent.getState().advertising }))
  useEffect(() => {
    if (open) setDraft({ analytics: useConsent.getState().analytics, advertising: useConsent.getState().advertising })
  }, [open])

  const hasAnalytics = analyticsConfig.provider !== 'none'
  const hasAds = !isNative && Boolean(adsConfig.adsenseClientId)

  return (
    <Modal
      open={open}
      onClose={close}
      title="Privacy & Cookies"
      subtitle="Choose which optional technologies HabitFlow may use on this device."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={() => save({ analytics: false, advertising: false })}>
            Reject Optional
          </button>
          <button type="button" className="btn-primary" onClick={() => save(draft)}>
            Save Preferences
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Toggle id="c-necessary" label="Necessary" description="Keeps you signed in and remembers settings like this one. Always enabled." checked disabled />
        <Toggle
          id="c-analytics"
          label="Analytics"
          description={
            hasAnalytics
              ? `Anonymous usage statistics (${analyticsConfig.provider === 'plausible' ? 'Plausible' : 'Umami'}) that help us improve the app. No passwords, task contents or account details.`
              : 'Not used at the moment.'
          }
          checked={hasAnalytics && draft.analytics}
          disabled={!hasAnalytics}
          onChange={(v) => setDraft({ ...draft, analytics: v })}
        />
        <Toggle
          id="c-ads"
          label="Advertising"
          description={hasAds ? 'Google AdSense ads on a few pages (never on the timer or account pages). Paying members see no ads.' : 'Not used at the moment.'}
          checked={hasAds && draft.advertising}
          disabled={!hasAds}
          onChange={(v) => setDraft({ ...draft, advertising: v })}
        />
        <p className="pt-1 text-sm text-muted">
          More in our{' '}
          <Link to="/privacy" className="text-brand underline" onClick={close}>
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </Modal>
  )
}

/** First-visit banner, shown only when optional technologies are configured and consent is needed. */
export function ConsentBanner() {
  const decided = useConsent((s) => s.decided)
  const settingsOpen = useConsent((s) => s.settingsOpen)
  const save = useConsent((s) => s.save)
  const openSettings = useConsent((s) => s.openSettings)
  if (decided || settingsOpen) return null

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 mx-auto max-w-2xl rounded-2xl border border-line bg-surface p-4 shadow-pop sm:bottom-4 sm:p-5 md:bottom-6"
    >
      <div className="flex items-start gap-3">
        <Cookie className="mt-0.5 hidden size-5 shrink-0 text-brand sm:block" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">Privacy &amp; Cookies</p>
          <p className="mt-1 text-sm text-muted">
            We use necessary cookies to operate the service. With your permission, analytics and advertising technologies may also be used.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={openSettings}>
          Manage Preferences
        </button>
        <button type="button" className="btn-secondary" onClick={() => save({ analytics: false, advertising: false })}>
          Reject Optional
        </button>
        <button type="button" className="btn-primary" onClick={() => save({ analytics: true, advertising: true })}>
          Accept All
        </button>
      </div>
    </div>
  )
}
