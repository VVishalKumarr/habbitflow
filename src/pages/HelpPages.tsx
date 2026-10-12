import { ArrowLeft, BookOpen, ChevronRight, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { AdSlot } from '../components/ads/AdSlot'
import { HELP_ARTICLES, searchHelp, type HelpSection } from '../content/help'

function Body({ section }: { section: HelpSection }) {
  // Group consecutive list lines into <ul>/<ol>.
  const blocks: { type: 'p' | 'ul' | 'ol'; items: string[] }[] = []
  for (const line of section.body) {
    const type = line.startsWith('- ') ? 'ul' : /^\d+\. /.test(line) ? 'ol' : 'p'
    const text = type === 'ul' ? line.slice(2) : type === 'ol' ? line.replace(/^\d+\. /, '') : line
    const last = blocks[blocks.length - 1]
    if (type !== 'p' && last?.type === type) last.items.push(text)
    else blocks.push({ type, items: [text] })
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.type === 'p' ? (
          <p key={i} className="mt-3 leading-relaxed">
            {b.items[0]}
          </p>
        ) : b.type === 'ul' ? (
          <ul key={i} className="mt-3 list-disc space-y-1.5 pl-5 leading-relaxed">
            {b.items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="mt-3 list-decimal space-y-1.5 pl-5 leading-relaxed">
            {b.items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        ),
      )}
    </>
  )
}

export function HelpIndexPage() {
  const [q, setQ] = useState('')
  const results = useMemo(() => (q.trim().length > 2 ? searchHelp(q) : null), [q])
  const list = results ?? HELP_ARTICLES.filter((a) => a.public)
  useEffect(() => {
    document.title = 'Help — HabbitFlow'
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-sm font-semibold text-brand">Help &amp; resources</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">How can we help?</h1>
      <div className="relative mt-6">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden="true" />
        <label htmlFor="help-search" className="sr-only">
          Search help
        </label>
        <input id="help-search" className="input h-12 pl-11" placeholder="Search, e.g. “add a time slot”" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {results && results.length === 0 && <p className="mt-6 text-muted">No articles matched. Try different words.</p>}
      <ul className="mt-6 space-y-3">
        {list.map((a) => (
          <li key={a.slug}>
            <Link to={`/help/${a.slug}`} className="card group flex items-center gap-4 p-5 transition-colors hover:border-brand/40">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <BookOpen className="size-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{a.title}</span>
                <span className="mt-0.5 block text-sm text-muted">{a.description}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function HelpArticlePage() {
  const { slug } = useParams()
  const article = HELP_ARTICLES.find((a) => a.slug === slug)
  useEffect(() => {
    if (article) document.title = `${article.title} — HabbitFlow Help`
  }, [article])
  if (!article) return <Navigate to="/help" replace />
  const others = HELP_ARTICLES.filter((a) => a.slug !== article.slug).slice(0, 4)

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <Link to="/help" className="btn-ghost -ml-3">
        <ArrowLeft className="size-4" aria-hidden="true" />
        All help topics
      </Link>
      <article className="mt-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{article.title}</h1>
        <p className="mt-3 text-lg text-muted">{article.description}</p>
        {article.sections.map((s, i) => (
          <section key={i} className="mt-8">
            {s.heading && <h2 className="text-xl font-semibold">{s.heading}</h2>}
            <Body section={s} />
          </section>
        ))}
      </article>
      <AdSlot placement="help" className="mt-12" />
      <nav aria-label="More help" className="mt-12 border-t border-line pt-8">
        <h2 className="font-semibold">More help</h2>
        <ul className="mt-3 space-y-2">
          {others.map((a) => (
            <li key={a.slug}>
              <Link to={`/help/${a.slug}`} className="text-brand hover:underline">
                {a.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
