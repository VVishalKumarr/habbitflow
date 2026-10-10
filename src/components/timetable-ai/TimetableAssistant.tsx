import { History, Lock, Shuffle, Sparkles, Stethoscope } from 'lucide-react'
import { useState } from 'react'
import { aiConfig } from '../../config'
import { useFeatureAccess } from '../../store/subscription'
import { useTrackers } from '../../store/trackers'
import { BuildTimetableModal } from './BuildTimetableModal'
import { CheckTimetableModal } from './CheckTimetableModal'
import { CommandBar } from './CommandBar'
import { HistoryModal } from './HistoryModal'
import { RescheduleModal } from './RescheduleModal'

type Open = 'build' | 'check' | 'reschedule' | 'history' | null

/** Student dashboard: AI timetable builder, check, rescheduling, history and the command box. */
export function TimetableAssistant() {
  const trackerId = useTrackers((s) => s.selectedId)
  const { hasFeature, requireFeature } = useFeatureAccess()
  const [open, setOpen] = useState<Open>(null)
  if (!aiConfig.assistantEnabled) return null
  const guided = hasFeature('ai_guided_timetable')
  const close = () => setOpen(null)

  return (
    <section className="card p-4 sm:p-6" aria-labelledby="tt-ai-title">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Sparkles className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="tt-ai-title" className="font-semibold">Timetable assistant</h2>
          <p className="text-sm text-muted">Type or say what you need — I’ll show you exactly what will change and wait for your OK.</p>
        </div>
      </div>
      <CommandBar trackerId={trackerId} />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button type="button" className="btn-secondary h-auto min-h-11 py-2" onClick={() => requireFeature('ai_guided_timetable') && setOpen('build')}>
          {guided ? <Sparkles className="size-4 text-brand" aria-hidden="true" /> : <Lock className="size-4 text-muted" aria-hidden="true" />}
          Build with AI
        </button>
        <button type="button" className="btn-secondary h-auto min-h-11 py-2" disabled={!trackerId} onClick={() => setOpen('check')}>
          <Stethoscope className="size-4" aria-hidden="true" />
          Check my timetable
        </button>
        <button type="button" className="btn-secondary h-auto min-h-11 py-2" disabled={!trackerId} onClick={() => setOpen('reschedule')}>
          <Shuffle className="size-4" aria-hidden="true" />
          Reschedule
        </button>
        <button type="button" className="btn-secondary h-auto min-h-11 py-2" disabled={!trackerId} onClick={() => setOpen('history')}>
          <History className="size-4" aria-hidden="true" />
          History
        </button>
      </div>
      <BuildTimetableModal open={open === 'build'} onClose={close} />
      {trackerId && (
        <>
          <CheckTimetableModal open={open === 'check'} onClose={close} trackerId={trackerId} />
          <RescheduleModal open={open === 'reschedule'} onClose={close} trackerId={trackerId} />
          <HistoryModal open={open === 'history'} onClose={close} trackerId={trackerId} />
        </>
      )}
    </section>
  )
}
