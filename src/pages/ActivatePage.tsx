import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Field } from '../components/ui/Field'
import { FullPageLoader, Spinner } from '../components/ui/Spinner'
import { validatePassword } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { callFunction, FunctionError } from '../lib/functions'
import { ROLE_LABEL, type InstRole } from '../lib/institution'
import { supabase } from '../lib/supabase'
import { useAuth } from '../store/auth'
import { useInstitutionStore } from '../store/institution'
import { AuthLayout } from './AuthLayout'

interface InvitationSummary {
  email: string
  role: InstRole
  display_name: string
  institution: string
  account_exists: boolean
}

/** Opened from the invitation email: confirms the address and sets the password. */
export default function ActivatePage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const status = useAuth((s) => s.status)
  const sessionEmail = useAuth((s) => s.session?.user.email)
  const signIn = useAuth((s) => s.signInInstitution)
  const [invite, setInvite] = useState<InvitationSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) {
      setLoadError('This activation link is incomplete. Open the link from your invitation email again.')
      return
    }
    callFunction<{ invitation: InvitationSummary }>('institution-activate', { action: 'inspect', token })
      .then((r) => setInvite(r.invitation))
      .catch((e) => setLoadError((e as Error).message))
  }, [token])

  const activate = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    const pwError = validatePassword(password)
    if (pwError) next.password = pwError
    else if (password !== confirm) next.confirm = 'Passwords don’t match.'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length || !invite) return
    setBusy(true)
    try {
      await callFunction('institution-activate', { action: 'activate', token, password })
      await signIn(invite.email, password)
      navigate('/school', { replace: true })
    } catch (err) {
      setFormError(err instanceof FunctionError ? err.message : friendlyError(err))
      setBusy(false)
    }
  }

  // Already has an institutional account: accept while signed in with that address.
  const accept = async () => {
    setBusy(true)
    setFormError(null)
    const { error } = await supabase.rpc('accept_invitation', { p_token: token })
    if (error) {
      setFormError(friendlyError(error))
      setBusy(false)
      return
    }
    await useInstitutionStore.getState().load()
    navigate('/school', { replace: true })
  }

  if (!invite && !loadError) return <FullPageLoader label="Checking your invitation…" />

  if (loadError || !invite) {
    return (
      <AuthLayout title="Activation link problem" subtitle="We couldn’t use this link.">
        <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {loadError}
        </div>
        <p className="mt-6 text-sm text-muted">
          Already activated? <Link to="/login/institution" className="font-medium text-brand hover:underline">Sign in</Link>.
        </p>
      </AuthLayout>
    )
  }

  const subtitle = `${invite.institution} invited ${invite.display_name} as ${ROLE_LABEL[invite.role]}.`

  if (invite.account_exists) {
    const signedInAsInvitee = status === 'authenticated' && sessionEmail?.toLowerCase() === invite.email
    return (
      <AuthLayout title="Accept invitation" subtitle={subtitle}>
        {formError && (
          <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </div>
        )}
        {signedInAsInvitee ? (
          <button type="button" className="btn-primary h-11 w-full" onClick={accept} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Join {invite.institution}
          </button>
        ) : (
          <p className="text-sm text-muted">
            You already have an account with <strong className="text-ink">{invite.email}</strong>.{' '}
            <Link to="/login/institution" className="font-medium text-brand hover:underline">
              Sign in with it
            </Link>
            , then open this link again to join.
          </p>
        )}
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Activate your account" subtitle={subtitle}>
      <form onSubmit={activate} noValidate className="space-y-5">
        {formError && (
          <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </div>
        )}
        <div className="flex items-start gap-2.5 rounded-xl bg-success-soft px-3.5 py-3 text-sm text-success">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Opening this link confirmed <strong>{invite.email}</strong>. You’ll sign in with this address.
          </span>
        </div>
        <Field
          label="Choose a password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint="At least 8 characters."
        />
        <Field
          label="Confirm password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          {busy ? 'Activating…' : 'Activate account'}
        </button>
      </form>
    </AuthLayout>
  )
}
