import { Bell } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../store/auth'
import { Dropdown } from '../ui/Dropdown'

interface Notification {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  created_at: string
  read_at: string | null
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 1440) return `${Math.round(m / 60)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** In-app notifications (reviews, marks, submissions…). Refreshes every minute and on open. */
export function NotificationBell() {
  const userId = useAuth((s) => s.session?.user.id)
  const [items, setItems] = useState<Notification[]>([])
  const navigate = useNavigate()

  const load = useCallback(async () => {
    if (!userId) return
    const { data } = await supabase.from('notifications').select('id, kind, title, body, link, created_at, read_at').order('created_at', { ascending: false }).limit(20)
    if (data) setItems(data as Notification[])
  }, [userId])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const unread = items.filter((n) => !n.read_at)
  const markAll = async () => {
    if (!unread.length) return
    const now = new Date().toISOString()
    setItems(items.map((n) => ({ ...n, read_at: n.read_at ?? now })))
    await supabase.from('notifications').update({ read_at: now }).in('id', unread.map((n) => n.id))
  }

  return (
    <Dropdown
      id="notifications"
      align="right"
      menuClassName="w-[min(22rem,calc(100vw-2rem))]"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          className="icon-btn relative"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            if (!open) load()
            toggle()
          }}
        >
          <Bell className="size-5" aria-hidden="true" />
          {unread.length > 0 && (
            <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
          <span className="sr-only">Notifications{unread.length ? `, ${unread.length} unread` : ''}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[70vh] overflow-y-auto">
          <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread.length > 0 && (
              <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul>
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-subtle"
                    onClick={async () => {
                      close()
                      if (!n.read_at) {
                        setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)))
                        await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id)
                      }
                      if (n.link) navigate(n.link)
                    }}
                  >
                    <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_at ? 'bg-transparent' : 'bg-brand'}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{n.title}</span>
                      {n.body && <span className="line-clamp-2 block text-xs text-muted">{n.body}</span>}
                      <span className="block text-[11px] text-muted">{ago(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dropdown>
  )
}
