/**
 * Institutional roles, permissions and record types. What each role may do is
 * decided by the database (RLS + has_inst_perm); these labels only drive the
 * UI. See ROLE_PERMISSIONS.md.
 */
export type InstRole = 'principal' | 'director' | 'coordinator' | 'class_teacher' | 'subject_teacher' | 'student' | 'parent'
export type InvitableRole = Exclude<InstRole, 'parent'>
export type MemberStatus = 'active' | 'suspended' | 'revoked'

export type Permission =
  | 'manage_institution_settings'
  | 'manage_license'
  | 'manage_staff'
  | 'manage_students'
  | 'manage_classes'
  | 'manage_calendar'
  | 'approve_deadline_changes'
  | 'view_all_classes'
  | 'view_audit'
  | 'set_homework_retention'
  | 'manage_programmes'
  | 'import_export'
  | 'view_reports'
  | 'record_attendance'
  | 'create_assignments'
  | 'enter_marks'
  | 'message_parents'

export const ROLE_LABEL: Record<InstRole, string> = {
  principal: 'Principal',
  director: 'Director',
  coordinator: 'Coordinator',
  class_teacher: 'Class Teacher',
  subject_teacher: 'Subject Teacher',
  student: 'Student',
  parent: 'Parent / Guardian',
}

export const HEAD_ROLES: InstRole[] = ['principal', 'director']
export const STAFF_ROLES: InstRole[] = ['principal', 'director', 'coordinator', 'class_teacher', 'subject_teacher']
/** Roles whose permissions an institution can configure. */
export const CONFIGURABLE_ROLES = ['coordinator', 'class_teacher', 'subject_teacher'] as const
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number]

export const isHead = (r?: InstRole | null) => r === 'principal' || r === 'director'
export const isStaff = (r?: InstRole | null) => !!r && STAFF_ROLES.includes(r)

export const PERMISSION_LABEL: Record<Permission, string> = {
  manage_institution_settings: 'Institution settings and branding',
  manage_license: 'Institution licence',
  manage_staff: 'Invite and manage staff',
  manage_students: 'Invite and manage students',
  manage_classes: 'Manage classes, subjects and enrolment',
  manage_calendar: 'Manage the academic calendar',
  approve_deadline_changes: 'Approve deadline changes',
  view_all_classes: 'See every class (not only assigned ones)',
  view_audit: 'View audit history',
  set_homework_retention: 'Set homework review/retention interval',
  manage_programmes: 'Manage development programmes',
  import_export: 'CSV import and export',
  view_reports: 'View academic reports',
  record_attendance: 'Record attendance',
  create_assignments: 'Create assignments',
  enter_marks: 'Enter marks',
  message_parents: 'Message parents',
}

/** Only principals and directors ever have these. */
export const LOCKED_PERMISSIONS: Permission[] = ['manage_institution_settings', 'manage_license', 'manage_staff']

/** Must match default_role_permissions() in the database. */
export const DEFAULT_PERMISSIONS: Record<ConfigurableRole, Permission[]> = {
  coordinator: ['manage_students', 'manage_classes', 'manage_calendar', 'approve_deadline_changes', 'set_homework_retention', 'manage_programmes', 'view_reports', 'message_parents'],
  class_teacher: ['record_attendance', 'create_assignments', 'enter_marks', 'view_reports', 'message_parents'],
  subject_teacher: ['record_attendance', 'create_assignments', 'enter_marks'],
}

export interface MyInstitution {
  membership_id: string
  institution_id: string
  name: string
  short_name: string | null
  kind: 'school' | 'college' | 'coaching' | 'other'
  logo_url: string | null
  brand_color: string | null
  timezone: string
  role: InstRole
  status: MemberStatus
  institution_status: 'active' | 'suspended' | 'archived'
  display_name: string
  permissions: Permission[]
}

export interface Membership {
  id: string
  institution_id: string
  user_id: string | null
  role: InstRole
  status: MemberStatus
  display_name: string
  external_id: string | null
  status_reason: string | null
  status_changed_at: string | null
  activated_at: string
}

export interface Invitation {
  id: string
  institution_id: string
  email: string
  role: InvitableRole
  display_name: string
  external_id: string | null
  status: 'pending' | 'accepted' | 'revoked'
  expires_at: string
  send_count: number
  last_sent_at: string | null
  accepted_at: string | null
  created_at: string
}

export interface AcademicYear {
  id: string
  institution_id: string
  name: string
  starts_on: string
  ends_on: string
  is_current: boolean
  archived: boolean
}

export interface Term {
  id: string
  academic_year_id: string
  name: string
  starts_on: string
  ends_on: string
}

export interface Subject {
  id: string
  institution_id: string
  name: string
  code: string | null
  archived: boolean
}

