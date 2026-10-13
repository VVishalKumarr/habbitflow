// One-time email codes (login and email confirmation). Pure functions, no
// imports: used by the Edge Functions and the unit tests.

export const CODE_LENGTH = 6
export const CODE_TTL_MINUTES = 10
export const CODE_MAX_ATTEMPTS = 5

/** A uniformly random 6-digit code ("000000"–"999999"). */
export function newCode(): string {
  const limit = 4_000_000_000 // largest multiple of 1e6 below 2^32: no modulo bias
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return String(buf[0] % 1_000_000).padStart(CODE_LENGTH, '0')
}

/** Only this hash is stored. Salted with the request id so equal codes never share a hash. */
export async function hashCode(salt: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${code}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Accepts "123456", "123 456" or "123-456"; null if it isn't 6 digits. */
export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = raw.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}
