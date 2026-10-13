import { AlertTriangle } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { normalizeUsername, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, validatePassword, validateUsername } from '../../lib/auth'
import { friendlyError } from '../../lib/errors'
import { callFunction, FunctionError } from '../../lib/functions'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../store/auth'
import { toast } from '../../store/ui'
import { EmailSetupForm } from '../auth/EmailSetup'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

function Dialog({ open, onClose, title, subtitle, submitLabel, busy, danger, onSubmit, children }: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  submitLabel: string
  busy: boolean
  danger?: boolean
  onSubmit: () => void
  children: ReactNode
}) {
  const id = `form-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={id} className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            {submitLabel}
          </button>
        </>
      }
    >
      <form
        id={id}
        noValidate
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        {children}
      </form>
    </Modal>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export function ChangeUsernameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = useAuth((s) => s.profile?.username ?? '')
  const setUsername = useAuth((s) => s.setUsername)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({})
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const next: typeof errors = {}
    const v = validateUsername(name)
    if (v) next.name = v
    else if (normalizeUsername(name) === current) next.name = 'That is already your username.'
    if (!password) next.password = 'Enter your current password.'
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    const { data, error } = await supabase.rpc('change_username', { p_new: normalizeUsername(name), p_password: password })
    setBusy(false)
    if (error) {
      const msg = friendlyError(error)
      setErrors(/password|attempts/i.test(msg) ? { password: msg } : { name: msg })
      return
    }
    const res = data as { ok: boolean; username?: string; error?: string }
    if (!res.ok) {
      setErrors({ password: res.error ?? 'Current password is incorrect.' })
      return
    }
    setUsername(res.username!)
    toast.success(`Your username is now “${res.username}”. Use it next time you log in.`)
    setName('')
    setPassword('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Change Username" subtitle="Same account — your trackers, history, friends and plan stay as they are." submitLabel="Change Username" busy={busy} onSubmit={submit}>
      <Field label="Current username" value={current} readOnly disabled />
      <Field
        label="New Username"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        hint={`${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers, . _ -`}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={USERNAME_MAX}
        autoComplete="off"
      />
      <Field label="Current Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
    </Dialog>
  )
}

export function RecoveryEmailDialog({ open, onClose, current, pending, onSaved }: {
  open: boolean
  onClose: () => void
  current: string | null
  pending?: string | null
  onSaved: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={current ? 'Change Email' : 'Add Email'}
      subtitle={current ? `Your current address (${current}) stays active until the new one is confirmed.` : 'Used for logging in with a code and resetting your password.'}
    >
      {open && (
        <EmailSetupForm
          current={current}
          pending={pending ?? null}
          onDone={() => {
            onSaved()
            onClose()
          }}
          onCancel={onClose}
        />
      )}
    </Modal>
  )
}

export function RemoveEmailDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!password) return setError('Enter your current password.')
    setBusy(true)
    const { data, error: err } = await supabase.rpc('remove_recovery_email', { p_password: password })
    setBusy(false)
    if (err) return setError(friendlyError(err))
    if (!data) return setError('Current password is incorrect.')
    toast.success('Recovery email removed.')
    setPassword('')
    onSaved()
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Remove Recovery Email" submitLabel="Remove email" busy={busy} danger onSubmit={submit}>
      <Warning>Without a recovery email, you may not be able to recover your account if you forget your password.</Warning>
      <Field label="Current Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} />
    </Dialog>
  )
}

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({})
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const e: typeof errors = {}
    if (!current) e.current = 'Enter your current password.'
    const v = validatePassword(next)
    if (v) e.next = v
    else if (next === current) e.next = 'Choose a different password.'
    if (confirm !== next) e.confirm = 'Passwords do not match.'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const { data: ok, error } = await supabase.rpc('check_password', { p_password: current })
    if (error || !ok) {
      setBusy(false)
      return setErrors({ current: error ? friendlyError(error) : 'Current password is incorrect.' })
    }
    const { error: upd } = await supabase.auth.updateUser({ password: next })
    setBusy(false)
    if (upd) return setErrors({ next: upd.message })
    toast.success('Your password has been changed.')
    setCurrent('')
    setNext('')
    setConfirm('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Change Password" submitLabel="Change password" busy={busy} onSubmit={submit}>
      <Field label="Current Password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} />
      <Field label="New Password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={errors.next} hint={`At least ${PASSWORD_MIN} characters.`} />
      <Field label="Confirm New Password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
    </Dialog>
  )
}

export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const username = useAuth((s) => s.profile?.username ?? '')
  const signOut = useAuth((s) => s.signOut)
  const [password, setPassword] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!password) return setError('Enter your current password.')
    if (typed.trim().toLowerCase() !== username) return setError(`Type “${username}” exactly to confirm.`)
    setError(null)
    setBusy(true)
    try {
      try {
        // Preferred: server function also cancels an active web subscription.
        await callFunction('delete-account', { password })
      } catch (e) {
        const err = e as FunctionError
        if (err.status !== 0 && err.status !== 404) throw err
        // Function not deployed: database-only deletion (refuses if a paid subscription is active).
        const { data, error: rpcErr } = await supabase.rpc('delete_account_confirmed', { p_password: password })
        if (rpcErr) throw new Error(friendlyError(rpcErr))
        if (!data) throw new FunctionError('Current password is incorrect.', 403)
      }
      toast.success('Your account has been deleted.')
      await signOut().catch(() => {})
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Delete Account" submitLabel="Delete forever" busy={busy} danger onSubmit={submit}>
      <Warning>Deleting your account permanently removes your trackers, tasks, progress, focus sessions, friends and account data. This can’t be undone.</Warning>
      <p className="text-sm text-muted">If you have Pro through Google Play, cancel it in Google Play first — Google handles those subscriptions.</p>
      <Field label="Current Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Field label={`Type “${username}” to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="none" autoComplete="off" error={error} />
    </Dialog>
  )
}