export interface SchoolClass {
  id: string
  institution_id: string
  academic_year_id: string | null
  grade: string
  section: string | null
  name: string
  class_teacher_id: string | null
  archived: boolean
}

export interface Enrollment {
  id: string
  class_id: string
  student_id: string
  roll_no: string | null
}

export interface TeachingAssignment {
  id: string
  class_id: string
  subject_id: string
  teacher_id: string
}

export interface CoordinatorScope {
  id: string
  coordinator_id: string
  grade: string
}

export type EventKind = 'exam' | 'holiday' | 'event' | 'workshop' | 'programme' | 'ptm' | 'other'

export const EVENT_LABEL: Record<EventKind, string> = {
  exam: 'Examination',
  holiday: 'Holiday',
  event: 'Event',
  workshop: 'Workshop',
  programme: 'Programme',
  ptm: 'Parent–teacher meeting',
  other: 'Other',
}

export interface CalendarEvent {
  id: string
  institution_id: string
  kind: EventKind
  title: string
  description: string | null
  starts_on: string
  ends_on: string
  start_time: string | null
  end_time: string | null
  class_id: string | null
  grade: string | null
  subject_id: string | null
  status: 'scheduled' | 'cancelled'
}

export type AssignmentKind = 'homework' | 'classwork' | 'project' | 'assessment'

export interface Assignment {
  id: string
  institution_id: string
  class_id: string
  subject_id: string
  teacher_id: string
  title: string
  description: string | null
  kind: AssignmentKind
  opens_at: string
  due_at: string
  status: 'draft' | 'published' | 'closed' | 'cancelled'
  allowed_types: ('pdf' | 'jpg' | 'png')[]
  max_file_mb: number
  late_policy: 'reject' | 'accept_marked_late'
  review_retention_days: number
  retention_hold: boolean
  retention_hold_reason: string | null
  created_at: string
}

export type ConflictFlag = 'overlapping_deadlines' | 'heavy_day' | 'heavy_week' | 'exam_conflict' | 'multiple_exams' | 'holiday'

export const FLAG_LABEL: Record<ConflictFlag, string> = {
  overlapping_deadlines: 'Several deadlines',
  heavy_day: 'Heavy day',
  heavy_week: 'Heavy week',
  exam_conflict: 'Deadline on exam day',
  multiple_exams: 'Several exams',
  holiday: 'Falls on a holiday',
}

/** Flags that need attention (several deadlines alone is informational). */
export const SERIOUS_FLAGS: ConflictFlag[] = ['heavy_day', 'heavy_week', 'exam_conflict', 'multiple_exams', 'holiday']

export interface DeadlineDay {
  day: string
  class_id: string
  class_name: string
  grade: string
  deadlines: { id: string; title: string; kind: AssignmentKind; subject: string; subject_id: string; teacher: string; teacher_id: string; due_at: string; opens_at: string; status: string }[]
  exams: { id: string; title: string; subject: string | null }[]
  deadline_count: number
  exam_count: number
  week_deadlines: number
  is_holiday: boolean
  holiday: string | null
  flags: ConflictFlag[]
}

export interface DeadlineRequest {
  id: string
  institution_id: string
  assignment_id: string
  proposed_opens_at: string | null
  proposed_due_at: string
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  requested_by: string | null
  decision_note: string | null
  decided_at: string | null
  created_at: string
}

export interface InstitutionSettings {
  homework_retention_days: number
  max_deadlines_per_day: number
  max_deadlines_per_week: number
  grading_scale: { label: string; min: number }[]
  attendance_statuses: string[]
}

export interface Overview {
  role: InstRole
  today: string
  students: number
  staff: number
  staff_by_role: Partial<Record<InstRole, number>>
  suspended: number | null
  classes: number
  subjects: number
  pending_invitations: number | null
  upcoming_exams: number
  deadlines_7d: number
  conflicts_30d: number
  pending_deadline_requests: number | null
  current_year: { id: string; name: string; starts_on: string; ends_on: string } | null
}

export interface AuditEntry {
  id: number
  institution_id: string | null
  actor_id: string | null
  action: string
  record_type: string
  record_id: string | null
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  reason: string | null
  created_at: string
}

/** "10 A" style label for a class. */
export const className = (c?: Pick<SchoolClass, 'name'> | null) => c?.name ?? '—'

/** Local date-time string for <input type="datetime-local">. */
export function toLocalInput(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The deadline is at most one calendar month after the start (same rule as the database). */
export function withinOneMonth(start: Date, due: Date): boolean {
  const limit = new Date(start)
  limit.setMonth(limit.getMonth() + 1)
  // JS rolls 31 Jan + 1 month to 3 Mar; Postgres clamps to the month's last day.
  if (limit.getDate() !== start.getDate()) limit.setDate(0)
  return due.getTime() <= limit.getTime()
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export const formatDay = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
