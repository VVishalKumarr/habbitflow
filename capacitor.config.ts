import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.habbitflow.app',
  appName: 'HabbitFlow',
  webDir: 'dist',
  android: {
    // Keep the WebView behind the status/navigation bars; the web app handles safe areas.
    adjustMarginsForEdgeToEdge: 'auto',
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: 'LIGHT',
      backgroundColor: '#ffffff',
    },
  },
}

export default config
