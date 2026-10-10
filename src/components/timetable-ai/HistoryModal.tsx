import { Bot, Mic, RotateCcw, Shuffle, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { friendlyError } from '../../lib/errors'
import { loadHistory, undoable, undoChange, type ChangeRow } from '../../lib/timetableAi'
import { useTrackerData } from '../../store/trackerData'
import { toast } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

const ICON = { ai_generate: Bot, ai_reschedule: Shuffle, voice: Mic, undo: RotateCcw }
const SOURCE = { ai_generate: 'AI timetable builder', ai_reschedule: 'Rescheduling', voice: 'Command', undo: 'Undo' }

/** Changes made by the AI assistant and commands, newest first. The newest can be undone. */
export function HistoryModal({ open, onClose, trackerId }: { open: boolean; onClose: () => void; trackerId: string }) {
  const [rows, setRows] = useState<ChangeRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setError(null)
    loadHistory(trackerId).then(setRows, (e) => setError(friendlyError(e)))
  }, [trackerId])

  useEffect(() => {
    if (open) {
      setRows(null)
      load()
    }
  }, [open, load])

  const canUndo = rows ? undoable(rows) : null

  const undo = async (id: string) => {
    setBusy(true)
    try {
      await undoChange(id)
      await useTrackerData.getState().refresh()
      toast.success('Change undone.')
      load()
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Timetable history" subtitle="Changes made with the AI assistant and commands."
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {error && <p className="rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-danger" role="alert">{error}</p>}
      {!rows && !error && <p className="flex justify-center py-10"><Spinner /></p>}
      {rows && rows.length === 0 && <p className="py-6 text-center text-sm text-muted">No AI changes to this timetable yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const Icon = ICON[r.source]
            return (
              <li key={r.id} className="flex items-start gap-3 py-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1 text-sm">
                  <p className={`break-words ${r.undone_at ? 'text-muted line-through' : ''}`}>{r.summary}</p>
                  <p className="text-xs text-muted">
                    {SOURCE[r.source]} · {new Date(r.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    {r.undone_at && ' · undone'}
                  </p>
                </div>
                {canUndo === r.id && (
                  <button type="button" className="btn-secondary h-9 min-h-9 px-3" onClick={() => undo(r.id)} disabled={busy}>
                    <Undo2 className="size-4" aria-hidden="true" />
                    Undo
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
