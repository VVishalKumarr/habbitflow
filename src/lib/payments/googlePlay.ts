// Google Play Billing provider (Android app).
//
// Google Play requires digital subscriptions bought inside the app to use
// Play Billing, so the Android app never opens the web checkout.
//
// Not connected yet: it needs a native billing plugin (for example
// cordova-plugin-purchase / "CdvPurchase", or RevenueCat's Capacitor SDK), a
// Play Console subscription product, and the google-play-verify server
// function secrets. Until then this provider reports itself unavailable.
// Wiring steps: PLAY_STORE_CHECKLIST.md → "Billing".
//
// When wired, the flow is:
//   1. launch the purchase with obfuscatedAccountId = the user's id
//   2. send { purchaseToken, productId } to callFunction('google-play-verify')
//   3. the server verifies with Google, stores the subscription, acknowledges it
//   4. reload entitlements
import type { PaymentProvider } from './index'

export function googlePlayProvider(): PaymentProvider {
  return {
    id: 'google_play',
    unavailableReason: 'Upgrading inside the Android app isn’t available yet. If you already have a paid plan, it works here too.',
    checkout: async () => {
      throw new Error('Google Play Billing is not connected yet.')
    },
  }
}
