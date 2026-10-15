import { Menu, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../store/auth'
import { Logo } from './Logo'
import { SiteFooter } from './SiteFooter'

const LINKS = [
  { to: '/#features', label: 'Features' },
  { to: '/pro', label: 'Pricing' },
  { to: '/help', label: 'Help' },
]

/** Header + footer for public pages (landing, pricing, help, legal). */
export function PublicLayout() {
  const signedIn = useAuth((s) => s.status === 'authenticated')
  const [open, setOpen] = useState(false)
  const { pathname, hash } = useLocation()

  useEffect(() => setOpen(false), [pathname, hash])
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [pathname, hash])

  const cta = signedIn ? (
    <Link to="/dashboard" className="btn-primary">
      Open app
    </Link>
  ) : (
    <>
      <Link to="/login" className="btn-ghost">
        Login
      </Link>
      <Link to="/register" className="btn-primary">
        Create Free Account
      </Link>
    </>
  )

  // The landing page is always dark (app-store style); other public pages follow the theme.
  const landing = pathname === '/'

  return (
    <div className={`flex min-h-dvh flex-col ${landing ? 'dark bg-canvas text-ink' : ''}`}>
      <header className={`sticky top-0 z-30 border-b pt-safe backdrop-blur-md ${landing ? 'border-white/5 bg-canvas/70' : 'border-line bg-surface/85'}`}>
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" aria-label="HabbitFlows home" className="rounded-lg">
            <Logo />
          </Link>
          <nav aria-label="Site" className="hidden items-center gap-1 md:flex">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className="rounded-xl px-3 py-2 text-sm font-medium text-muted hover:bg-subtle hover:text-ink">
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-2 md:flex">{cta}</div>
          <button
            type="button"
            className="icon-btn ml-auto md:hidden"
            aria-expanded={open}
            aria-controls="public-menu"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
        {open && (
          <div id="public-menu" className="border-t border-line px-4 pb-4 md:hidden">
            <nav aria-label="Site" className="flex flex-col py-2">
              {LINKS.map((l) => (
                <Link key={l.to} to={l.to} className="rounded-xl px-3 py-3 font-medium hover:bg-subtle">
                  {l.label}
                </Link>
              ))}
            </nav>
            <div className="flex flex-col gap-2 [&>*]:w-full">{cta}</div>
          </div>
        )}
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  )
}
