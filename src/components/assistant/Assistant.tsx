import { BookOpen, Bot, Send, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { contextHint, searchHelp, type HelpArticle } from '../../content/help'
import { aiConfig } from '../../config'
import { analytics, cleanPath } from '../../lib/analytics'
import { quotaMessage, QUOTA_CODES } from '../../lib/aiQuota'
import { callFunction, FunctionError } from '../../lib/functions'
import { pushBackHandler } from '../../store/ui'
import { Spinner } from '../ui/Spinner'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  /** answered from the built-in help (AI unavailable) */
  articles?: HelpArticle[]
}

const SUGGESTIONS: Record<string, string[]> = {
  '/dashboard': ['How do I add a new time slot?', 'How do I add a task?', 'How do I create another timetable?'],
  '/progress': ['What does this graph mean?', 'How are streaks counted?', 'How do I see 90 days?'],
  '/focus': ['How does the Pomodoro timer work?', 'Can I change the timer length?'],
  '/friends': ['How do I add a friend?', 'What can my friends see?'],
  '/settings': ['How do I change my username?', 'How do I add a recovery email?'],
  '/pro': ['What’s the difference between Plus and Pro?', 'How do I upgrade?'],
}

function suggestionsFor(path: string) {
  const key = Object.keys(SUGGESTIONS).find((k) => path.startsWith(k))
  return key ? SUGGESTIONS[key] : ['How do I create a tracker?', 'How do I mark a task complete?', 'How do I see my progress?']
}

function fallbackAnswer(question: string, path: string): Msg {
  const articles = searchHelp(question, path)
  if (!articles.length) {
    return {
      role: 'assistant',
      content: 'I couldn’t find that in the help articles. Try rephrasing, or browse all help topics.',
      articles: [],
    }
  }
  const a = articles[0]
  const steps = a.sections.flatMap((s) => s.body).slice(0, 4).join('\n')
  return { role: 'assistant', content: `${a.title}\n${steps}`, articles }
}

/** Floating help assistant (signed-in app only). */
export function Assistant() {
  const { pathname } = useLocation()
  const path = cleanPath(pathname)
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => inputRef.current?.focus())
    return pushBackHandler(() => setOpen(false))
  }, [open])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, busy])

  if (!aiConfig.assistantEnabled) return null

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return
    setInput('')
    const history = messages.slice(-8).map(({ role, content }) => ({ role, content }))
    setMessages((m) => [...m, { role: 'user', content: q }])
    if (offline) {
      setMessages((m) => [...m, fallbackAnswer(q, path)])
      return
    }
    setBusy(true)
    try {
      // request_id: a retry of the same question is never charged twice
      const res = await callFunction<{ answer: string }>('assistant', { question: q, page: path, history, request_id: crypto.randomUUID() })
      setMessages((m) => [...m, { role: 'assistant', content: res.answer }])
    } catch (e) {
      const err = e as FunctionError
      // Limits: explain (and when they reset), then answer from the help articles.
      // Not configured / unreachable: switch to the help articles for the session.
      const limited = QUOTA_CODES.has(err.code ?? '')
      if (!limited) setOffline(err.code === 'ai_not_configured' || err.status === 0 || err.status === 404)
      const fb = fallbackAnswer(q, path)
      if (limited) fb.content = `${quotaMessage(err)}\n\n${fb.content}`
      setMessages((m) => [...m, fb])
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    ask(input)
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            analytics.track('assistant_opened', { source: path.split('/')[1] || 'home' })
          }}
          className="fixed right-4 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-30 flex h-12 items-center gap-2 rounded-full bg-brand pr-4 pl-3.5 text-sm font-semibold text-white shadow-pop transition-colors hover:bg-brand-hover md:right-6 md:bottom-6"
          aria-label="Open AI Assistant"
        >
          <Sparkles className="size-5" aria-hidden="true" />
          <span className="hidden sm:inline">Assistant</span>
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-modal="false"
          aria-labelledby="assistant-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
          className="fixed inset-x-2 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex max-h-[min(34rem,calc(100dvh-9rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop sm:inset-x-auto sm:right-4 sm:w-[24rem] md:right-6 md:bottom-6 md:max-h-[min(36rem,calc(100dvh-6rem))]"
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <Bot className="size-[18px]" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="assistant-title" className="text-sm font-semibold">
                AI Assistant
              </h2>
              <p className="text-xs text-muted">{offline ? 'Answering from the help articles' : 'Answers questions about using HabitFlow'}</p>
            </div>
            <button type="button" className="icon-btn size-9" onClick={() => setOpen(false)} aria-label="Close assistant">
              <X className="size-[18px]" aria-hidden="true" />
            </button>
          </header>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            <div className="rounded-xl bg-subtle px-3.5 py-3 text-sm">{contextHint(path)}</div>
            {messages.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {suggestionsFor(path).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    className="rounded-full border border-line px-3 py-1.5 text-left text-xs font-medium text-muted hover:bg-subtle hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <p key={i} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-sm break-words text-white">
                  {m.content}
                </p>
              ) : (
                <div key={i} className="max-w-[92%] rounded-2xl rounded-bl-md border border-line px-3.5 py-2.5 text-sm">
                  <p className="break-words whitespace-pre-line">{m.content}</p>
                  {m.articles && (
                    <div className="mt-2 flex flex-wrap gap-2 border-t border-line pt-2">
                      {m.articles.map((a) => (
                        <Link key={a.slug} to={`/help/${a.slug}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" onClick={() => setOpen(false)}>
                          <BookOpen className="size-3.5" aria-hidden="true" />
                          {a.title}
                        </Link>
                      ))}
                      <Link to="/help" className="text-xs font-medium text-muted hover:underline" onClick={() => setOpen(false)}>
                        All help topics
                      </Link>
                    </div>
                  )}
                </div>
              ),
            )}
            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted" role="status">
                <Spinner className="size-4" /> Thinking…
              </p>
            )}
          </div>

          <form onSubmit={submit} className="flex items-center gap-2 border-t border-line p-3">
            <label htmlFor="assistant-input" className="sr-only">
              Ask a question
            </label>
            <input
              id="assistant-input"
              ref={inputRef}
              className="input h-10 flex-1"
              placeholder="Ask how to do something…"
              value={input}
              maxLength={1000}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="icon-btn size-10 bg-brand text-white hover:bg-brand-hover hover:text-white" disabled={busy || !input.trim()} aria-label="Send">
              <Send className="size-4" aria-hidden="true" />
            </button>
          </form>
          <p className="px-4 pb-3 text-[11px] text-muted">The assistant can’t see or change your data. Don’t share passwords or personal details.</p>
        </section>
      )}
    </>
  )
}
