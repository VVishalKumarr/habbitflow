import { supabase } from './supabase'

export class FunctionError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** the whole JSON error body (e.g. quota details: limit, used, resets_at) */
    public details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/**
 * Calls a Supabase Edge Function and returns its JSON. Throws FunctionError
 * with the server's friendly message; status 0 means the function couldn't be
 * reached (not deployed, offline…).
 */
export async function callFunction<T = unknown>(name: string, body: Record<string, unknown> | FormData): Promise<T> {
  const { data, error, response } = await supabase.functions.invoke(name, { body }) as {
    data: unknown
    error: { message?: string; context?: Response } | null
    response?: Response
  }
  if (!error) return data as T
  const res = error.context ?? response
  if (res && typeof res.json === 'function') {
    const payload = (await res.json().catch(() => null)) as ({ error?: string; code?: string } & Record<string, unknown>) | null
    throw new FunctionError(payload?.error ?? 'Something went wrong. Please try again.', res.status, payload?.code, payload ?? undefined)
  }
  throw new FunctionError('The service is unavailable right now. Please try again later.', 0, 'unreachable')
}
