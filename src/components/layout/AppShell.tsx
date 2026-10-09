import { Building2, ChartNoAxesColumn, ChevronDown, CircleHelp, LayoutDashboard, LogOut, Settings, ShieldCheck, Sparkles, Timer, Users } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { analytics } from '../../lib/analytics'
import { useAuth } from '../../store/auth'
import { useFriends } from '../../store/friends'
import { useInstitutionStore } from '../../store/institution'
import { formatClock, MODE_LABEL, usePomodoro, useRemaining } from '../../store/pomodoro'
import { useSubscription } from '../../store/subscription'
import { Assistant } from '../assistant/Assistant'
import { Dropdown, MenuDivider, MenuItem } from '../ui/Dropdown'
import { Logo } from './Logo'
import { SiteFooter } from './SiteFooter'

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/focus', label: 'Focus', icon: Timer },
  { to: '/progress', label: 'Progress', icon: ChartNoAxesColumn },
  { to: '/friends', label: 'Friends', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
]

/** Institutional accounts: their institution first, then their own timetable and tools. */
const INSTITUTION_NAV = [
  { to: '/school', label: 'School', icon: Building2 },
  { to: '/dashboard', label: 'Timetable', icon: LayoutDashboard },
  { to: '/focus', label: 'Focus', icon: Timer },
  { to: '/progress', label: 'Progress', icon: ChartNoAxesColumn },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function useNav() {
  return useAuth((s) => (s.profile?.account_type === 'institutional' ? INSTITUTION_NAV : NAV))
}

/** Number of friend requests waiting for an answer, shown on the Friends tab. */
function useRequestCount() {
  return useFriends((s) => s.friends.filter((f) => f.status === 'pending' && f.incoming).length)
}

function Badge({ count, className = '' }: { count: number; className?: string }) {
  if (!count) return null
  return (
    <span className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-semibold text-white ${className}`}>
      {count}
      <span className="sr-only"> pending friend {count === 1 ? 'request' : 'requests'}</span>
    </span>
  )
}

/** Running / paused timer shortcut in the header, hidden on the Focus page itself. */
function TimerPill() {
  const started = usePomodoro((s) => s.startedAt !== null)
  const running = usePomodoro((s) => s.endAt !== null)
  const mode = usePomodoro((s) => s.mode)
  const remaining = useRemaining(1000)
  const { pathname } = useLocation()
  if (!started || pathname === '/focus') return null
  return (
    <NavLink
      to="/focus"
      className="flex h-9 items-center gap-2 rounded-full bg-brand-soft px-3 text-sm font-semibold text-brand-ink tabular-nums"
      aria-label={`${MODE_LABEL[mode]} timer, ${formatClock(remaining)} left${running ? '' : ', paused'}. Open focus timer`}
    >
      <Timer className={`size-4 ${running ? 'animate-pulse' : ''}`} aria-hidden="true" />
      {formatClock(remaining)}
      {!running && <span className="text-xs font-medium">Paused</span>}
    </NavLink>
  )
}

/** Small "Upgrade" shortcut for free users; a plan badge (Plus / Pro) for paying members. */
function PlanBadge() {
  const { isPaid, loading, state, plan_name } = useSubscription()
  if (loading) return null
  if (isPaid) {
    return (
      <Link to="/pro" className="hidden h-8 items-center gap-1.5 rounded-full bg-brand-soft px-3 text-xs font-semibold text-brand-ink lg:flex">
        <Sparkles className="size-3.5" aria-hidden="true" />
        {state === 'TRIAL' ? `${plan_name} trial` : plan_name}
      </Link>
    )
  }
  return (
    <Link
      to="/pro"
      onClick={() => analytics.track('upgrade_clicked', { source: 'header' })}
      className="hidden h-9 items-center gap-1.5 rounded-xl border border-brand/40 px-3 text-sm font-semibold text-brand transition-colors hover:bg-brand-soft lg:flex"
    >
      <Sparkles className="size-4" aria-hidden="true" />
      Upgrade
    </Link>
  )
}

function UserMenu() {
  const username = useAuth((s) =>
    s.profile?.account_type === 'institutional' ? (s.profile.display_name ?? s.session?.user.email ?? '') : (s.profile?.username ?? ''),
  )
  const isPlatformAdmin = useInstitutionStore((s) => s.isPlatformAdmin)
  const signOut = useAuth((s) => s.signOut)
  const { isPaid, plan_name } = useSubscription()
  const navigate = useNavigate()

  return (
    <Dropdown
      id="user-menu"
      align="right"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={id}
          className="flex h-10 items-center gap-2 rounded-xl pr-2 pl-1 transition-colors hover:bg-subtle"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-ink uppercase">
            {username.slice(0, 1)}
          </span>
          <span className="hidden max-w-32 truncate text-sm font-medium xl:block">{username}</span>
          <ChevronDown className="size-4 text-muted" aria-hidden="true" />
          <span className="sr-only">Account menu</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-3 pt-2 pb-2.5">
            <p className="text-xs text-muted">Signed in as</p>
            <p className="truncate font-medium">{username}</p>
          </div>
          <MenuDivider />
          <MenuItem icon={<Settings />} onClick={() => (close(), navigate('/settings'))}>
            Settings
          </MenuItem>
          <MenuItem icon={<Sparkles />} onClick={() => (close(), navigate('/pro'))}>
            {isPaid ? `Your ${plan_name} plan` : 'Upgrade'}
          </MenuItem>
          {isPlatformAdmin && (
            <MenuItem icon={<ShieldCheck />} onClick={() => (close(), navigate('/admin'))}>
              Platform admin
            </MenuItem>
          )}
          <MenuItem icon={<CircleHelp />} onClick={() => (close(), navigate('/help'))}>
            Help
          </MenuItem>
          <MenuDivider />
          <MenuItem icon={<LogOut />} danger onClick={() => (close(), signOut())}>
            Log out
          </MenuItem>
        </>
      )}
    </Dropdown>
  )
}

export function AppShell() {
  const requests = useRequestCount()
  const nav = useNav()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 pt-safe backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-6 px-4 sm:px-6 lg:px-8">
          <NavLink to={nav[0].to} aria-label="HabitFlow home" className="rounded-lg">
            <Logo />
          </NavLink>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {nav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                title={label}
                className={({ isActive }) =>
                  `flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors lg:px-3.5 ${
                    isActive ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:bg-subtle hover:text-ink'
                  }`
                }
              >
                <Icon className="size-[18px]" aria-hidden="true" />
                {/* Tablets: icons only (the label stays for screen readers). */}
                <span className="sr-only lg:not-sr-only">{label}</span>
                {to === '/friends' && <Badge count={requests} />}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <TimerPill />
            <PlanBadge />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Extra bottom padding keeps content clear of the tab bar and the assistant button. */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pt-5 pb-[calc(9rem+env(safe-area-inset-bottom))] sm:px-6 md:pt-8 md:pb-24 lg:px-8">
        <Outlet />
      </main>

      <div className="mx-auto hidden w-full max-w-[1440px] px-4 pb-8 sm:px-6 md:block lg:px-8">
        <SiteFooter compact />
      </div>

      <Assistant />

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur-md md:hidden"
      >
        <div className="grid grid-cols-5">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
                  isActive ? 'text-brand' : 'text-muted'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`relative flex h-7 w-12 items-center justify-center rounded-full transition-colors ${isActive ? 'bg-brand-soft' : ''}`}>
                    <Icon className="size-5" aria-hidden="true" />
                    {to === '/friends' && <Badge count={requests} className="absolute -top-1 right-0.5" />}
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
