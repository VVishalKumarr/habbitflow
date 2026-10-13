import { AlertCircle, MailCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { cleanCodeInput, confirmEmailCode, emailConfigured, sendEmailCode } from '../../lib/emailCodes'
import { FunctionError } from '../../lib/functions'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../store/auth'
import { toast } from '../../store/ui'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** Accounts created before email became compulsory may postpone adding one until this date. */
export const EMAIL_REQUIRED_SINCE = '2026-10-14T00:00:00Z'
export const EMAIL_GRACE_UNTIL = '2026-10-28T00:00:00Z'

/**
 * Add or change the account's email: enter it, get a 6-digit code, enter the
 * code. The current password is asked only when replacing a confirmed email.
 */
export function EmailSetupForm({ current, pending, onDone, onCancel, cancelLabel = 'Cancel' }: {
  current: string | null
  pending: string | null
  onDone: (email: string) => void
  onCancel?: () => void
  cancelLabel?: string
}) {
  const [step, setStep] = useState<'email' | 'code'>(pending ? 'code' : 'email')
  const [email, setEmail] = useState(pending ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string; code?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const next: typeof errors = {}
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.'
    if (current && !password) next.password = 'Enter your current password.'
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    try {
      await sendEmailCode(email, current ? password : undefined)
      setStep('code')
      setCode('')
      toast.success(`We sent a 6-digit code to ${email.trim()}.`)
    } catch (err) {
      const f = err as FunctionError
      if (f.status === 403) setErrors({ password: f.message })
      else setErrors({ form: f.message })
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (e?: FormEvent) => {
    e?.preventDefault()
    if (code.length !== 6) return setErrors({ code: 'Enter the 6-digit code from the email.' })
    setBusy(true)
    try {
      const r = await confirmEmailCode(code)
      toast.success(`Email confirmed: ${r.email}`)
      onDone(r.email)
    } catch (err) {
      setErrors({ code: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const formError = errors.form && (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {errors.form}
    </div>
  )
  const actions = (submitLabel: string) => (
    <div className="flex flex-wrap justify-end gap-2 pt-1">
      {onCancel && (
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      )}
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy && <Spinner className="size-4" />}
        {submitLabel}
      </button>
    </div>
  )

  if (step === 'code') {
    return (
      <form onSubmit={confirm} noValidate className="space-y-4">
        {formError}
        <p className="flex items-start gap-2.5 rounded-xl bg-subtle px-3.5 py-3 text-sm">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <span>
            We sent a 6-digit code to <strong className="font-semibold">{email.trim()}</strong>. It expires in 15 minutes.
          </span>
        </p>
        <Field label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(cleanCodeInput(e.target.value))} error={errors.code} />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => send()} disabled={busy}>
            Send a new code
          </button>
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => setStep('email')} disabled={busy}>
            Use a different email
          </button>
        </div>
        {actions('Confirm email')}
      </form>
    )
  }

  return (
    <form onSubmit={send} noValidate className="space-y-4">
      {formError}
      <Field label="Email address" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      {current && (
        <Field label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
      )}
      {actions('Send code')}
    </form>
  )
}

interface AccountEmail {
  account_type: 'individual' | 'institutional'
  created_at: string
  recovery_email: string | null
  email_verified: boolean
  pending_email: string | null
}

const DISMISS_KEY = 'habitflow-email-later'

/**
 * Personal accounts must have a confirmed email (for login codes and password
 * resets). Shown after login until it's done; accounts from before email was
 * required can choose "Later" until the grace date. Never shown before the
 * server can send email.
 */
export function EmailGate() {
  const profileId = useAuth((s) => s.profile?.id)
  const [account, setAccount] = useState<AccountEmail | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!profileId) return
    let alive = true
    Promise.all([supabase.rpc('my_account'), emailConfigured()]).then(([acct, configured]) => {
      if (alive && configured && acct.data) setAccount(acct.data as AccountEmail)
    })
    return () => {
      alive = false
    }
  }, [profileId])

  if (!account || account.account_type !== 'individual' || account.email_verified) return null
  const canWait = Date.parse(account.created_at) < Date.parse(EMAIL_REQUIRED_SINCE) && Date.now() < Date.parse(EMAIL_GRACE_UNTIL)
  if (canWait && dismissed) return null

  const later = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* storage unavailable */
    }
    setDismissed(true)
  }
  const graceDate = new Date(EMAIL_GRACE_UNTIL).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

  return (
    <Modal
      open
      onClose={canWait ? later : () => {}}
      title="Confirm your email"
      subtitle={
        canWait
          ? `HabbitFlows now needs an email on every account — for logging in with a code and resetting your password. Please add one before ${graceDate}.`
          : 'Your account needs a confirmed email — for logging in with a code and resetting your password.'
      }
    >
      <EmailSetupForm
        current={null}
        pending={account.pending_email}
        onDone={(email) => setAccount({ ...account, recovery_email: email, email_verified: true, pending_email: null })}
        onCancel={canWait ? later : undefined}
        cancelLabel="Later"
      />
    </Modal>
  )
}
