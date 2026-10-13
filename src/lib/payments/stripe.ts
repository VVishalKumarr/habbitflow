import { callFunction } from '../functions'
import type { BillingInterval, CheckoutResult, PaymentProvider } from './index'

/**
 * Stripe Checkout (prices outside India, in $). The server creates a Checkout
 * page and the browser goes there; Stripe returns to /pro?checkout=success and
 * the plan is granted from the verified webhook, never from the browser.
 */
export function stripeProvider(): PaymentProvider {
  return {
    id: 'stripe',
    unavailableReason: null,
    async checkout(plan: string, interval: BillingInterval): Promise<CheckoutResult> {
      const { url } = await callFunction<{ url: string }>('billing', { action: 'stripe_checkout', plan, interval })
      window.location.assign(url)
      return { status: 'pending' }
    },
    async cancel() {
      await callFunction('billing', { action: 'cancel' })
    },
  }
}

/** Stripe's own page for changing card, cancelling and downloading invoices. */
export async function openStripePortal(): Promise<void> {
  const { url } = await callFunction<{ url: string }>('billing', { action: 'stripe_portal' })
  window.location.assign(url)
}
