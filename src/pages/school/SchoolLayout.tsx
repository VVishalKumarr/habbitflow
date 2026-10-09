import { BookOpenCheck, Building2, CalendarDays, ClipboardList, History, LayoutGrid, Settings2, ShieldAlert, Users } from 'lucide-react'
import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { EmptyState } from '../../components/ui/EmptyState'
import { FullPageLoader } from '../../components/ui/Spinner'
import { isHead, isStaff, ROLE_LABEL, type MyInstitution, type Permission } from '../../lib/institution'
import { useAuth } from '../../store/auth'
import { useCurrentInstitution, useInstitutionStore } from '../../store/institution'

interface Item {
  to: string
  label: string
  icon: typeof LayoutGrid
  show: (m: MyInstitution, can: (p: Permission) => boolean) => boolean
}

const ITEMS: Item[] = [
  { to: '/school', label: 'Overview', icon: LayoutGrid, show: () => true },
  { to: '/school/calendar', label: 'Calendar', icon: CalendarDays, show: () => true },
  { to: '/school/assignments', label: 'Assignments', icon: ClipboardList, show: () => true },
  { to: '/school/people', label: 'People', icon: Users, show: (m) => isStaff(m.role) },
  { to: '/school/classes', label: 'Classes & subjects', icon: BookOpenCheck, show: (m) => isStaff(m.role) },
  {
    to: '/school/settings',
    label: 'Settings',
    icon: Settings2,
    show: (m, can) => isHead(m.role) || can('set_homework_retention'),
  },
  { to: '/school/audit', label: 'Audit history', icon: History, show: (_m, can) => can('view_audit') },
]

/** Institution area: side navigation on desktop, a scrollable tab row on phones. */
export default function SchoolLayout() {
  const status = useInstitutionStore((s) => s.status)
  const memberships = useInstitutionStore((s) => s.memberships)
  const select = useInstitutionStore((s) => s.select)
  const { current, can } = useCurrentInstitution()
  const signOut = useAuth((s) => s.signOut)

  useEffect(() => {
    useInstitutionStore.getState().load()
  }, [])

  if (status === 'idle' || status === 'loading') return <FullPageLoader />

  if (!current) {
    const blocked = memberships.find((m) => m.status !== 'active' || m.institution_status !== 'active')
    return (
      <div className="card mx-auto max-w-lg">
        <EmptyState
          icon={blocked ? ShieldAlert : Building2}
          title={blocked ? 'Access paused' : 'No institution yet'}
          message={
            blocked
              ? blocked.institution_status !== 'active'
                ? `${blocked.name} isn’t active on HabitFlow right now. Your records are kept safely.`
                : `Your access to ${blocked.name} has been ${blocked.status}. Contact your institution’s office if you think this is a mistake.`
              : 'Your account isn’t linked to a school, college or coaching centre. Institutions send an activation email to approved addresses.'
          }
          action={
            blocked ? (
              <button type="button" className="btn-secondary" onClick={() => signOut()}>
                Log out
              </button>
            ) : undefined
          }
        />
      </div>
    )
  }

  const items = ITEMS.filter((i) => i.show(current, can))
  const usable = memberships.filter((m) => m.status === 'active' && m.institution_status === 'active')

  return (
    <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
      <aside className="mb-5 lg:mb-0">
        <div className="mb-3 flex items-center gap-3 lg:mb-5">
          {current.logo_url ? (
            <img src={current.logo_url} alt="" className="size-10 shrink-0 rounded-xl border border-line bg-surface object-contain" />
          ) : (
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white"
              style={{ background: current.brand_color ?? 'var(--brand)' }}
              aria-hidden="true"
            >
              <Building2 className="size-5" />
            </span>
          )}
          <div className="min-w-0">
            {usable.length > 1 ? (
              <select
                className="w-full max-w-full truncate rounded-lg bg-transparent font-semibold focus:ring-2 focus:ring-brand/30 focus:outline-none"
                value={current.institution_id}
                onChange={(e) => select(e.target.value)}
                aria-label="Institution"
              >
                {usable.map((m) => (
                  <option key={m.institution_id} value={m.institution_id}>
                    {m.short_name ?? m.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="truncate font-semibold">{current.short_name ?? current.name}</p>
            )}
            <p className="truncate text-sm text-muted">{ROLE_LABEL[current.role]}</p>
          </div>
        </div>
        <nav aria-label="Institution" className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/school'}
              className={({ isActive }) =>
                `flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-3 text-sm font-medium whitespace-nowrap transition-colors ${
                  isActive ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:bg-subtle hover:text-ink'
                }`
              }
            >
              <Icon className="size-[18px]" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <Outlet context={current} />
      </div>
    </div>
  )
}
