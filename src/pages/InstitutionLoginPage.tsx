import { AlertCircle, Building2 } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Captcha, captchaEnabled, type CaptchaHandle } from '../components/auth/Captcha'
import { EmailCodeLogin, LoginMethodSwitch } from '../components/auth/EmailCodeLogin'
import { Field } from '../components/ui/Field'
import { Spinner } from '../components/ui/Spinner'
import { analytics } from '../lib/analytics'
import { useAuth } from '../store/auth'
import { AuthLayout } from './AuthLayout'

/** Sign-in for school, college and coaching-centre accounts (approved email + password). */
export default function InstitutionLoginPage() {
  const signIn = useAuth((s) => s.signInInstitution)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [method, setMethod] = useState<'password' | 'code'>('password')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const captcha = useRef<CaptchaHandle>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) next.email = 'Enter your institutional email address.'
    if (!password) next.password = 'Password is required.'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length) return
    if (captchaEnabled && !captchaToken) {
      setFormError('Please complete the security check.')
      return
    }
    setBusy(true)
    try {
      await signIn(email, password, captchaToken ?? undefined)
      analytics.track('login', { kind: 'institution' })
    } catch (err) {
      setFormError((err as Error).message)
      captcha.current?.reset()
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="School & college sign-in" subtitle="Use the email address your institution registered for you.">
      <div className="mb-6 flex rounded-xl bg-subtle p-1 text-sm font-medium" role="tablist" aria-label="Account type">
        <Link to="/login" role="tab" aria-selected="false" className="flex h-9 flex-1 items-center justify-center rounded-lg text-muted hover:text-ink">
          Personal
        </Link>
        <span role="tab" aria-selected="true" className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-surface text-ink shadow-card">
          <Building2 className="size-4" aria-hidden="true" />
          Institution
        </span>
      </div>
      <LoginMethodSwitch value={method} onChange={setMethod} />
      {method === 'code' ? (
        <EmailCodeLogin identifierLabel="Institutional email" kind="institution" />
      ) : (
      <form onSubmit={submit} noValidate className="space-y-5">
        {formError && (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </div>
        )}
        <Field
          label="Institutional email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <div className="-mt-2 text-right">
          <Link to="/forgot-password" className="text-sm font-medium text-brand hover:underline">
            Forgot password?
          </Link>
        </div>
        <Captcha ref={captcha} onToken={setCaptchaToken} />
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      )}
      <p className="mt-6 text-center text-sm text-muted">
        No account yet? Your institution sends you an activation email. Institutional accounts can’t be created here.
      </p>
    </AuthLayout>
  )
}
