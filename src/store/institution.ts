import { create } from 'zustand'
import type { MyInstitution, Permission } from '../lib/institution'
import { supabase } from '../lib/supabase'

const CURRENT_KEY = 'habitflow-institution'

function storedCurrent(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY)
  } catch {
    return null
  }
}

interface InstitutionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  memberships: MyInstitution[]
  currentId: string | null
  isPlatformAdmin: boolean
  load: () => Promise<void>
  select: (institutionId: string) => void
  reset: () => void
}

/** The signed-in user's institutions and roles (see my_institutions() in the database). */
export const useInstitutionStore = create<InstitutionState>((set, get) => ({
  status: 'idle',
  memberships: [],
  currentId: null,
  isPlatformAdmin: false,

  load: async () => {
    if (get().status === 'idle') set({ status: 'loading' })
    const [mine, admin] = await Promise.all([supabase.rpc('my_institutions'), supabase.rpc('is_platform_admin')])
    if (mine.error) {
      set({ status: 'error' })
      return
    }
    const memberships = (mine.data ?? []) as MyInstitution[]
    const usable = memberships.filter((m) => m.status === 'active' && m.institution_status === 'active')
    const wanted = get().currentId ?? storedCurrent()
    const currentId = usable.find((m) => m.institution_id === wanted)?.institution_id ?? usable[0]?.institution_id ?? null
    set({ status: 'ready', memberships, currentId, isPlatformAdmin: admin.data === true })
  },

  select: (institutionId) => {
    try {
      localStorage.setItem(CURRENT_KEY, institutionId)
    } catch {
      /* storage unavailable */
    }
    set({ currentId: institutionId })
  },

  reset: () => set({ status: 'idle', memberships: [], currentId: null, isPlatformAdmin: false }),
}))

/** The institution being viewed, with helpers for the UI (the database enforces the same rules). */
export function useCurrentInstitution() {
  const memberships = useInstitutionStore((s) => s.memberships)
  const currentId = useInstitutionStore((s) => s.currentId)
  const current = memberships.find((m) => m.institution_id === currentId && m.status === 'active') ?? null
  return {
    current,
    role: current?.role ?? null,
    can: (p: Permission) => !!current?.permissions.includes(p),
  }
}
