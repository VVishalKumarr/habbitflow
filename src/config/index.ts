// Central configuration. Change behaviour here (or via VITE_* variables)
// instead of hunting through components.
//
//   app.ts       – site URL, support/donation link, release
//   legal.ts     – business name, contact, country, effective date
//   analytics.ts – Plausible / Umami, Sentry
//   ads.ts       – AdSense / AdMob ids and placements
//   payments.ts  – web checkout provider, public keys
//   ai.ts        – assistant on/off, provider disclosure
//   captcha.ts   – Turnstile site key for login / sign-up
//   consent.ts   – cookie consent behaviour
//   features.ts  – feature keys and labels
//
// Prices, plan limits and which features Pro includes are stored in the
// database (`plans` table) and enforced there. See MONETIZATION.md.
export { adsConfig } from './ads'
export { aiConfig } from './ai'
export { analyticsConfig, sentryConfig } from './analytics'
export { appConfig } from './app'
export { captchaConfig } from './captcha'
export { consentConfig } from './consent'
export { FEATURE_LABELS, FEATURE_UPSELL, UNRELEASED_FEATURES, type Feature, type LimitKey } from './features'
export { legalComplete, legalConfig } from './legal'
export { paymentsConfig } from './payments'
