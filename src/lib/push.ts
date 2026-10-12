// Push notifications on this device: browsers (Web Push with the server's
// VAPID key, shown by public/sw.js) and the Android app (Firebase Cloud
// Messaging, only when the app is built with VITE_ANDROID_PUSH=true and
// android/app/google-services.json — see NOTIFICATIONS.md).
import { envFlag } from '../config/env'
import { callFunction } from './functions'
import { isNative } from './native'
import { supabase } from './supabase'

export interface ChannelConfig {
  email: boolean
  web_push: boolean
  vapid_public_key: string | null
  android_push: boolean
}

let config: Promise<ChannelConfig> | null = null
export const channelConfig = () =>
  (config ??= callFunction<ChannelConfig>('notifications', { action: 'config' }).catch((e) => {
    config = null
    throw e
  }))

export const androidPushBuilt = () => isNative && envFlag('VITE_ANDROID_PUSH', false)

/** What this device can do. */
export function pushSupport(): 'web' | 'android' | 'android-not-built' | 'unsupported' {
  if (isNative) return androidPushBuilt() ? 'android' : 'android-not-built'
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'web' : 'unsupported'
}

const swUrl = () => `${import.meta.env.BASE_URL}sw.js`

const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0))
const b64url = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '')

function deviceLabel(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return `${browser}${os ? ` on ${os}` : ''}`
}

/** Is this browser currently subscribed? */
export async function webPushEnabled(): Promise<boolean> {
  if (pushSupport() !== 'web' || Notification.permission !== 'granted') return false
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  return !!(await reg?.pushManager.getSubscription())
}

/** Asks for permission, subscribes this browser and registers it with the account. */
export async function enableWebPush(): Promise<void> {
  const cfg = await channelConfig()
  if (!cfg.vapid_public_key) throw new Error('Push notifications aren’t set up on the server yet.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser’s site settings.')
  const reg = await navigator.serviceWorker.register(swUrl(), { scope: import.meta.env.BASE_URL })
  await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && b64url(sub.options.applicationServerKey) !== cfg.vapid_public_key) {
    await sub.unsubscribe() // the server's keys changed
    sub = null
  }
  // Some browsers (e.g. headless or with push blocked by policy) never answer: give up after 40 s.
  sub ??= await Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.vapid_public_key) }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('This browser couldn’t reach its push service. Try again later or use another browser.')), 40_000)),
  ])
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  const { error } = await supabase.rpc('register_push_subscription', {
    p_kind: 'web', p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth, p_label: deviceLabel(),
  })
  if (error) throw error
}

export async function disableWebPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  const { error } = await supabase.rpc('unregister_push_subscription', { p_endpoint: sub.endpoint })
  if (error) throw error
  await sub.unsubscribe()
}

/** Android: permission, Firebase token → account. Resolves once the token is saved. */
export async function enableAndroidPush(): Promise<void> {
  const { PushNotifications } = await import('@capacitor/push-notifications')
  const perm = await PushNotifications.requestPermissions()
  if (perm.receive !== 'granted') throw new Error('Notifications are turned off for HabbitFlow in Android settings.')
  await PushNotifications.createChannel({ id: 'default', name: 'Notifications', importance: 4 }).catch(() => {})
  await new Promise<void>((resolve, reject) => {
    PushNotifications.addListener('registration', async ({ value }) => {
      const { error } = await supabase.rpc('register_push_subscription', { p_kind: 'fcm', p_endpoint: value, p_p256dh: null, p_auth: null, p_label: 'HabbitFlow app on Android' })
      if (error) reject(error)
      else resolve()
    })
    PushNotifications.addListener('registrationError', (e) => reject(new Error(e.error)))
    PushNotifications.register().catch(reject)
  })
}

/** Android: opening a notification goes to its page. Call once at start-up. */
export async function listenForPushTaps(navigate: (path: string) => void): Promise<void> {
  if (!androidPushBuilt()) return
  const { PushNotifications } = await import('@capacitor/push-notifications')
  await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    const link = (a.notification.data as { link?: string } | undefined)?.link
    if (link && /^\/[\w/?=&.-]*$/.test(link)) navigate(link)
  })
}
