import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { StatusBar, Style } from '@capacitor/status-bar'

export const isNative = Capacitor.isNativePlatform()

/** Save a JSON file: browser download on the web, share sheet on Android. */
export async function saveJsonFile(filename: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2)
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 })
    await Share.share({ title: 'HabbitFlow export', url: uri, dialogTitle: 'Save or share your data' })
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Save any file (CSV, PDF…): browser download on the web, share sheet on Android. */
export async function saveFile(filename: string, blob: Blob): Promise<void> {
  if (isNative) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })
    const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache })
    await Share.share({ title: filename, url: uri, dialogTitle: 'Save or share' })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Android hardware back: close overlays first, then go back, then exit from the home screen. */
export function registerBackButton(handler: () => void) {
  if (!isNative) return () => {}
  const sub = App.addListener('backButton', handler)
  return () => {
    sub.then((s) => s.remove())
  }
}

export const exitApp = () => App.exitApp()

export function syncStatusBar(theme: 'light' | 'dark') {
  if (!isNative) return
  StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light }).catch(() => {})
  StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#161922' : '#ffffff' }).catch(() => {})
}
