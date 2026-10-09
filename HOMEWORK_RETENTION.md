# Homework files: uploads, review and automatic deletion

## Rules

| Rule | Where it’s enforced |
|---|---|
| Submission window: start before deadline, at most **one calendar month** | `assignments` check constraint (+ the form) |
| Review/retention interval **0–14 days**, set by coordinators/heads | `validate_institution` trigger, `set_homework_retention()`; teachers can’t change it on an assignment |
| Files: **PDF, JPG, PNG**, max **4 MB**, max 5 per attempt | `homework` function checks size, declared type and the file signature (`%PDF-`, `FF D8 FF`, PNG header); bucket limits as a second line |
| Only enrolled students of the class, only while the window is open (late uploads only if the assignment allows, and marked late) | `homework_upload_check()` |
| Work counts as submitted only when a file is stored and recorded | `homework_record_file()`; students have no write access to `submissions` |
| Teachers own review status (accept / request resubmission / reject if the institution allows / under review) | `review_submission()`; feedback is required for resubmission and rejection |
| Files are private; links last 2 minutes | private `homework` bucket with no client policies; `homework` function issues signed URLs after `homework_file_path()` approves |

## When files are deleted

A file becomes eligible for deletion **`review_retention_days` after the latest of**:

1. the assignment deadline,
2. the student’s last upload (late or resubmitted work gets the full review period), and
3. while a resubmission is pending, the time the teacher asked for it.

### Exceptions

- **Retention hold**: a coordinator/head can put an assignment on hold (for example
  an open appeal) with a reason. While held, nothing is deleted. Releasing the hold
  makes the files eligible again under the normal rule. Both actions are audited.
- A **pending resubmission** pushes the date back as described in rule 3.

## What is deleted and what is kept

- **Deleted**: the file object in storage. After that no signed URL can be issued and
  the app shows the file name struck through.
- **Kept**: the submission row (status, timestamps, late flag, attempt), review
  history, feedback, and marks, which are academic records. For each deleted file,
  `homework_file_deletions` keeps the minimum metadata: institution, assignment,
  submission and file ids, submission status, deadline, review deadline, scheduled
  date, actual deletion time and reason. File contents and URLs are not kept.

## The job

- `pg_cron` job **`homework-retention`** runs hourly at minute 17 and POSTs to the
  `homework-retention` Edge Function with a secret stored in Supabase Vault.
- The function asks `homework_retention_candidates()` for up to 200 files at a time,
  deletes the objects through the Storage API, then calls `homework_mark_deleted()`.
- **Idempotent and retryable**: if the storage deletion fails, nothing is marked and
  the next run retries. Marking skips files that are already marked or are no longer
  eligible (for example, put on hold in the meantime). Removing an object that’s
  already gone succeeds.
- **Auditable**: `homework_file_deletions` (readable by heads and coordinators),
  `submission_files.deleted_at/deletion_reason`, and the audit log.

### Setting up or rotating the job

```bash
node --env-file=.env scripts/setup-retention-job.mjs
```

This generates a new secret, stores it as the `RETENTION_JOB_SECRET` function secret
and in Vault, and (re)creates the cron job. Check it in the dashboard
(Integrations → Cron) or with `select * from cron.job_run_details order by start_time desc limit 5;`.
Function logs: Dashboard → Edge Functions → homework-retention → Logs.

## Legal note

The 14-day maximum and the minimal metadata kept are product rules. Check them
against each institution’s record-keeping policy and the applicable law (for
example India’s DPDP Act for children’s data) before launch. Use retention holds
where a longer period is required.
