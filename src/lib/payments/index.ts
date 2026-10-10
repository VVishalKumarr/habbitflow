// PaymentService: one interface, one implementation per provider.
// The rest of the app only calls getPaymentService().
//
// Web      -> by pricing region: India (₹) uses Razorpay; other regions need an
//             international provider (Lemon Squeezy / Stripe slots, not connected yet)
// Android  -> Google Play Billing (required by Play for digital subscriptions;
//             never an external web checkout inside the app)
//
// No provider ever marks the user as Pro in the browser: after checkout the
// server verifies the payment and the app re-reads entitlements.
import { paymentsConfig } from '../../config'
import { isNative } from '../native'
import type { Region } from '../region'
import { googlePlayProvider } from './googlePlay'
import { razorpayProvider } from './razorpay'

export type BillingInterval = 'monthly' | 'yearly'

export interface CheckoutResult {
  status: 'completed' | 'cancelled' | 'pending'
}

export interface PaymentProvider {
  id: 'razorpay' | 'stripe' | 'lemonsqueezy' | 'google_play' | 'none'
  /** Human explanation when checkout can't be offered here. */
  unavailableReason: string | null
  checkout: (plan: string, interval: BillingInterval, ctx: { username: string }) => Promise<CheckoutResult>
  /** Cancel at the end of the paid period (where the provider allows it from the app). */
  cancel?: () => Promise<void>
}

const unavailable = (reason: string): PaymentProvider => ({
  id: 'none',
  unavailableReason: reason,
  checkout: async () => {
    throw new Error(reason)
  },
})

export function getPaymentService(region: Region = 'IN'): PaymentProvider {
  if (isNative) return googlePlayProvider()
  switch (paymentsConfig.web) {
    case 'razorpay':
      // Razorpay charges the Indian (₹) prices; other regions need an international provider.
      if (region !== 'IN') return unavailable('Payments outside India are coming soon.')
      return paymentsConfig.razorpayKeyId ? razorpayProvider() : unavailable('Online payments aren’t set up yet.')
    case 'stripe':
    case 'lemonsqueezy':
      return unavailable('This payment provider isn’t connected yet.')
    default:
      return unavailable('Online payments aren’t available yet.')
  }
}
