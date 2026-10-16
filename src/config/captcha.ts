import { env } from './env'

/**
 * Cloudflare Turnstile on login and sign-up. Off when the site key is empty.
 * The matching secret key goes in Supabase (Authentication -> Attack Protection),
 * which then rejects password logins and sign-ups without a valid token.
 */
export const captchaConfig = {
  turnstileSiteKey: env('VITE_TURNSTILE_SITE_KEY'),
}
