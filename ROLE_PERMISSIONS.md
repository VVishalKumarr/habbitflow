# Roles and permissions

Every rule below is enforced in the database (Row Level Security and the
`has_inst_perm()` / `can_view_class()` helpers in
`supabase/migrations/2026-10-10_institutions_phase1.sql`). The app hides buttons
to match, but hiding a button is never what protects the data.

## Hierarchy

| Level | Role | Notes |
|---|---|---|
| — | **Platform owner** (`platform_admins`) | Outside the institution hierarchy. Creates institutions, manages the approved-email list, invites principals and directors, suspends institutions. Sees principals/directors and counts, **not** students, classes, assignments or marks. |
| 1 | **Principal**, **Director** | Every permission in their own institution. Only the platform owner can make someone a principal or director. |
| 2 | **Coordinator** | Same tier as class teacher, different permissions. Works only within the grades in their *coordinator scope* (`*` = all grades). |
| 2 | **Class Teacher** | Same tier as coordinator. Manages their own class where permitted. |
| 3 | **Subject Teacher** | Their assigned classes and subjects only. |
| 4 | **Student** | Their own class, published assignments, calendar. Can’t see other students. |
| 5 | **Parent / Guardian** | Only children with an *active* guardian link: timetable, homework status, attendance, published marks and feedback, exams, announcements for them, messages with that child’s teachers. Can’t search students or read institution tables. |

## Permissions

Principals and directors always have all of them. The first three are **locked**:
nobody else can ever be granted them, not even through an override.

| Permission | Coordinator | Class Teacher | Subject Teacher |
|---|:-:|:-:|:-:|
| manage_institution_settings 🔒 | – | – | – |
| manage_license 🔒 | – | – | – |
| manage_staff 🔒 (invite/suspend staff, coordinator scopes) | – | – | – |
| manage_students (invite/suspend students) | ✔ | | |
| manage_classes (classes, subjects, enrolment, subject teachers) | ✔ (in scope) | (own class) | |
| manage_calendar | ✔ (in scope) | | |
| approve_deadline_changes | ✔ | | |
| view_all_classes | | | |
| view_audit | | | |
| set_homework_retention (0–14 days) | ✔ | | |
| manage_programmes (class teachers: own class, coordinators: their grades) | ✔ | ✔ | |
| import_export (CSV import; also allows exports) | | | |
| view_reports (development scores, class reports, CSV exports) | ✔ | ✔ | |
| record_attendance | | ✔ | ✔ |
| create_assignments (for subjects they teach) | | ✔ | ✔ |
| enter_marks (for subjects they teach) | | ✔ | ✔ |
| message_parents | ✔ | ✔ | |
| manage_timetable (class periods; class teachers: own class, coordinators: their grades) | ✔ | ✔ | |
| edit_student_timetables (personal timetables of students in their own class) | | ✔ | |

✔ = default. A principal/director can switch any unlocked permission on or off
per role in **School → Settings → Role permissions**. Overrides are stored in
`institution_role_permissions` and audited.

### Timetables

- **Class timetable** (`class_periods`): anyone who can manage the class, plus holders of
  `manage_timetable` — class teachers for their own class, coordinators for their grades,
  heads everywhere. `manage_timetable` doesn't allow changing the class, subjects or enrolment.
- **Students' personal timetables**: only the class teacher of a (non-archived) class the
  student is enrolled in, with `edit_student_timetables`. They see the student's timetables
  (time slots, activities, notes and the change history) — never ticks, streaks or progress
  — and edit through `teacher_apply_timetable_change()`: one transaction, refused if the
  timetable changed meanwhile, recorded in the student's History with the teacher's name,
  written to the audit log (`student_timetable`). The student gets a notification and can
  undo the change. Coordinators, subject teachers and heads have no access to personal
  timetables. Access ends when the permission is switched off, the class is archived, the
  student leaves the class or either membership is suspended.

### Parent links and messages

- A **student** starts a link (parent’s email, name, relationship) — nobody else can,
  parents included. It is approved by the student’s **class teacher** (of a current,
  non-archived class) or anyone with `manage_students`, then activated by
  the parent through a one-time email link. The student, approver or a head can revoke
  it with a reason; access stops immediately.
- **Parents** can message their child’s class teacher, subject teachers, in-scope
  coordinators and the principal/director.
- **Staff** need `message_parents` to start a conversation, and only about students in
  classes they can see. Any staff member can reply in a thread a parent started with them.
- Conversations are readable only by their two participants — not even principals.
- **Announcements**: heads post anywhere (staff announcements are head-only);
  coordinators within their grades; class teachers to their own class.

## Scope rules (always on top of permissions)

- **Coordinators** see and manage classes only in grades listed in their scope.
  Institution-wide calendar events need an “all grades” (`*`) scope.
- **Class / subject teachers** see a class only if they are its class teacher or
  teach a subject in it, and see only the students enrolled in those classes.
- **Subject scope** (`can_view_subject()`): academic records — assessments, marks,
  homework submissions and reviews, and the summaries, progress counts, exports and
  study insights built from them — are visible to a **subject teacher only for the
  subjects they teach** in that class. Class teachers see every subject of their own
  class, coordinators every subject in their grades, heads everything. Assignment titles
  and deadlines stay visible to all teachers of the class (the cross-subject deadline
  calendar needs them); attendance is class-wide.
- **Assignments** can be created only for a (class, subject) the teacher is
  assigned to. Students see only *published* assignments of their own classes.
- **Deadline changes** proposed by anyone are applied only when the
  assignment’s teacher, or a head/coordinator with `approve_deadline_changes`,
  approves them.
- **Nobody can change their own role or access**; role changes are only
  between coordinator / class teacher / subject teacher and need `manage_staff`, which
  only the principal or director can hold. So **only a principal or director can make
  or remove a coordinator**. Coordinators assign subject teachers to classes in their
  grades (`manage_classes`); class and subject teachers can't, unless a head grants their
  role `manage_classes`. A role change records who, when, old and new role and a
  reason in the audit history, and notifies the person. Refused attempts are written to
  the database log (`access_denied` lines in Supabase → Logs → Postgres).
- **Removing** someone means suspending or revoking their membership: they are
  signed out everywhere, their institutional data access stops immediately, and
  academic records are kept.

## Study insights

| Who | Sees |
|---|---|
| Student | All their subjects: status, reasons, recent results, suggested time; their own confidence ratings and study plan |
| Subject teacher | Only the subjects they teach, for students in those classes (School → Study insights) |
| Class teacher / coordinator / head | Every subject of the classes they can see |
| Linked parent | A summary per subject (status and reasons, no individual results or self-ratings) |
| Platform owner, other schools, other students | Nothing |

Only heads (`manage_institution_settings`) change the rules (School → Settings → Study
insights). Study plans change only the student's own personal timetable, only its study
sessions, and only when the student saves them (or has chosen automatic mode); nobody at
school sees the personal timetable through this feature.
