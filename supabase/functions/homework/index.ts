// Homework files (signed in).
// POST multipart/form-data { action: 'upload', assignment_id, file }
// POST { action: 'url', file_id }     → short-lived signed URL (2 minutes)
// POST { action: 'remove', file_id }  → student removes a file before review
//
// The "homework" bucket is private with no client storage policies, so every
// file goes through here. The database decides who may upload or read
// (homework_upload_check / homework_record_file / homework_file_path); this
// function checks the actual file: size, declared type and file signature.
import { adminClient, json, preflight, rateLimited, readJson, userFromRequest } from '../_shared/http.ts'

const MAX_BYTES = 4 * 1024 * 1024
const SIGNED_URL_SECONDS = 120
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Kind = { ext: 'pdf' | 'jpg' | 'png'; mime: string }

/** Detects the real format from the first bytes; null if it isn't PDF, JPEG or PNG. */
function sniff(bytes: Uint8Array): Kind | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { ext: 'pdf', mime: 'application/pdf' } // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' }
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', mime: 'image/png' }
  return null
}

const DECLARED: Record<string, Kind['ext']> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' }

async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const cleanName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(0, 120) || 'file'

Deno.serve(async (req) => {
  const early = preflight(req)
  if (early) return early

  const who = await userFromRequest(req)
  if (!who) return json(req, { error: 'Please log in again.' }, 401)
  const admin = adminClient()
  const type = req.headers.get('content-type') ?? ''

  if (type.startsWith('multipart/form-data')) {
    // Reject oversized bodies before reading them.
    const length = Number(req.headers.get('content-length') ?? '0')
    if (length > MAX_BYTES + 64 * 1024) return json(req, { error: 'Files can be at most 4 MB.', code: 'too_large' }, 413)
    if (await rateLimited(who.user.id, 'homework_upload', 60, 3600)) {
      return json(req, { error: 'Too many uploads. Please try again later.', code: 'rate_limited' }, 429)
    }
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return json(req, { error: 'The upload could not be read. Please try again.' }, 400)
    }
    const assignmentId = String(form.get('assignment_id') ?? '')
    const file = form.get('file')
    if (!uuid.test(assignmentId)) return json(req, { error: 'Assignment not found.' }, 400)
    if (!(file instanceof File)) return json(req, { error: 'Choose a file to upload.' }, 400)
    if (file.size === 0) return json(req, { error: 'That file is empty.' }, 400)
    if (file.size > MAX_BYTES) return json(req, { error: 'Files can be at most 4 MB.', code: 'too_large' }, 413)

    const check = await admin.rpc('homework_upload_check', { p_actor: who.user.id, p_assignment: assignmentId })
    if (check.error) return json(req, { error: check.error.message }, 400)
    const c = check.data as { institution_id: string; student_id: string; allowed_types: string[]; max_file_mb: number }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const kind = sniff(bytes)
    if (!kind) return json(req, { error: 'Only PDF, JPG and PNG files can be uploaded.', code: 'bad_type' }, 415)
    const declared = DECLARED[file.type.toLowerCase()]
    if (file.type && declared !== kind.ext) {
      return json(req, { error: 'The file’s contents don’t match its type. Save it again as PDF, JPG or PNG.', code: 'type_mismatch' }, 415)
    }
    if (!c.allowed_types.includes(kind.ext)) {
      return json(req, { error: `This assignment accepts ${c.allowed_types.map((t) => t.toUpperCase()).join(', ')} only.`, code: 'bad_type' }, 415)
    }
    if (bytes.length > c.max_file_mb * 1024 * 1024) {
      return json(req, { error: `Files can be at most ${c.max_file_mb} MB for this assignment.`, code: 'too_large' }, 413)
    }

    const path = `${c.institution_id}/${assignmentId}/${c.student_id}/${crypto.randomUUID()}.${kind.ext}`
    const up = await admin.storage.from('homework').upload(path, bytes, { contentType: kind.mime, upsert: false })
    if (up.error) {
      console.error('homework upload failed', up.error.message)
      return json(req, { error: 'The file could not be stored. Please try again.' }, 502)
    }
    const rec = await admin.rpc('homework_record_file', {
      p_actor: who.user.id,
      p_assignment: assignmentId,
      p_path: path,
      p_name: cleanName(file.name),
      p_mime: kind.mime,
      p_size: bytes.length,
      p_sha256: await sha256(bytes),
    })
    if (rec.error) {
      await admin.storage.from('homework').remove([path])
      return json(req, { error: rec.error.message }, 400)
    }
    return json(req, { ok: true, ...(rec.data as Record<string, unknown>) })
  }

  const body = await readJson<{ action?: string; file_id?: string }>(req)
  if (!uuid.test(body?.file_id ?? '')) return json(req, { error: 'File not found.' }, 400)

  if (body?.action === 'url') {
    if (await rateLimited(who.user.id, 'homework_url', 300, 3600)) {
      return json(req, { error: 'Too many requests. Please try again later.', code: 'rate_limited' }, 429)
    }
    const { data: path } = await admin.rpc('homework_file_path', { p_actor: who.user.id, p_file: body.file_id })
    if (!path) return json(req, { error: 'This file isn’t available (it may have been deleted after the review period).' }, 404)
    const signed = await admin.storage.from('homework').createSignedUrl(path as string, SIGNED_URL_SECONDS)
    if (signed.error) return json(req, { error: 'This file isn’t available.' }, 404)
    return json(req, { url: signed.data.signedUrl, expires_in: SIGNED_URL_SECONDS })
  }

  if (body?.action === 'remove') {
    const { data: path, error } = await admin.rpc('homework_remove_file', { p_actor: who.user.id, p_file: body.file_id })
    if (error) return json(req, { error: error.message }, 400)
    await admin.storage.from('homework').remove([path as string])
    return json(req, { ok: true })
  }

  return json(req, { error: 'Unknown action.' }, 400)
})
