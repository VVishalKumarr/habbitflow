# Reports, import and export (schools)

Everything here works only inside one institution and only on the classes and students
the signed-in person may see. Migrations: `supabase/migrations/2026-10-18_reports_phase7.sql`
and `2026-10-19_import_year_transition.sql`.

## Development score (1–10)

**School → Reports** (staff) and **Your development** on a student's overview.

| Part (default weight) | Based on | Needs at least |
|---|---|---|
| Academic results (35) | average % of *published* marks (draft marks never count) | 2 marks |
| Homework (20) | work due in the period: on time 1, late 0.6, resubmission requested 0.5, rejected 0.2, missing 0 | 3 pieces due |
| Attendance (15) | present 1, late 0.75, other 0; excused not counted | 10 records |
| Planning & habits (15) | ticked ÷ planned activities in the student's personal timetable, last 4 weeks — **only if the student shares it** | 2 weeks of activities |
| Extracurricular & skills (15) | programme check-ins against each programme's weekly target (last 12 weeks); +0.1 per completed skill/activity/health goal if shared (max +0.3) | one programme or shared goal |

- Each part is 0–1. Parts without enough data are **left out** and the remaining weights
  re-normalised. If less than half of the total weight has data, the result is
  **“insufficient data”** — never a low score.
- Score = 1 + 9 × weighted average, one decimal.
- **No reward for unhealthy schedules:** if the personal timetable has a day over 6 hours
  or anything after 23:00 / before 05:00, Planning & habits is capped at 60 %.
- Weights: **School → Settings → Development score weights** (principal/director; whole
  numbers adding up to 100; 0 switches a part off). New calculations use them.
- Default period: last 90 days. Every calculation is stored in `development_scores`
  (history). A weekly pg_cron job (`development-scores`, Mondays 02:15 UTC) calculates every
  active student; staff and students can recalculate any time (a repeat within 10 minutes
  returns the stored result).
- Explanations and suggestions are produced in the app (`src/lib/development.ts`) from the
  stored numbers.

Who sees scores: the student; staff with **view_reports** for a class the student is in
(principal/director always). Subject teachers don't have view_reports by default.

Privacy: a student's personal timetable stays private. Only with **Share my habit
consistency with my school** (off by default) do the planning numbers (counts, not tasks)
and completed skill goals count. Teachers never see the tasks or ticks.

## Programmes

**School → Programmes.** Development / habit programmes for the whole institution, a grade
or a class, with a weekly check-in target. Created by holders of **manage_programmes**:
heads anywhere, coordinators in their grades, class teachers for their own class.
Students see programmes open to them, join/leave and check in (once a day, for today or the
last 6 days). Staff see member counts, the 4-week check-in rate and each member's check-ins.

## CSV export

**School → Reports → Export CSV** (needs **view_reports** or **import_export**):

| Data | Columns |
|---|---|
| Attendance records | date, class, subject, period, student, admission no, status, note, correction reason |
| Marks | date, class, subject, assessment, type, draft/published, max, student, admission no, marks, absent, %, grade, feedback |
| Assignments | class, subject, teacher, title, type, status, opens, due, students, submitted, on time, accepted, missing |
| Development scores | latest score and each part per student |
| Class report | one class: score, attendance and hand-in rates, marks %, parts |

Files are UTF-8 with BOM (Excel-friendly); cells that start with `= + - @` are prefixed with
`'` so spreadsheets don't run them as formulas. Each export is written to the audit log (what
was exported and how many rows, not the data). Date ranges up to 400 days.

## PDF reports

From the student report ("Download PDF") and the class report ("PDF"). Generated on the
device with jsPDF — nothing is uploaded.

## CSV import

**School → Import** (needs **import_export**, heads by default; plus the normal permission
for each row). Choose a file → every row is checked (**preview**, nothing saved) → **Import**
only the rows marked Ready. Templates are downloadable on the page. Headers are matched
loosely (e.g. “Admission no”, “Student ID”); unknown columns are ignored and listed.

| Import | Columns | Notes |
|---|---|---|
| Students | Name, Email, Admission no, Class | needs manage_students; email must be on the approved list; with a class the student is enrolled when they activate (or straight away if they already have an account) |
| Teachers & staff | Name, Email, Staff no | needs manage_staff; **the role is chosen on the page for the whole file — a Role column in the file is ignored** |
| Classes | Name, Grade, Section, Class teacher | needs manage_classes for that grade; created in the current academic year; existing names skipped |
| Subject teachers | Class, Subject, Teacher | teacher by email or staff number; unknown subjects are created |

Row errors (invalid or duplicate emails or numbers, unknown classes or teachers, addresses
not on the approved list, no permission) are shown per line and those rows are left out.
People imports send invitation emails (or, in setup mode without email, return activation
links you can download as CSV — share each privately). Every import is recorded in
`import_runs` (shown under **Recent imports**) and in the audit log; refused attempts are
recorded too. Limits: 2,000 rows per file (500 for classes), 2 MB.

## Academic-year transition

**School → Settings → Academic years → Start next academic year** (principal/director).

1. Name and dates for the new year (pre-filled from the current one).
2. For each class: **Move up** (new grade and name, suggested: 10 A → 11 A), **Same grade
   again**, or **Graduate** (the top numeric grade is suggested to graduate).
3. Optionally keep the same class and subject teachers.

Then, in one transaction: the new year becomes current and the old one is archived; a new
class is created for every class that moves up or repeats, with its active students; every
old class is archived. **Nothing is deleted** — old classes keep their enrolments,
attendance, marks, assignments and timetable, and stay readable. Graduated students keep
their accounts (suspend them in People if needed). Individual students who should move
differently can be re-enrolled in Classes & subjects afterwards. The transition is audited.
