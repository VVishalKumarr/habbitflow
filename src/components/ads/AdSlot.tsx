import { useEffect, useRef } from 'react'
import { adsConfig, type AdPlacement } from '../../config/ads'
import { isNative } from '../../lib/native'
import { useAuth } from '../../store/auth'
import { useConsent } from '../../store/consent'
import { useSubscriptionStore } from '../../store/subscription'

declare global {
  interface Window {
    adsbygoogle?: unknown[]
  }
}

let scriptAdded = false
function loadAdSense(client: string) {
  if (scriptAdded) return
  scriptAdded = true
  const s = document.createElement('script')
  s.async = true
  s.crossOrigin = 'anonymous'
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`
  document.head.appendChild(s)
}

/**
 * Renders an ad only when ALL of these hold: the site has AdSense configured,
 * this placement has a slot, the visitor consented to advertising, the user
 * isn't on a plan with `no_ads`, and we're on the web (AdMob for Android is
 * not integrated yet). Otherwise renders nothing — no placeholders.
 */
export function AdSlot({ placement, className = '' }: { placement: AdPlacement; className?: string }) {
  const consent = useConsent((s) => s.advertising)
  const signedIn = useAuth((s) => s.status === 'authenticated')
  const noAds = useSubscriptionStore((s) => s.ent.features.includes('no_ads'))
  const entLoading = useSubscriptionStore((s) => s.status === 'idle' || s.status === 'loading')
  const slot = adsConfig.slots[placement]
  const client = adsConfig.adsenseClientId
  const pushed = useRef(false)

  // Signed-in users: wait for the plan so paying members never see a flash of ads.
  const show = !isNative && Boolean(client && slot) && consent && !(signedIn && (noAds || entLoading))

  useEffect(() => {
    if (!show || pushed.current) return
    loadAdSense(client)
    try {
      ;(window.adsbygoogle = window.adsbygoogle || []).push({})
      pushed.current = true
    } catch {
      /* ad blockers etc. */
    }
  }, [show, client])

  if (!show) return null
  return (
    <aside aria-label="Advertisement" className={`overflow-hidden ${className}`}>
      <p className="mb-1 text-[11px] tracking-wide text-muted uppercase">Advertisement</p>
      <ins
        className="adsbygoogle block"
        style={{ display: 'block', minHeight: 90 }}
        data-ad-client={client}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  )
}
