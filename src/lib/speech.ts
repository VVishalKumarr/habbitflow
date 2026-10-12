// Push-to-talk speech → text. Recognition runs in the browser (Web Speech
// API) or on the phone (Android speech service via the Capacitor plugin);
// HabbitFlow never receives or stores audio, only the recognised text.
import { useCallback, useEffect, useRef, useState } from 'react'
import { isNative } from './native'

interface WebRecognition {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => WebRecognition

const webCtor = (): RecognitionCtor | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type SpeechState = 'idle' | 'listening' | 'unsupported'

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied. Allow it in your browser or phone settings, or type instead.',
  'service-not-allowed': 'Speech recognition isn’t allowed here. Type your command instead.',
  'no-speech': 'I didn’t hear anything. Try again.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs an internet connection.',
}

/** onText receives the final transcript. Speech is only captured while listening (explicit tap). */
export function useSpeech(onText: (text: string) => void) {
  const [state, setState] = useState<SpeechState>(() => (isNative || webCtor() ? 'idle' : 'unsupported'))
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<WebRecognition | null>(null)
  const cb = useRef(onText)
  cb.current = onText

  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    import('@capacitor-community/speech-recognition')
      .then(({ SpeechRecognition }) => SpeechRecognition.available())
      .then((r) => !cancelled && !r.available && setState('unsupported'))
      .catch(() => !cancelled && setState('unsupported'))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => rec.current?.abort(), [])

  const start = useCallback(async () => {
    setError(null)
    setInterim('')
    if (isNative) {
      try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
        const perm = await SpeechRecognition.requestPermissions()
        if (perm.speechRecognition !== 'granted') {
          setError(ERRORS['not-allowed'])
          return
        }
        setState('listening')
        const res = await SpeechRecognition.start({ language: navigator.language || 'en-US', maxResults: 1, partialResults: false, popup: false })
        const text = res.matches?.[0]?.trim()
        if (text) cb.current(text)
        else setError(ERRORS['no-speech'])
      } catch (e) {
        setError(e instanceof Error && /permission/i.test(e.message) ? ERRORS['not-allowed'] : 'Speech recognition failed. Try again or type instead.')
      } finally {
        setState('idle')
      }
      return
    }
    const Ctor = webCtor()
    if (!Ctor) return setState('unsupported')
    const r = new Ctor()
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.maxAlternatives = 1
    r.continuous = false
    let finalText = ''
    r.onresult = (e) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript
        if (e.results[i].isFinal) finalText = text
      }
      setInterim(text)
    }
    r.onerror = (e) => {
      if (e.error !== 'aborted') setError(ERRORS[e.error] ?? 'Speech recognition failed. Try again or type instead.')
    }
    r.onend = () => {
      setState('idle')
      setInterim('')
      rec.current = null
      if (finalText.trim()) cb.current(finalText.trim())
    }
    rec.current = r
    setState('listening')
    try {
      r.start()
    } catch {
      setState('idle')
      setError('Speech recognition failed. Try again or type instead.')
    }
  }, [])

  const stop = useCallback(async () => {
    if (isNative) {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
      await SpeechRecognition.stop().catch(() => {})
    } else rec.current?.stop()
  }, [])

  return { state, interim, error, start, stop, supported: state !== 'unsupported' }
}
