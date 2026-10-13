// Email one-time codes: logging in without a password, and confirming the
// account's email. The server functions check every code; a login only
// finishes through Supabase Auth with a one-time token the server issues
// after the code is right.
import { callFunction } from './functions'
import { supabase } from './supabase'

/** Whether the server can send email at all (before Resend is set up it can't). */
export async function emailConfigured(): Promise<boolean> {
  try {
    const r = await callFunction<{ email_configured: boolean }>('account-email', { action: 'status' })
    return r.email_configured
  } catch {
    return false
  }
}

export const sendLoginCode = (identifier: string) =>
  callFunction<{ request_id: string; message: string }>('login-code', { action: 'send', identifier: identifier.trim() })

/** Returns the usernames to choose from when one email has several accounts; otherwise signs in. */
export async function verifyLoginCode(requestId: string, code: string, username?: string): Promise<{ choose?: string[] }> {
  const r = await callFunction<{ token_hash?: string; choose?: string[] }>('login-code', { action: 'verify', request_id: requestId, code, username })
  if (r.choose) return { choose: r.choose }
  const { error } = await supabase.auth.verifyOtp({ token_hash: r.token_hash!, type: 'magiclink' })
  if (error) throw new Error('That code has expired. Please ask for a new one.')
  return {}
}

/** Sends a confirmation code to a new email for the signed-in account. */
export const sendEmailCode = (email: string, password?: string) =>
  callFunction<{ ok: boolean; pending_email: string }>('account-email', { action: 'send', email: email.trim(), password })

export const confirmEmailCode = (code: string) => callFunction<{ ok: boolean; email: string }>('account-email', { action: 'verify', code })

export const cleanCodeInput = (raw: string) => raw.replace(/\D/g, '').slice(0, 6)
