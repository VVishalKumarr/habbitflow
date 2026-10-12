// Error tracking with Sentry. Only initialised when VITE_SENTRY_DSN is set;
// the SDK is loaded on demand so it adds nothing to the bundle otherwise.
// Scrubs tokens, passwords, emails and query strings before anything is sent.
import { appConfig, sentryConfig } from '../config'

type SentryModule = typeof import('@sentry/react')
let sentry: SentryModule | null = null
const pending: [unknown, Record<string, string> | undefined][] = []

const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|email|signature|razorpay_|hashed/i

/** Remove query strings and fragments (reset links, verification tokens, OAuth hashes). */
export const scrubUrl = (u: string) => u.split(/[?#]/)[0]

function scrubText(s: string): string {
  return s
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/sb_(publishable|secret)_[\w-]+/g, '[key]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/(token(_hash)?|access_token|refresh_token|password)=[^&\s]+/gi, '$1=[redacted]')
}

function scrubObject<T>(v: T, depth = 0): T {
  if (depth > 6 || v == null) return v
  if (typeof v === 'string') return scrubText(v) as T
  if (Array.isArray(v)) return v.map((x) => scrubObject(x, depth + 1)) as T
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubObject(val, depth + 1)
    }
    return out as T
  }
  return v
}

export async function initMonitoring(): Promise<void> {
  if (!sentryConfig.dsn) return
  try {
    const S = await import('@sentry/react')
    S.init({
      dsn: sentryConfig.dsn,
      environment: appConfig.environment,
      release: `habbitflow@${appConfig.release}`,
      tracesSampleRate: sentryConfig.tracesSampleRate,
      // Collect as little as possible: no user/IP info, cookies, headers, bodies or query strings.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
      },
      beforeSend(event) {
        if (event.request) {
          if (event.request.url) event.request.url = scrubUrl(event.request.url)
          delete event.request.cookies
          delete event.request.headers
          delete event.request.data
          delete event.request.query_string
        }
        delete event.user
        return scrubObject(event)
      },
      beforeBreadcrumb(crumb) {
        if (crumb.data?.url) crumb.data.url = scrubUrl(String(crumb.data.url))
        if (crumb.data?.to) crumb.data.to = scrubUrl(String(crumb.data.to))
        if (crumb.data?.from) crumb.data.from = scrubUrl(String(crumb.data.from))
        if (crumb.category === 'ui.input') return null
        return scrubObject(crumb)
      },
    })
    sentry = S
    for (const [e, ctx] of pending.splice(0)) reportError(e, ctx)
  } catch {
    /* monitoring must never break the app */
  }
}

/** Report an unexpected error with a little non-personal context (e.g. { area: 'trackers' }). */
export function reportError(err: unknown, context?: Record<string, string>): void {
  if (!sentryConfig.dsn) return
  if (!sentry) {
    if (pending.length < 20) pending.push([err, context])
    return
  }
  sentry.withScope((scope) => {
    if (context) scope.setTags(context)
    sentry!.captureException(err instanceof Error ? err : new Error(scrubText(String((err as { message?: string })?.message ?? err))))
  })
}

export const monitoringEnabled = () => Boolean(sentryConfig.dsn)
