import { useEffect } from 'react'
import { autoApply } from '../../lib/studyInsights'
import { useInstitutionStore } from '../../store/institution'
import { useTrackerData } from '../../store/trackerData'
import { useTrackers } from '../../store/trackers'
import { toast } from '../../store/ui'

let ranThisSession = false

/**
 * Automatic study plans: for students who chose "adjust automatically", applies
 * the plan once per change in their study insights, when they open the
 * dashboard. Renders nothing; silent when there is nothing to do.
 */
export function AutoStudyPlan() {
  const selectedId = useTrackers((s) => s.selectedId)
  useEffect(() => {
    if (ranThisSession || !selectedId) return
    ranThisSession = true
    ;(async () => {
      const store = useInstitutionStore.getState()
      if (store.status === 'idle') await store.load()
      const student = useInstitutionStore.getState().memberships.find(
        (m) => m.role === 'student' && m.status === 'active' && m.institution_status === 'active',
      )
      if (!student) return
      const plan = await autoApply(student.membership_id, selectedId)
      if (!plan) return
      await useTrackerData.getState().refresh()
      toast.info(`${plan.summary} Undo it from the Timetable assistant’s History.`)
    })().catch(() => {
      /* automatic mode never interrupts the dashboard; the Study insights page shows errors */
    })
  }, [selectedId])
  return null
}
