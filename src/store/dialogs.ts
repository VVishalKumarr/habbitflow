import { create } from 'zustand'
import { useSubscriptionStore, useUpgrade } from './subscription'
import { useTrackers } from './trackers'
import type { ISODate } from '../lib/dates'
import type { TimeSlot } from '../lib/types'

export type TaskFormState =
  | { mode: 'add'; slotId: string; day: number }
  | { mode: 'edit'; taskId: string }
  | { mode: 'duplicate'; taskId: string }

type DialogState =
  | { kind: 'none' }
  | { kind: 'taskForm'; form: TaskFormState }
  | { kind: 'taskOptions'; taskId: string; date: ISODate }
  | { kind: 'deleteTask'; taskId: string }
  | { kind: 'slotForm'; slot: TimeSlot | null }
  | { kind: 'deleteSlot'; slot: TimeSlot }
  | { kind: 'trackerForm'; trackerId: string | null }
  | { kind: 'deleteTracker'; trackerId: string }

interface DialogsStore {
  dialog: DialogState
  open: (d: Exclude<DialogState, { kind: 'none' }>) => void
  close: () => void
}

export const useDialogs = create<DialogsStore>((set) => ({
  dialog: { kind: 'none' },
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: { kind: 'none' } }),
}))

export const dialogs = {
  addTask: (slotId: string, day: number) => useDialogs.getState().open({ kind: 'taskForm', form: { mode: 'add', slotId, day } }),
  taskOptions: (taskId: string, date: ISODate) => useDialogs.getState().open({ kind: 'taskOptions', taskId, date }),
  addSlot: () => useDialogs.getState().open({ kind: 'slotForm', slot: null }),
  editSlot: (slot: TimeSlot) => useDialogs.getState().open({ kind: 'slotForm', slot }),
  createTracker: () => {
    // Friendly early check; the database enforces the same limit on insert.
    const max = useSubscriptionStore.getState().ent.limits.trackers
    if (max != null && useTrackers.getState().trackers.length >= max) {
      useUpgrade.getState().show('trackers')
      return
    }
    useDialogs.getState().open({ kind: 'trackerForm', trackerId: null })
  },
  renameTracker: (trackerId: string) => useDialogs.getState().open({ kind: 'trackerForm', trackerId }),
  deleteTracker: (trackerId: string) => useDialogs.getState().open({ kind: 'deleteTracker', trackerId }),
}
