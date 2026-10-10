import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { pushBackHandler } from '../../store/ui'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

let openCount = 0
/** Open dialogs, top-most last: Escape closes only the top one. */
const escStack: symbol[] = []

/** Accessible dialog: centered card on desktop, bottom sheet on phones. */
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const removeBack = pushBackHandler(() => onCloseRef.current())
    openCount++
    document.body.style.overflow = 'hidden'

    // Focus the first input if present, else the panel itself.
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('input, textarea, select') ?? panel
    requestAnimationFrame(() => first?.focus({ preventScroll: true }))

    // Escape works even before focus has moved into the dialog.
    const me = Symbol('modal')
    escStack.push(me)
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || escStack[escStack.length - 1] !== me) return
      e.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onEscape, true)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (items.length === 0) return
        const firstEl = items[0]
        const lastEl = items[items.length - 1]
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault()
          lastEl.focus()
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault()
          firstEl.focus()
        }
      }
    }
    panel?.addEventListener('keydown', onKey)
    return () => {
      panel?.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onEscape, true)
      escStack.splice(escStack.indexOf(me), 1)
      removeBack()
      openCount--
      if (openCount === 0) document.body.style.overflow = ''
      previouslyFocused?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  const width = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`animate-sheet relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-line bg-surface shadow-pop outline-none sm:rounded-2xl ${width}`}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <div className="flex items-start gap-3 px-5 pt-4 pb-2 sm:pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn -mt-1 -mr-2" onClick={onClose} aria-label="Close dialog">
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5">{children}</div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
