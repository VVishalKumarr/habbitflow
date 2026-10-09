// Scheduled homework file deletion (no user session).
// Called hourly by pg_cron (see HOMEWORK_RETENTION.md) with the
// x-job-secret header, which must equal the RETENTION_JOB_SECRET secret.
//
// Each run: ask the database which files are past their review/retention
// interval, delete those objects from the private bucket, then mark them
// deleted (which also writes homework_file_deletions). If storage deletion
// fails, nothing is marked and the next run retries. Marking is idempotent,
// so overlapping or repeated runs are safe.
import { adminClient, env } from '../_shared/http.ts'

const BATCH = 200
const MAX_BATCHES = 10

function sameSecret(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const secret = env('RETENTION_JOB_SECRET')
  if (!secret || !sameSecret(req.headers.get('x-job-secret') ?? '', secret)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  }

  const admin = adminClient()
  let deleted = 0
  let failedBatches = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await admin.rpc('homework_retention_candidates', { p_limit: BATCH })
    if (error) {
      console.error('retention candidates failed', error.message)
      failedBatches++
      break
    }
    const rows = (data ?? []) as { file_id: string; storage_path: string }[]
    if (rows.length === 0) break
    const removed = await admin.storage.from('homework').remove(rows.map((r) => r.storage_path))
    if (removed.error) {
      console.error('retention storage delete failed', removed.error.message)
      failedBatches++
      break
    }
    // Objects already missing count as deleted (e.g. a previous run removed them but failed to mark).
    const { data: n, error: markError } = await admin.rpc('homework_mark_deleted', {
      p_files: rows.map((r) => r.file_id),
      p_reason: 'review/retention interval expired',
    })
    if (markError) {
      console.error('retention mark failed', markError.message)
      failedBatches++
      break
    }
    deleted += (n as number) ?? 0
    if (rows.length < BATCH) break
  }
  console.log(`homework retention: deleted ${deleted} file(s), ${failedBatches} failed batch(es)`)
  return new Response(JSON.stringify({ ok: failedBatches === 0, deleted }), { headers: { 'Content-Type': 'application/json' } })
})
