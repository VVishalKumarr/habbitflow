import type { Session } from '@supabase/supabase-js'
import { create } from 'zustand'
import { LOGIN_DOMAIN, normalizeUsername, usernameToLogin } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

type Status = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthState {
  status: Status
  session: Session | null
  profile: Profile | null
  init: () => () => void
  signIn: (username: string, password: string) => Promise<void>
  /** Institutional accounts sign in with their approved email address. */
  signInInstitution: (email: string, password: string) => Promise<void>
  signUp: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  updateProfile: (
    patch: Partial<Pick<Profile, 'week_start' | 'time_format' | 'theme' | 'last_tracker_id' | 'accent_theme' | 'leaderboard_opt_in' | 'share_progress'>>,
  ) => Promise<void>
  /** Local update after a server-side username change. */
  setUsername: (username: string) => void
  deleteAccount: () => Promise<void>
}

const THEME_KEY = 'habitflow-theme'

export function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* storage unavailable */
  }
}

export function storedTheme(): 'light' | 'dark' {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single()
  if (error) throw error
  return data as Profile
}

/** One profile request per user at a time (startup can trigger several loads at once). */
let inflight: { userId: string; promise: Promise<Profile> } | null = null
function fetchProfileOnce(userId: string): Promise<Profile> {
  if (inflight?.userId !== userId) {
    const promise = fetchProfile(userId).finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
    inflight = { userId, promise }
  }
  return inflight.promise
}

/** Bumped on every local profile change so a slower, older fetch can't overwrite it. */
let profileVersion = 0

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  session: null,
  profile: null,

  init: () => {
    const load = async (session: Session | null) => {
      if (!session) {
        set({ status: 'unauthenticated', session: null, profile: null })
        return
      }
      // Avoid refetching the profile on silent token refreshes.
      if (get().profile?.id === session.user.id) {
        set({ session, status: 'authenticated' })
        return
      }
      try {
        const version = profileVersion
        const profile = await fetchProfileOnce(session.user.id)
        const current = get().profile
        // Keep local edits made while this request was in flight.
        if (current?.id === profile.id && version !== profileVersion) {
          set({ status: 'authenticated', session })
          return
        }
        applyTheme(profile.theme)
        set({ status: 'authenticated', session, profile })
      } catch {
        // Session exists locally but the account is gone / token invalid.
        await supabase.auth.signOut({ scope: 'local' })
        set({ status: 'unauthenticated', session: null, profile: null })
      }
    }

    supabase.auth.getSession().then(({ data }) => load(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') return
      // Defer: calling Supabase inside this callback can deadlock the auth lock.
      setTimeout(() => load(session), 0)
    })
    return () => data.subscription.unsubscribe()
  },

  signIn: async (username, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email: usernameToLogin(username), password })
    if (error) {
      if (/invalid login credentials/i.test(error.message)) throw new Error('Incorrect username or password.')
      throw new Error(friendlyError(error))
    }
  },

  signInInstitution: async (email, password) => {
    const login = email.trim().toLowerCase()
    if (login.endsWith(`@${LOGIN_DOMAIN}`)) throw new Error('Use the personal account login for usernames.')
    const { data, error } = await supabase.auth.signInWithPassword({ email: login, password })
    if (error) {
      if (/invalid login credentials/i.test(error.message)) throw new Error('Incorrect email or password.')
      throw new Error(friendlyError(error))
    }
    // Personal accounts never have a real email login, so this is an institutional account.
    if (data.user && !data.user.email?.endsWith(`@${LOGIN_DOMAIN}`)) return
    await supabase.auth.signOut()
    throw new Error('Incorrect email or password.')
  },

  signUp: async (username, password) => {
    const { data, error } = await supabase.auth.signUp({
      email: usernameToLogin(username),
      password,
      options: { data: { username: normalizeUsername(username) } },
    })
    if (error) {
      if (/already registered|already exists/i.test(error.message)) throw new Error('That username is already taken.')
      if (/database error/i.test(error.message)) throw new Error('That username is not allowed. Try another one.')
      if (/password/i.test(error.message)) throw new Error(error.message)
      throw new Error(friendlyError(error))
    }
    // Supabase hides duplicate sign-ups behind a fake user with no identities.
    if (data.user && data.user.identities?.length === 0) throw new Error('That username is already taken.')
    if (!data.session) {
      // Email confirmation is on in the project: sign in explicitly so the user lands in the app.
      await get().signIn(username, password)
    }
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ status: 'unauthenticated', session: null, profile: null })
  },

  updateProfile: async (patch) => {
    const profile = get().profile
    if (!profile) return
    profileVersion++
    set({ profile: { ...profile, ...patch } })
    if (patch.theme) applyTheme(patch.theme)
    const { error } = await supabase.from('profiles').update(patch).eq('id', profile.id)
    if (error) {
      // Undo only the fields this call changed.
      const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, profile[k as keyof Profile]]))
      const now = get().profile
      if (now) set({ profile: { ...now, ...undo } })
      if (patch.theme) applyTheme(profile.theme)
      throw new Error(friendlyError(error))
    }
  },

  setUsername: (username) => {
    const profile = get().profile
    profileVersion++
    if (profile) set({ profile: { ...profile, username } })
  },

  deleteAccount: async () => {
    const { error } = await supabase.rpc('delete_account')
    if (error) throw new Error(friendlyError(error))
    await supabase.auth.signOut({ scope: 'local' })
    set({ status: 'unauthenticated', session: null, profile: null })
  },
}))
