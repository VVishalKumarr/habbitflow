import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Field } from '../components/ui/Field'
import { Spinner } from '../components/ui/Spinner'
import { PASSWORD_MIN, validatePassword } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { AuthLayout } from './AuthLayout'

type Stage = 'verifying' | 'ready' | 'invalid' | 'done'

/**
 * Opened from the reset email: /reset-password?token_hash=…&type=recovery.
 * The one-time token is verified by Supabase Auth (it expires and can't be
 * reused). The token is removed from the address bar immediately.
 */
export default function ResetPasswordPage() {
  const [stage, setStage] = useState<Stage>('verifying')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const once = useRef(false)

  useEffect(() => {
    if (once.current) return
    once.current = true
    const params = new URLSearchParams(window.location.search)
    const tokenHash = params.get('token_hash')
    window.history.replaceState(null, '', window.location.pathname)
    if (!tokenHash || params.get('type') !== 'recovery') {
      setStage('invalid')
      return
    }
    supabase.auth
      .verifyOtp({ token_hash: tokenHash, type: 'recovery' })
      .then(({ error }) => setStage(error ? 'invalid' : 'ready'))
      .catch(() => setStage('invalid'))
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    const p = validatePassword(password)
    if (p) next.password = p
    if (confirm !== password) next.confirm = 'Passwords do not match.'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length) return
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setFormError(/same|different/i.test(error.message) ? 'Choose a password you haven’t used for this account.' : error.message)
      setBusy(false)
      return
    }
    // Sign out everywhere so the new password is needed from now on.
    await supabase.auth.signOut({ scope: 'global' }).catch(() => {})
    setStage('done')
    setBusy(false)
  }

  if (stage === 'verifying') {
    return (
      <AuthLayout title="Reset Password" subtitle="Checking your reset link…">
        <div className="flex justify-center py-6 text-muted" role="status">
          <Spinner />
        </div>
      </AuthLayout>
    )
  }

  if (stage === 'invalid') {
    return (
      <AuthLayout title="Link expired" subtitle="This reset link is invalid, already used, or has expired.">
        <Link to="/forgot-password" className="btn-primary h-11 w-full">
          Request a new link
        </Link>
      </AuthLayout>
    )
  }

  if (stage === 'done') {
    return (
      <AuthLayout title="Password changed" subtitle="You can now log in with your new password.">
        <div role="status" className="mb-6 flex items-start gap-3 rounded-xl bg-success-soft px-4 py-3.5 text-[15px]">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          Your password has been changed.
        </div>
        <Link to="/login" className="btn-primary h-11 w-full">
          Back to Login
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Reset Password" subtitle="Choose a new password for your account.">
      <form onSubmit={submit} noValidate className="space-y-5">
        {formError && (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </div>
        )}
        <Field
          label="New Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint={`At least ${PASSWORD_MIN} characters.`}
        />
        <Field
          label="Confirm New Password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          Reset Password
        </button>
      </form>
    </AuthLayout>
  )
}
