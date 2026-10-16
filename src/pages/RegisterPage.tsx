import { AlertCircle, Info } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Captcha, captchaEnabled, type CaptchaHandle } from '../components/auth/Captcha'
import { Field } from '../components/ui/Field'
import { Spinner } from '../components/ui/Spinner'
import { analytics } from '../lib/analytics'
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, validatePassword, validateUsername } from '../lib/auth'
import { sendEmailCode } from '../lib/emailCodes'
import { useAuth } from '../store/auth'
import { toast } from '../store/ui'
import { AuthLayout } from './AuthLayout'

type Errors = { username?: string; password?: string; confirm?: string; email?: string }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export default function RegisterPage() {
  const signUp = useAuth((s) => s.signUp)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const started = useRef(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const captcha = useRef<CaptchaHandle>(null)

  const onStart = () => {
    if (started.current) return
    started.current = true
    analytics.track('signup_started')
  }

  const validate = (): Errors => {
    const next: Errors = {}
    const u = validateUsername(username)
    const p = validatePassword(password)
    if (u) next.username = u
    if (p) next.password = p
    if (!confirm) next.confirm = 'Please confirm your password.'
    else if (confirm !== password) next.confirm = 'Passwords do not match.'
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter your email address. You’ll confirm it with a code.'
    return next
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next = validate()
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length) return
    if (captchaEnabled && !captchaToken) {
      setFormError('Please complete the security check.')
      return
    }
    setBusy(true)
    try {
      await signUp(username, password, captchaToken ?? undefined)
      analytics.track('signup_completed', { source: 'with_email' })
    } catch (err) {
      const message = (err as Error).message
      if (/username/i.test(message)) setErrors({ username: message })
      else setFormError(message)
      captcha.current?.reset()
      setBusy(false)
      return
    }
    // The account exists now. Send the confirmation code; the app asks for it
    // straight away (EmailGate) and keeps asking until the email is confirmed.
    sendEmailCode(email)
      .then(() => toast.success(`We sent a 6-digit code to ${email.trim()}. Enter it to confirm your email.`))
      .catch((err: Error & { code?: string }) => {
        if (err.code !== 'email_not_configured') toast.info(`Your account is ready, but we couldn’t send the code: ${err.message} You can send it again in a moment.`)
      })
  }

  return (
    <AuthLayout title="Create your account" subtitle="A username, a password and your email.">
      <form onSubmit={submit} onFocus={onStart} noValidate className="space-y-5">
        {formError && (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </div>
        )}
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={USERNAME_MAX}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
          hint={`${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers, . _ -`}
          required
        />
        <Field
          label="Password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={`At least ${PASSWORD_MIN} characters.`}
          required
        />
        <Field
          label="Confirm password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
          required
        />
        <div>
          <Field
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <p className="mt-2 flex items-start gap-2 text-sm text-muted">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            We’ll send a code to confirm it. You can then log in with a code instead of your password, and reset your password if you forget it.
          </p>
        </div>
        <Captcha ref={captcha} onToken={setCaptchaToken} />
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        <p className="text-center text-xs text-muted">
          By creating an account you agree to the{' '}
          <Link to="/terms" className="underline hover:text-ink">
            Terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="underline hover:text-ink">
            Privacy Policy
          </Link>
          .
        </p>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand hover:underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  )
}
