import { Gift } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { formatDate } from '../../lib/dates'
import { useSubscriptionStore } from '../../store/subscription'
import { toast } from '../../store/ui'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

/** "Redeem a code" button + dialog for gift codes and personal licence codes. The server validates everything. */
export function RedeemCodeButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <Gift className="size-4" aria-hidden="true" />
        Redeem a code
      </button>
      {open && <RedeemCodeModal onClose={() => setOpen(false)} />}
    </>
  )
}

function RedeemCodeModal({ onClose }: { onClose: () => void }) {
  const redeem = useSubscriptionStore((s) => s.redeem)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (code.replace(/[^a-z0-9]/gi, '').length < 10) return setError('Enter the whole code, e.g. HFG-7KQ2-MX9P-4TRW-ZC8N.')
    setBusy(true)
    setError(null)
    try {
      const r = await redeem(code)
      toast.success(`${r.plan_name} is active until ${formatDate(r.expires_at.slice(0, 10), { month: 'long', day: 'numeric', year: 'numeric' })}.`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Redeem a code"
      subtitle="Gift codes and licence codes unlock Plus or Pro for a set time. Codes for the same plan add up."
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="redeem-code" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Redeem
          </button>
        </>
      }
    >
      <form id="redeem-code" onSubmit={submit}>
        <Field
          label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          error={error ?? undefined}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          placeholder="HFG-XXXX-XXXX-XXXX-XXXX"
        />
      </form>
    </Modal>
  )
}
