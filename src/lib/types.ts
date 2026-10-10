export type Category = 'study' | 'exercise' | 'work' | 'personal' | 'other'
export type TimeFormat = '12h' | '24h'
export type Theme = 'light' | 'dark'
export type WeekStart = 0 | 1
export type AccentTheme = 'default' | 'ocean' | 'forest' | 'sunset' | 'midnight' | 'minimal'

export interface Profile {
  id: string
  username: string
  week_start: WeekStart
  time_format: TimeFormat
  theme: Theme
  last_tracker_id: string | null
  created_at: string
  accent_theme: AccentTheme
  leaderboard_opt_in: boolean
  share_progress: boolean
  /** individual = username login; institutional = invited school/college email login */
  account_type: 'individual' | 'institutional'
  display_name: string | null
}

export interface Tracker {
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface TimeSlot {
  id: string
  tracker_id: string
  /** "HH:MM:SS" */
  start_time: string
  /** "HH:MM:SS" */
  end_time: string
  created_at: string
}

export interface Task {
  id: string
  tracker_id: string
  time_slot_id: string
  /** 0 = Sunday … 6 = Saturday */
  day_of_week: number
  title: string
  description: string | null
  category: Category
  created_at: string
  updated_at: string
}

export interface Completion {
  task_id: string
  completion_date: string
  completed: boolean
}

export interface TaskInput {
  title: string
  description: string | null
  category: Category
  time_slot_id: string
  day_of_week: number
}

export interface PomodoroSession {
  id: string
  label: string
  planned_minutes: number
  focus_seconds: number
  /** false when the user finished before the timer ran out */
  completed: boolean
  session_date: string
  started_at: string
  ended_at: string
}

export type FriendStatus = 'pending' | 'accepted'

export interface Friend {
  /** friendship row id */
  id: string
  friend_id: string
  username: string
  status: FriendStatus
  /** true when the other person sent the request */
  incoming: boolean
  created_at: string
  /** accepted friends only: whether they share their daily totals */
  shares_progress?: boolean
}

export interface CompareRow {
  user_id: string
  day: string
  focus_seconds: number
  sessions: number
  tasks_scheduled: number
  tasks_completed: number
}

export const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'study', label: 'Study' },
  { value: 'exercise', label: 'Exercise' },
  { value: 'work', label: 'Work' },
  { value: 'personal', label: 'Personal' },
  { value: 'other', label: 'Other' },
]

/** Key used for the completion map: "<taskId>|<YYYY-MM-DD>". */
export const completionKey = (taskId: string, date: string) => `${taskId}|${date}`
