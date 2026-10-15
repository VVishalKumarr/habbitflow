import { useEffect, useRef, useState } from 'react'

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** True once the element has scrolled into view (stays true). */
export function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || inView) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true)
          io.disconnect()
        }
      },
      { threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView, threshold])
  return [ref, inView] as const
}

/** Animates a number towards `target` (ease-out), starting when `run` is true. */
export function useCountUp(target: number, run = true, ms = 900) {
  const [value, setValue] = useState(run && !reducedMotion() ? 0 : target)
  const from = useRef(value)
  useEffect(() => {
    if (!run) return
    if (reducedMotion()) {
      setValue(target)
      return
    }
    const start = performance.now()
    const begin = from.current
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const v = begin + (target - begin) * (1 - (1 - t) ** 3)
      from.current = v
      setValue(v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, run, ms])
  return Math.round(value)
}

/** Wraps children in a block that rises into view on scroll. */
export function useRevealClass(delay = 0) {
  const [ref, inView] = useInView<HTMLDivElement>(0.15)
  return { ref, className: `reveal ${inView ? 'reveal-in' : ''}`, style: { transitionDelay: `${delay}ms` } }
}
