import { useCallback, useEffect, useRef, useState } from 'react'
import { friendlyError } from './errors'

/**
 * Runs an async loader when its dependencies change and keeps the latest
 * result. `reload()` refetches without clearing what is on screen.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps)

  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    try {
      const value = await run()
      if (id === seq.current) {
        setData(value)
        setError(null)
      }
    } catch (e) {
      if (id === seq.current) setError(friendlyError(e))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [run])

  useEffect(() => {
    reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}

/** Throws the Supabase error so useLoad can show it. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error
  return res.data as T
}
