import { env } from './env'

export const appConfig = {
  name: 'HabbitFlows',
  tagline: 'Plan your week. Track your habits. Understand your progress.',
  /** Public URL of the site, used in shared links. Falls back to the current origin. */
  siteUrl: env('VITE_SITE_URL'),
  /** "Support the developer" link (Buy Me a Coffee, Ko-fi, UPI…). Hidden when empty. */
  supportUrl: env('VITE_SUPPORT_URL'),
  supportLabel: env('VITE_SUPPORT_LABEL', 'Support the developer'),
  /** Release identifier shown to Sentry. */
  release: env('VITE_APP_VERSION', '1.1.0'),
  environment: env('VITE_APP_ENV', import.meta.env.MODE),
}
