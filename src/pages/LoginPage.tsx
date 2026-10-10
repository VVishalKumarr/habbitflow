import { AlertCircle, Building2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Field } from '../components/ui/Field'
import { Spinner } from '../components/ui/Spinner'
import { analytics } from '../lib/analytics'
import { normalizeUsername } from '../lib/auth'
import { useAuth } from '../store/auth'
import { AuthLayout } from './AuthLayout'

export default function LoginPage() {
  const signIn = useAuth((s) => s.signIn)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!normalizeUsername(username)) next.username = 'Username is required.'
    else if (username.includes('@')) next.username = 'Personal accounts use a username. For a school or college email, choose Institution above.'
    if (!password) next.password = 'Password is required.'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length) return
    setBusy(true)
    try {
      await signIn(username, password)
      analytics.track('login')
      // The route guard redirects once the session is picked up.
    } catch (err) {
      setFormError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Log in to continue with your routines.">
      <div className="mb-6 flex rounded-xl bg-subtle p-1 text-sm font-medium" role="tablist" aria-label="Account type">
        <span role="tab" aria-selected="true" className="flex h-9 flex-1 items-center justify-center rounded-lg bg-surface text-ink shadow-card">
          Personal
        </span>
        <Link to="/login/institution" role="tab" aria-selected="false" className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-muted hover:text-ink">
          <Building2 className="size-4" aria-hidden="true" />
          Institution
        </Link>
      </div>
      <form onSubmit={submit} noValidate className="space-y-5">
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
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
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
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <Link to="/register" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  )
}
