import { AlertCircle, MailCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { analytics } from '../../lib/analytics'
import { cleanCodeInput, sendLoginCode, verifyLoginCode } from '../../lib/emailCodes'
import { Field } from '../ui/Field'
import { Spinner } from '../ui/Spinner'

/** Log in with a 6-digit code sent to the account's email (no password). */
export function EmailCodeLogin({ identifierLabel, placeholder, kind }: { identifierLabel: string; placeholder?: string; kind: 'personal' | 'institution' }) {
  const [identifier, setIdentifier] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [choices, setChoices] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (identifier.trim().length < 3) return setError(`Enter your ${identifierLabel.toLowerCase()}.`)
    setBusy(true)
    setError(null)
    try {
      const r = await sendLoginCode(identifier)
      setRequestId(r.request_id)
      setCode('')
      setChoices(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const verify = async (e?: FormEvent, username?: string) => {
    e?.preventDefault()
    if (code.length !== 6) return setError('Enter the 6-digit code from the email.')
    setBusy(true)
    setError(null)
    try {
      const r = await verifyLoginCode(requestId!, code, username)
      if (r.choose) {
        setChoices(r.choose)
        setBusy(false)
        return
      }
      analytics.track('login', { kind, method: 'email_code' })
      // The route guard redirects once the session is picked up.
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const alert = error && (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {error}
    </div>
  )

  if (choices) {
    return (
      <div className="space-y-4">
        {alert}
        <p className="text-sm text-muted">This email belongs to more than one account. Which one do you want to log in to?</p>
        <ul className="space-y-2">
          {choices.map((u) => (
            <li key={u}>
              <button type="button" className="btn-secondary h-11 w-full justify-start" disabled={busy} onClick={() => verify(undefined, u)}>
                {u}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (requestId) {
    return (
      <form onSubmit={verify} noValidate className="space-y-5">
        {alert}
        <p className="flex items-start gap-2.5 rounded-xl bg-subtle px-3.5 py-3 text-sm">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <span>
            If <strong className="font-semibold">{identifier.trim()}</strong> has a confirmed email, we’ve sent it a 6-digit code. It expires in 10 minutes.
          </span>
        </p>
        <Field
          label="6-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(cleanCodeInput(e.target.value))}
        />
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          {busy ? 'Checking…' : 'Log in'}
        </button>
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => setRequestId(null)} disabled={busy}>
            Use a different {kind === 'institution' ? 'email' : 'username or email'}
          </button>
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => send()} disabled={busy}>
            Send a new code
          </button>
        </div>
      </form>
    )
  }

  return (
    <form onSubmit={send} noValidate className="space-y-5">
      {alert}
      <Field
        label={identifierLabel}
        name="identifier"
        type={kind === 'institution' ? 'email' : 'text'}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder}
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
      />
      <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
        {busy && <Spinner className="size-4" />}
        {busy ? 'Sending…' : 'Email me a code'}
      </button>
    </form>
  )
}

/** Password / email code switch shown above a login form. */
export function LoginMethodSwitch({ value, onChange }: { value: 'password' | 'code'; onChange: (v: 'password' | 'code') => void }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-line p-1 text-sm font-medium" role="radiogroup" aria-label="How to log in">
      {(['password', 'code'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={`h-9 rounded-lg ${value === m ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:text-ink'}`}
        >
          {m === 'password' ? 'Password' : 'Email code'}
        </button>
      ))}
    </div>
  )
}
