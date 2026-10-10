// Privacy-conscious product analytics (Plausible or Umami).
// - Loads nothing until the visitor allows analytics.
// - Only whitelisted event names and small, non-personal properties are sent.
// - Page URLs are sent as paths only (no query strings or #fragments, which
//   may contain one-time tokens).
// If analytics is disabled or blocked, every call is a harmless no-op.
import { analyticsConfig } from '../config'
import { useConsent } from '../store/consent'

export type AnalyticsEvent =
  | 'signup_started'
  | 'signup_completed'
  | 'login'
  | 'tracker_created'
  | 'tracker_deleted'
  | 'task_created'
  | 'task_completed'
  | 'task_uncompleted'
  | 'progress_viewed'
  | 'settings_opened'
  | 'upgrade_clicked'
  | 'subscription_started'
  | 'trial_started'
  | 'focus_session_completed'
  | 'friend_request_sent'
  | 'export_downloaded'
  | 'assistant_opened'
  | 'ai_timetable_generated'

type Props = Record<string, string | number | boolean>

/** Only these property names may be sent; values are truncated primitives. */
const ALLOWED_PROPS = new Set(['plan', 'interval', 'range', 'source', 'placement', 'provider', 'feature', 'format', 'tab', 'mode'])

declare global {
  interface Window {
    plausible?: ((event: string, opts?: { props?: Props; u?: string }) => void) & { q?: unknown[] }
    umami?: { track: (event?: string | ((p: Record<string, unknown>) => Record<string, unknown>), data?: Props) => void }
  }
}

let loaded = false
const queue: [string, Props | undefined, string | undefined][] = []

function cleanProps(props?: Props): Props | undefined {
  if (!props) return undefined
  const out: Props = {}
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_PROPS.has(k)) continue
    out[k] = typeof v === 'string' ? v.slice(0, 40) : v
  }
  return Object.keys(out).length ? out : undefined
}

/** Path only, with ids replaced so no personal identifiers are sent. */
export function cleanPath(path: string): string {
  return path
    .split(/[?#]/)[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
}

function allowed() {
  return analyticsConfig.provider !== 'none' && useConsent.getState().analytics
}

function load() {
  if (loaded || !allowed()) return
  loaded = true
  const s = document.createElement('script')
  s.defer = true
  if (analyticsConfig.provider === 'plausible') {
    window.plausible =
      window.plausible ||
      Object.assign((...args: unknown[]) => (window.plausible!.q = window.plausible!.q || []).push(args), { q: [] as unknown[] })
    s.src = analyticsConfig.plausible.scriptUrl
    s.dataset.domain = analyticsConfig.plausible.domain
  } else {
    s.src = `${analyticsConfig.umami.url}/script.js`
    s.dataset.websiteId = analyticsConfig.umami.websiteId
    s.dataset.autoTrack = 'false'
    s.onload = () => flush()
  }
  document.head.appendChild(s)
  flush()
}

function send(name: string, props?: Props, url?: string) {
  try {
    if (analyticsConfig.provider === 'plausible') {
      window.plausible?.(name, { props, ...(url ? { u: url } : {}) })
    } else if (window.umami) {
      if (name === 'pageview') window.umami.track((p) => ({ ...p, url: url ? new URL(url).pathname : p.url, title: document.title }))
      else window.umami.track(name, props)
    } else {
      queue.push([name, props, url])
    }
  } catch {
    /* analytics must never break the app */
  }
}

function flush() {
  while (queue.length && (analyticsConfig.provider === 'plausible' || window.umami)) {
    const [n, p, u] = queue.shift()!
    send(n, p, u)
  }
}

export const analytics = {
  /** Call once at startup; loads the provider when (and if) consent is given. */
  init() {
    load()
    useConsent.subscribe((s, prev) => {
      if (s.analytics && !prev.analytics) load()
    })
  },
  page(path: string) {
    if (!allowed()) return
    load()
    send('pageview', undefined, `${location.origin}${cleanPath(path)}`)
  },
  track(event: AnalyticsEvent, props?: Props) {
    if (!allowed()) return
    load()
    send(event, cleanProps(props))
  },
}
