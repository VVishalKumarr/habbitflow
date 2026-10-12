// Transactional email via Resend (https://resend.com). Configure with the
// RESEND_API_KEY and EMAIL_FROM function secrets. EMAIL_FROM must use a
// domain you have verified in Resend, e.g. "HabbitFlow <no-reply@yourdomain.com>".
import { env } from './http.ts'

export const emailConfigured = () => Boolean(env('RESEND_API_KEY') && env('EMAIL_FROM'))

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Simple, accessible HTML email with one button. */
export function renderEmail(opts: { heading: string; lines: string[]; button?: { label: string; url: string }; footer: string }) {
  const p = (t: string) => `<p style="margin:0 0 14px;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#171a26">${escape(t)}</p>`
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6fa;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e5ec;border-radius:16px;padding:28px">
<h1 style="margin:0 0 16px;font:600 20px -apple-system,Segoe UI,Roboto,sans-serif;color:#171a26">${escape(opts.heading)}</h1>
${opts.lines.map(p).join('')}
${
  opts.button
    ? `<p style="margin:22px 0"><a href="${escape(opts.button.url)}" style="display:inline-block;background:#5750e0;color:#fff;text-decoration:none;font:600 15px -apple-system,Segoe UI,Roboto,sans-serif;padding:12px 20px;border-radius:12px">${escape(opts.button.label)}</a></p>
<p style="margin:0 0 14px;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#5f6578">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${escape(opts.button.url)}</span></p>`
    : ''
}
<p style="margin:18px 0 0;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#5f6578">${escape(opts.footer)}</p>
</div></body></html>`
  const text = [opts.heading, '', ...opts.lines, ...(opts.button ? ['', `${opts.button.label}: ${opts.button.url}`] : []), '', opts.footer].join('\n')
  return { html, text }
}

export async function sendEmail(to: string, subject: string, body: { html: string; text: string }): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM'), to: [to], subject, html: body.html, text: body.text }),
  })
  if (!res.ok) throw new Error(`Email provider returned ${res.status}`)
}
