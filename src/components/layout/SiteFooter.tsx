import { Heart } from 'lucide-react'
import { Link } from 'react-router-dom'
import { appConfig, legalConfig } from '../../config'
import { useConsent } from '../../store/consent'

/** Footer links shared by public pages and the app (Privacy, Terms, Help, Cookie Settings…). */
export function SiteFooter({ compact = false }: { compact?: boolean }) {
  const openSettings = useConsent((s) => s.openSettings)
  const year = new Date().getFullYear()
  const linkClass = 'rounded hover:text-ink hover:underline'

  return (
    <footer className={compact ? 'text-xs text-muted' : 'border-t border-line bg-surface text-sm text-muted'}>
      <div className={compact ? 'flex flex-wrap items-center gap-x-4 gap-y-2' : 'mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6'}>
        {!compact && (
          <p>
            © {year} {legalConfig.businessName || appConfig.name}
          </p>
        )}
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link to="/about" className={linkClass}>
            About
          </Link>
          <Link to="/help" className={linkClass}>
            Help
          </Link>
          <Link to="/pro" className={linkClass}>
            Pricing
          </Link>
          <Link to="/privacy" className={linkClass}>
            Privacy
          </Link>
          <Link to="/terms" className={linkClass}>
            Terms
          </Link>
          <button type="button" className={linkClass} onClick={openSettings}>
            Cookie Settings
          </button>
          <Link to="/contact" className={linkClass}>
            Contact
          </Link>
          {appConfig.supportUrl && (
            <a href={appConfig.supportUrl} target="_blank" rel="noopener noreferrer" className={`${linkClass} inline-flex items-center gap-1`}>
              <Heart className="size-3.5" aria-hidden="true" />
              {appConfig.supportLabel}
            </a>
          )}
        </nav>
      </div>
    </footer>
  )
}
