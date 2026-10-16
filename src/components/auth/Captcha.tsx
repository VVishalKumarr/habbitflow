import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { captchaConfig } from '../../config'

interface Turnstile {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id: string) => void
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise: Promise<Turnstile> | null = null
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  scriptPromise ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SCRIPT_URL
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable')))
    s.onerror = () => {
      scriptPromise = null
      reject(new Error('Turnstile failed to load'))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

export const captchaEnabled = Boolean(captchaConfig.turnstileSiteKey)

export interface CaptchaHandle {
  /** Tokens are single-use: call after every submit so the next attempt gets a fresh one. */
  reset: () => void
}

/** Cloudflare Turnstile check. Renders nothing when no site key is configured. */
export const Captcha = forwardRef<CaptchaHandle, { onToken: (token: string | null) => void }>(function Captcha({ onToken }, ref) {
  const el = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken
  const [failed, setFailed] = useState(false)

  useImperativeHandle(ref, () => ({
    reset: () => {
      onTokenRef.current(null)
      if (widget.current) window.turnstile?.reset(widget.current)
    },
  }))

  useEffect(() => {
    if (!captchaEnabled) return
    let cancelled = false
    loadTurnstile()
      .then((t) => {
        if (cancelled || !el.current) return
        widget.current = t.render(el.current, {
          sitekey: captchaConfig.turnstileSiteKey,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          size: 'flexible',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        })
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [])

  if (!captchaEnabled) return null
  return (
    <div>
      <div ref={el} className="min-h-[65px]" />
      {failed && <p className="mt-1 text-sm text-danger">The security check couldn’t load. Check your connection and reload the page.</p>}
    </div>
  )
})
