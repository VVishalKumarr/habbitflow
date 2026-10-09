// Phase 2 tests: homework uploads and review, private storage, retention job,
// attendance, marks — against the real Supabase project.
// Run: node --env-file=.env tests/institutions-phase2.test.mjs
import assert from 'node:assert/strict'
import { adminSql, buildSchool, cleanup, day, fn, one, passedCount, runRetentionJob, test } from './helpers.mjs'

const suffix = Date.now().toString(36)
const pdf = (extra = '') => new TextEncoder().encode(`%PDF-1.4\n% test ${extra}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`)
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
function form(assignment, bytes, name, type) {
  const f = new FormData()
  f.append('action', 'upload')
  f.append('assignment_id', assignment)
  f.append('file', new Blob([bytes], { type }), name)
  return f
}

console.log('Institution phase 2 tests')
let W
try {
  W = await buildSchool(suffix)
  const { instA, principal, principalB, coord, classT, subjT, s1, s2, maths, science, class10a } = W
  const base = { institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership }
  const hw = await one(subjT.c.from('assignments').insert({ ...base, title: 'Algebra', opens_at: day(-1), due_at: day(2) }).select().single())
  const closed = await one(subjT.c.from('assignments').insert({ ...base, title: 'Closed', opens_at: day(-5), due_at: day(-1), late_policy: 'reject' }).select().single())
  const lateOk = await one(subjT.c.from('assignments').insert({ ...base, title: 'Late OK', opens_at: day(-5), due_at: day(-1) }).select().single())
  const future = await one(subjT.c.from('assignments').insert({ ...base, title: 'Future', opens_at: day(3), due_at: day(6) }).select().single())
  const pdfOnly = await one(subjT.c.from('assignments').insert({ ...base, title: 'PDF only', opens_at: day(-1), due_at: day(2), allowed_types: ['pdf'] }).select().single())
  let fileId, submissionId

  await test('student uploads a valid PDF; work is recorded as submitted and confirmed', async () => {
    const r = await fn('homework', form(hw.id, pdf('a'), 'algebra.pdf', 'application/pdf'), s1.c)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    fileId = r.body.file_id
    submissionId = r.body.submission_id
    const sub = await one(s1.c.from('submissions').select('status, attempt, is_late').eq('id', submissionId).single())
    assert.deepEqual(sub, { status: 'submitted', attempt: 1, is_late: false })
    const notes = await one(s1.c.from('notifications').select('kind'))
    assert.ok(notes.some((n) => n.kind === 'submission_received'))
  })

  await test('files over 4 MB are rejected', async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 10)
    big.set(pdf())
    const r = await fn('homework', form(hw.id, big, 'big.pdf', 'application/pdf'), s1.c)
    assert.equal(r.status, 413)
  })

  await test('unsupported or disguised files are rejected by their contents', async () => {
    const txt = await fn('homework', form(hw.id, new TextEncoder().encode('hello'), 'notes.pdf', 'application/pdf'), s1.c)
    assert.equal(txt.status, 415)
    const mismatch = await fn('homework', form(hw.id, png, 'image.pdf', 'application/pdf'), s1.c)
    assert.equal(mismatch.status, 415)
    assert.equal(mismatch.body.code, 'type_mismatch')
    const notAllowed = await fn('homework', form(pdfOnly.id, png, 'photo.png', 'image/png'), s1.c)
    assert.equal(notAllowed.status, 415)
    const exe = await fn('homework', form(hw.id, new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'x.exe', 'application/octet-stream'), s1.c)
    assert.equal(exe.status, 415)
  })

  await test('only enrolled students can upload, inside the submission window', async () => {
    const other = await fn('homework', form(hw.id, pdf(), 'x.pdf', 'application/pdf'), s2.c)
    assert.match(other.body.error, /not found/)
    const teacher = await fn('homework', form(hw.id, pdf(), 'x.pdf', 'application/pdf'), subjT.c)
    assert.match(teacher.body.error, /not found/)
    const outsider = await fn('homework', form(hw.id, pdf(), 'x.pdf', 'application/pdf'), principalB.c)
    assert.match(outsider.body.error, /not found/)
    const early = await fn('homework', form(future.id, pdf(), 'x.pdf', 'application/pdf'), s1.c)
    assert.match(early.body.error, /open on/)
    const late = await fn('homework', form(closed.id, pdf(), 'x.pdf', 'application/pdf'), s1.c)
    assert.match(late.body.error, /deadline has passed/)
    const lateAccepted = await fn('homework', form(lateOk.id, pdf(), 'late.pdf', 'application/pdf'), s1.c)
    assert.equal(lateAccepted.status, 200)
    assert.equal(lateAccepted.body.late, true)
  })

  await test('students cannot mark work submitted or accepted themselves', async () => {
    const { data: upd } = await s1.c.from('submissions').update({ status: 'accepted' }).eq('id', submissionId).select()
    assert.ok(!upd?.length)
    const { error } = await s1.c.from('submissions').insert({ institution_id: instA, assignment_id: future.id, student_id: s1.membership, status: 'submitted' })
    assert.ok(error)
    const { error: e2 } = await s1.c.rpc('review_submission', { p_submission: submissionId, p_status: 'accepted' })
    assert.ok(e2)
    const { error: e3 } = await s1.c.rpc('homework_record_file', { p_actor: s1.id, p_assignment: hw.id, p_path: 'x', p_name: 'x', p_mime: 'application/pdf', p_size: 1, p_sha256: 'a'.repeat(64) })
    assert.ok(e3, 'server-only function')
  })

  await test('private storage: signed URLs only for the owner and reviewers; no direct bucket access', async () => {
    const mine = await fn('homework', { action: 'url', file_id: fileId }, s1.c)
    assert.equal(mine.status, 200)
    assert.equal(mine.body.expires_in, 120)
    const dl = await fetch(mine.body.url)
    assert.equal(dl.status, 200)
    assert.ok((await dl.text()).startsWith('%PDF-'))
    assert.equal((await fn('homework', { action: 'url', file_id: fileId }, subjT.c)).status, 200)
    assert.equal((await fn('homework', { action: 'url', file_id: fileId }, s2.c)).status, 404)
    assert.equal((await fn('homework', { action: 'url', file_id: fileId }, principalB.c)).status, 404)
    const path = (await adminSql(`select storage_path from public.submission_files where id = '${fileId}'`))[0].storage_path
    const direct = await s1.c.storage.from('homework').download(path)
    assert.ok(direct.error, 'direct download refused')
    const listed = await s1.c.storage.from('homework').list(instA)
    assert.ok(!listed.data?.length, 'nothing listable')
    const up = await s1.c.storage.from('homework').upload(`${instA}/x.pdf`, pdf(), { contentType: 'application/pdf' })
    assert.ok(up.error, 'direct upload refused')
    const { data: cols, error } = await s1.c.from('submission_files').select('storage_path')
    assert.ok(error || !cols?.length, 'storage path not exposed')
  })

  await test('review: resubmission needs a comment, notifies, and opens a new attempt', async () => {
    const { error: noComment } = await subjT.c.rpc('review_submission', { p_submission: submissionId, p_status: 'resubmission_requested' })
    assert.match(noComment?.message ?? '', /what to change/)
    const { error: s2err } = await classT.c.rpc('review_submission', { p_submission: submissionId, p_status: 'accepted' })
    assert.ok(s2err, 'science teacher cannot review maths work')
    await one(subjT.c.rpc('review_submission', { p_submission: submissionId, p_status: 'resubmission_requested', p_comment: 'Show your working for Q3.' }))
    const notes = await one(s1.c.from('notifications').select('kind, body').eq('kind', 'submission_reviewed'))
    assert.equal(notes[0].body, 'Show your working for Q3.')
    const again = await fn('homework', form(hw.id, pdf('v2'), 'algebra-v2.pdf', 'application/pdf'), s1.c)
    assert.equal(again.status, 200)
    assert.equal(again.body.attempt, 2)
    const reviews = await one(s1.c.from('submission_reviews').select('status, comment'))
    assert.equal(reviews.length, 1)
  })

  await test('students can remove a file before review, not after', async () => {
    const extra = await fn('homework', form(hw.id, pdf('extra'), 'extra.pdf', 'application/pdf'), s1.c)
    assert.equal((await fn('homework', { action: 'remove', file_id: extra.body.file_id }, s1.c)).status, 200)
    await one(subjT.c.rpc('review_submission', { p_submission: submissionId, p_status: 'accepted', p_comment: 'Good work' }))
    const after = await fn('homework', form(hw.id, pdf('v3'), 'v3.pdf', 'application/pdf'), s1.c)
    assert.match(after.body.error, /already reviewed/)
    const sub = await one(s1.c.from('submissions').select('status, feedback').eq('id', submissionId).single())
    assert.deepEqual(sub, { status: 'accepted', feedback: 'Good work' })
  })

  await test('rejection follows institution policy', async () => {
    const sub = (await adminSql(`select id from public.submissions where assignment_id = '${lateOk.id}'`))[0].id
    await one(principal.c.from('institutions').update({ settings: { allow_rejection: false } }).eq('id', instA))
    const { error } = await subjT.c.rpc('review_submission', { p_submission: sub, p_status: 'rejected', p_comment: 'Copied' })
    assert.match(error?.message ?? '', /doesn't allow rejecting/)
    await one(principal.c.from('institutions').update({ settings: {} }).eq('id', instA))
    await one(subjT.c.rpc('review_submission', { p_submission: sub, p_status: 'rejected', p_comment: 'Copied' }))
  })

  await test('coordinators see submission progress; other institutions see nothing', async () => {
    const prog = await one(coord.c.rpc('assignment_progress', { p_assignments: [hw.id] }))
    assert.equal(prog[0].submitted, 1)
    assert.equal(prog[0].accepted, 1)
    for (const t of ['submissions', 'submission_reviews', 'attendance_records', 'assessments', 'marks']) {
      assert.equal((await one(principalB.c.from(t).select('id'))).length, 0, t)
    }
    assert.equal((await one(principalB.c.rpc('assignment_progress', { p_assignments: [hw.id] }))).length, 0)
  })

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  await test('attendance: class teacher daily, subject teacher for their subject only', async () => {
    assert.equal(await one(classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: [{ student_id: s1.membership, status: 'present' }] })), 1)
    const { error: daily } = await subjT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: [{ student_id: s1.membership, status: 'absent' }] })
    assert.ok(daily, 'subject teacher cannot record daily attendance')
    assert.equal(await one(subjT.c.rpc('record_attendance', { p_class: class10a, p_subject: maths, p_date: today, p_period: 2, p_entries: [{ student_id: s1.membership, status: 'late' }] })), 1)
    const { error: wrongSubject } = await subjT.c.rpc('record_attendance', { p_class: class10a, p_subject: science, p_date: today, p_period: 3, p_entries: [{ student_id: s1.membership, status: 'present' }] })
    assert.ok(wrongSubject)
    const { error: student } = await s1.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: [{ student_id: s1.membership, status: 'present' }] })
    assert.ok(student)
    const { error: futureDay } = await classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: day(3).slice(0, 10), p_period: 0, p_entries: [] })
    assert.match(futureDay?.message ?? '', /future/)
    const { error: notEnrolled } = await classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: [{ student_id: s2.membership, status: 'present' }] })
    assert.match(notEnrolled?.message ?? '', /enrolled/)
    const { error: badStatus } = await classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: [{ student_id: s1.membership, status: 'vacation' }] })
    assert.match(badStatus?.message ?? '', /Unknown attendance status/)
    const { error: direct } = await classT.c.from('attendance_records').update({ status: 'absent' }).eq('student_id', s1.membership)
    assert.ok(direct, 'no direct writes')
  })

  await test('attendance corrections need a reason and keep the previous value', async () => {
    const entries = [{ student_id: s1.membership, status: 'excused' }]
    const { error } = await classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: entries })
    assert.match(error?.message ?? '', /needs a reason/)
    await one(classT.c.rpc('record_attendance', { p_class: class10a, p_subject: null, p_date: today, p_period: 0, p_entries: entries, p_reason: 'Medical note received' }))
    const audit = await one(principal.c.from('audit_log').select('old_value, new_value, reason').eq('record_type', 'attendance_records').eq('action', 'update'))
    assert.ok(audit.some((a) => a.old_value.status === 'present' && a.new_value.status === 'excused' && a.reason === 'Medical note received'))
    const mine = await one(s1.c.from('attendance_records').select('status, period'))
    assert.equal(mine.length, 2)
    assert.equal((await one(s2.c.from('attendance_records').select('id'))).length, 0)
  })

  let assessment
  await test('marks: validated against the maximum, only by the subject’s teacher', async () => {
    assessment = await one(subjT.c.from('assessments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'Unit test 1', kind: 'internal', max_marks: 50, assessment_date: today }).select().single())
    const { error: forged } = await subjT.c.from('assessments').insert({ institution_id: instA, class_id: class10a, subject_id: maths, teacher_id: subjT.membership, title: 'x', kind: 'internal', max_marks: 50, assessment_date: today, status: 'published' })
    assert.ok(forged, 'new assessments start as drafts')
    for (const bad of [51, -1]) {
      const { error } = await subjT.c.rpc('save_marks', { p_assessment: assessment.id, p_entries: [{ student_id: s1.membership, obtained: bad }] })
      assert.ok(error, `obtained ${bad} refused`)
    }
    const { error: other } = await classT.c.rpc('save_marks', { p_assessment: assessment.id, p_entries: [{ student_id: s1.membership, obtained: 40 }] })
    assert.ok(other, 'science teacher cannot enter maths marks')
    assert.equal(await one(subjT.c.rpc('save_marks', { p_assessment: assessment.id, p_entries: [{ student_id: s1.membership, obtained: 45, feedback: 'Strong algebra' }] })), 1)
    const { error: direct } = await subjT.c.from('marks').update({ obtained: 50 }).eq('assessment_id', assessment.id)
    assert.ok(direct, 'no direct writes')
    const { error: lower } = await subjT.c.from('assessments').update({ max_marks: 40 }).eq('id', assessment.id)
    assert.match(lower?.message ?? '', /more marks than the new maximum/)
  })

  await test('students see marks only after publishing, and get notified', async () => {
    assert.equal((await one(s1.c.from('marks').select('id'))).length, 0)
    assert.equal((await one(s1.c.from('assessments').select('id'))).length, 0)
    assert.equal(await one(subjT.c.rpc('publish_assessment', { p_assessment: assessment.id })), 1)
    const m = await one(s1.c.from('marks').select('obtained, feedback'))
    assert.deepEqual(m, [{ obtained: 45, feedback: 'Strong algebra' }])
    assert.equal((await one(s2.c.from('marks').select('id'))).length, 0)
    const notes = await one(s1.c.from('notifications').select('kind'))
    assert.ok(notes.some((n) => n.kind === 'marks_published'))
    assert.equal(await one(s1.c.rpc('grade_for', { p_inst: instA, p_pct: 90 })), 'A2')
  })

  await test('published marks corrections need a reason and are audited', async () => {
    const { error } = await subjT.c.rpc('save_marks', { p_assessment: assessment.id, p_entries: [{ student_id: s1.membership, obtained: 47, feedback: 'Strong algebra' }] })
    assert.match(error?.message ?? '', /needs a reason/)
    await one(subjT.c.rpc('save_marks', { p_assessment: assessment.id, p_entries: [{ student_id: s1.membership, obtained: 47, feedback: 'Strong algebra' }], p_reason: 'Re-totalled page 2' }))
    const audit = await one(principal.c.from('audit_log').select('old_value, new_value, reason').eq('record_type', 'marks').eq('action', 'update'))
    assert.ok(audit.some((a) => Number(a.old_value.obtained) === 45 && Number(a.new_value.obtained) === 47 && a.reason === 'Re-totalled page 2'))
  })

  await test('dashboard summary uses the real records', async () => {
    const sum = await one(principal.c.rpc('academic_summary', { p_inst: instA }))
    assert.equal(sum.attendance.records, 2)
    assert.equal(sum.marks.marks, 1)
    assert.ok(sum.homework.expected >= 1)
    const mine = await one(s2.c.rpc('academic_summary', { p_inst: instA }))
    assert.equal(mine.attendance.records, 0)
    assert.equal(mine.marks.marks, 0)
  })

  await test('retention job deletes expired files only, keeps records, honours holds and pending resubmissions', async () => {
    const r403 = await fn('homework-retention', {}, null, { 'x-job-secret': 'wrong' })
    assert.equal(r403.status, 403)
    // hold on "Late OK": its file must survive
    const { error: noPerm } = await subjT.c.rpc('set_retention_hold', { p_assignment: lateOk.id, p_hold: true, p_reason: 'Appeal' })
    assert.ok(noPerm, 'subject teachers cannot place holds')
    await one(coord.c.rpc('set_retention_hold', { p_assignment: lateOk.id, p_hold: true, p_reason: 'Plagiarism appeal open' }))
    // a fresh resubmission request on another assignment must also survive
    const pending = await one(subjT.c.from('assignments').insert({ ...base, title: 'Pending', opens_at: day(-1), due_at: day(1) }).select().single())
    const pf = await fn('homework', form(pending.id, pdf('p'), 'p.pdf', 'application/pdf'), s1.c)
    await one(subjT.c.rpc('review_submission', { p_submission: pf.body.submission_id, p_status: 'resubmission_requested', p_comment: 'Redo' }))
    // time travel: deadlines and uploads 20 days ago (retention is 7 days)
    await adminSql(`
      update public.assignments set opens_at = now() - interval '25 days', due_at = now() - interval '20 days' where id in ('${hw.id}', '${lateOk.id}', '${pending.id}');
      update public.submissions set last_submitted_at = now() - interval '20 days' where assignment_id in ('${hw.id}', '${lateOk.id}', '${pending.id}');`)
    const files = await adminSql(`select f.id, f.storage_path, s.assignment_id from public.submission_files f join public.submissions s on s.id = f.submission_id
                                  where s.assignment_id in ('${hw.id}', '${lateOk.id}', '${pending.id}') and f.deleted_at is null`)
    await runRetentionJob()
    const after = await adminSql(`select f.id, f.deleted_at is not null as gone, s.assignment_id from public.submission_files f join public.submissions s on s.id = f.submission_id
                                  where f.id in (${files.map((f) => `'${f.id}'`).join(',')})`)
    for (const f of after) {
      if (f.assignment_id === hw.id) assert.ok(f.gone, 'expired file deleted')
      else assert.ok(!f.gone, 'held / pending-resubmission file kept')
    }
    const hwPaths = files.filter((f) => f.assignment_id === hw.id).map((f) => `'${f.storage_path}'`)
    const objects = await adminSql(`select count(*)::int n from storage.objects where bucket_id = 'homework' and name in (${hwPaths.join(',')})`)
    assert.equal(objects[0].n, 0, 'storage objects removed')
    assert.equal((await fn('homework', { action: 'url', file_id: fileId }, s1.c)).status, 404, 'access revoked')
    const log = await one(coord.c.from('homework_file_deletions').select('reason, submission_status, due_at, review_deadline, deleted_at').eq('assignment_id', hw.id))
    assert.ok(log.length >= 2 && log.every((l) => l.reason === 'review/retention interval expired' && l.submission_status === 'accepted'))
    const sub = await one(s1.c.from('submissions').select('status').eq('id', submissionId).single())
    assert.equal(sub.status, 'accepted', 'academic record kept')
    // idempotent: a second run deletes nothing more for these
    const before = (await adminSql(`select count(*)::int n from public.homework_file_deletions where assignment_id = '${hw.id}'`))[0].n
    await runRetentionJob()
    assert.equal((await adminSql(`select count(*)::int n from public.homework_file_deletions where assignment_id = '${hw.id}'`))[0].n, before)
    assert.equal((await one(s1.c.from('homework_file_deletions').select('id'))).length, 0, 'students cannot read the deletion log')
  })
} finally {
  await cleanup(suffix)
}
console.log(`\n${passedCount()} passed`)
