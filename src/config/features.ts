/**
 * Feature keys and their display labels.
 *
 * Which plan includes which feature, the limits (trackers, friends, history)
 * and the prices are NOT here: they live in the `plans` table in Supabase so
 * they can be changed without a new release, and the database enforces them.
 * See MONETIZATION.md → "Changing prices and limits".
 */
export type Feature =
  | 'basic_statistics'
  | 'unlimited_trackers'
  | 'advanced_statistics'
  | 'full_history'
  | 'custom_themes'
  | 'focus_sounds'
  | 'csv_export'
  | 'pdf_export'
  | 'reports'
  | 'leaderboards'
  | 'friend_groups'
  | 'no_ads'
  | 'ai_guided_timetable'
  | 'advanced_ai'

export type LimitKey = 'trackers' | 'friends' | 'history_days'

export const FEATURE_LABELS: Record<Feature, string> = {
  basic_statistics: 'Progress statistics and charts',
  unlimited_trackers: 'Unlimited trackers',
  advanced_statistics: '90-day and all-time statistics',
  full_history: 'Full history',
  custom_themes: 'Custom colour themes',
  focus_sounds: 'Focus sounds (rain, white noise…)',
  csv_export: 'CSV export',
  pdf_export: 'PDF progress reports',
  reports: 'Study & productivity reports',
  leaderboards: 'Weekly friend leaderboards',
  friend_groups: 'Friend groups (coming soon)',
  no_ads: 'No advertisements',
  ai_guided_timetable: 'AI timetable that asks your needs first',
  advanced_ai: 'Our most capable AI for answers and planning',
}

/**
 * Features that exist in the plans table but aren't built yet: never advertised
 * on the pricing page. Remove a key here when its feature ships.
 */
export const UNRELEASED_FEATURES = new Set<Feature>([])

/** Shown in the upgrade dialog when a feature is locked. */
export const FEATURE_UPSELL: Partial<Record<Feature | LimitKey, string>> = {
  trackers: 'You’ve reached the free tracker limit. Upgrade for unlimited trackers.',
  friends: 'You’ve reached your plan’s friend limit. Upgrade to add more friends.',
  history_days: 'Longer history needs a paid plan.',
  advanced_statistics: '90-day and all-time statistics need a paid plan.',
  csv_export: 'PDF/CSV export is a Pro feature.',
  pdf_export: 'PDF/CSV export is a Pro feature.',
  custom_themes: 'Custom themes need a paid plan.',
  focus_sounds: 'Focus sounds are a Pro feature.',
  leaderboards: 'Leaderboards are a Pro feature.',
  ai_guided_timetable: 'The AI timetable builder comes with Plus and Pro. Checking your timetable and rescheduling stay available on Free.',
}
