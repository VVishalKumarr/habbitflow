import { appConfig } from '../../config'
import { callFunction } from '../functions'
import type { Region } from '../region'
import type { BillingInterval, CheckoutResult, PaymentProvider } from './index'

interface RazorpayResponse {
  razorpay_payment_id: string
  razorpay_subscription_id: string
  razorpay_signature: string
}

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (ev: string, fn: () => void) => void }
  }
}

let scriptPromise: Promise<void> | null = null
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve()
    s.onerror = () => {
      scriptPromise = null
      reject(new Error('Could not load the payment window. Check your connection.'))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

export function razorpayProvider(region: Region): PaymentProvider {
  return {
    id: 'razorpay',
    unavailableReason: null,
    async checkout(plan: string, interval: BillingInterval, ctx): Promise<CheckoutResult> {
      await loadCheckout()
      const { subscription_id, key_id } = await callFunction<{ subscription_id: string; key_id: string }>('billing', {
        action: 'create',
        plan,
        interval,
        region,
      })
      return new Promise((resolve, reject) => {
        const rzp = new window.Razorpay!({
          key: key_id,
          subscription_id,
          name: appConfig.name,
          description: `${appConfig.name} ${plan.charAt(0).toUpperCase() + plan.slice(1)} (${interval})`,
          notes: { username: ctx.username },
          theme: { color: '#5750e0' },
          handler: async (res: RazorpayResponse) => {
            try {
              const r = await callFunction<{ status: string }>('billing', { action: 'verify', ...res })
              resolve({ status: r.status === 'active' ? 'completed' : 'pending' })
            } catch (e) {
              reject(e)
            }
          },
          modal: { ondismiss: () => resolve({ status: 'cancelled' }) },
        })
        rzp.open()
      })
    },
    async cancel() {
      await callFunction('billing', { action: 'cancel' })
    },
  }
}
