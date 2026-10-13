// PaymentService: one interface, one implementation per provider.
// The rest of the app only calls getPaymentService().
//
// Web      -> by pricing region: India (₹) uses Razorpay; other regions ($) use
//             Stripe (when VITE_STRIPE_PUBLISHABLE_KEY is set)
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
import { stripeProvider } from './stripe'

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
  const razorpay = paymentsConfig.web === 'razorpay' && paymentsConfig.razorpayKeyId
  const stripe = (paymentsConfig.web === 'stripe' || paymentsConfig.web === 'razorpay') && paymentsConfig.stripePublishableKey
  // Razorpay charges the Indian (₹) prices; Stripe the international ($) ones.
  if (region === 'IN') {
    if (razorpay) return razorpayProvider()
    return unavailable(stripe ? 'Payments in rupees are coming soon. Switch to international prices to pay by card.' : 'Online payments aren’t available yet.')
  }
  if (stripe) return stripeProvider()
  return unavailable(razorpay ? 'Payments outside India are coming soon.' : 'Online payments aren’t available yet.')
}
