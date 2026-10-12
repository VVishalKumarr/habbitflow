// Single source of help content. Used by the public /help pages, the in-app
// assistant's offline fallback, and the AI assistant's knowledge (server side).
// Plain data only (no imports) so both Vite and Deno can load it.
//
// Body blocks: plain strings are paragraphs; "- " starts a bullet; "1. " a step.

export interface HelpSection {
  heading?: string
  body: string[]
}

export interface HelpArticle {
  slug: string
  title: string
  description: string
  /** words people use when asking about this topic (fallback search) */
  keywords: string[]
  /** app route the article is most relevant to */
  route?: string
  public: boolean
  sections: HelpSection[]
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: 'how-to-create-tracker',
    title: 'How to create a tracker',
    description: 'Trackers keep separate weekly timetables — for example a home routine, an exam schedule or a gym plan.',
    keywords: ['tracker', 'create tracker', 'new tracker', 'timetable', 'another timetable', 'rename', 'delete tracker', 'switch'],
    route: '/dashboard',
    public: true,
    sections: [
      {
        body: [
          'A tracker is one weekly timetable with its own time slots, tasks and progress. Use separate trackers when routines don’t mix — for example “School days” and “Holidays”.',
        ],
      },
      {
        heading: 'Create a tracker',
        body: [
          '1. Open the Dashboard.',
          '2. Click “New tracker” at the top right (or “Create tracker” if you have none yet). You can also open the tracker switcher and choose “Create new tracker”.',
          '3. Type a name (up to 60 characters) and click “Create tracker”.',
          'The new tracker opens straight away. Your other trackers are untouched.',
        ],
      },
      {
        heading: 'Switch, rename or delete',
        body: [
          '- Switch: open the tracker switcher next to “New tracker” and pick another tracker under “My trackers”.',
          '- Rename: click the pencil next to the tracker name (on phones, the ⋮ menu → “Rename tracker”).',
          '- Delete: click the bin icon next to “New tracker” (on phones, the ⋮ menu → “Delete tracker”). This permanently removes that tracker’s time slots, tasks and history.',
        ],
      },
      {
        heading: 'How many trackers can I have?',
        body: [
          'The Free plan includes a limited number of trackers (shown on the pricing page). Plus and Pro remove the limit. If you reach the limit, your existing trackers stay exactly as they are — you just can’t add another until you upgrade or delete one.',
        ],
      },
    ],
  },
  {
    slug: 'how-to-use-timetable',
    title: 'How to use the timetable',
    description: 'Add time slots and tasks to build a weekly routine that repeats every week.',
    keywords: ['time slot', 'slot', 'add task', 'task', 'edit task', 'move task', 'duplicate', 'timetable', 'schedule', 'week'],
    route: '/dashboard',
    public: true,
    sections: [
      {
        body: [
          'The timetable is a grid: days of the week across the top and your time slots down the side. Each task sits in one slot on one weekday and repeats every week.',
        ],
      },
      {
        heading: 'Add a time slot',
        body: [
          '1. On the Dashboard, click “Add time slot” at the top right of the Weekly timetable (on phones and tablets it’s at the bottom of the day view).',
          '2. Pick a start and end time and click “Add time slot”.',
          'Slots can be any length, but they can’t overlap. Touching slots (for example 9:00–10:00 and 10:00–11:00) are fine. Click a slot’s time to edit or delete it.',
        ],
      },
      {
        heading: 'Add a task',
        body: [
          '1. Click an empty cell in the grid (the slot and day you want).',
          '2. Enter a title, an optional description and a category, then save.',
          'The task now appears on that weekday every week. To change it, click the task and choose “Edit or move task”, “Duplicate to another day” or “Delete task”.',
        ],
      },
      {
        heading: 'Phones',
        body: [
          'On a phone the Dashboard shows one day at a time. Swipe left or right, or tap a day in the strip at the top, to change days.',
        ],
      },
    ],
  },
  {
    slug: 'how-to-track-habits',
    title: 'How to track your habits',
    description: 'Tick tasks off each day to build streaks. Completion is saved per date, so every week starts fresh.',
    keywords: ['complete', 'mark complete', 'tick', 'check', 'done', 'undo', 'incomplete', 'streak', 'today'],
    route: '/dashboard',
    public: true,
    sections: [
      {
        heading: 'Mark a task complete',
        body: [
          'Tap the circle next to a task to mark it done for that date. Tap it again to undo. You can also open a task and choose “Mark complete” or “Mark incomplete”.',
          'Completion is stored per calendar date, so ticking Monday’s task this week doesn’t tick it next week.',
        ],
      },
      {
        heading: 'Today',
        body: [
          'The Today panel lists everything scheduled today and shows how much is done. Use the week arrows to look back at earlier weeks and fill in anything you forgot.',
        ],
      },
      {
        heading: 'Streaks',
        body: [
          'Your streak counts consecutive days where every scheduled task was completed. A day that hasn’t finished yet never breaks your streak.',
        ],
      },
    ],
  },
  {
    slug: 'understanding-progress',
    title: 'Understanding your progress',
    description: 'What each statistic and chart on the Progress page means.',
    keywords: ['progress', 'statistics', 'stats', 'graph', 'chart', 'donut', 'completion rate', 'trend', 'weekly', 'performance', 'what does this graph mean'],
    route: '/progress',
    public: true,
    sections: [
      {
        body: [
          'The Progress page has two tabs: Timetable (tasks you tick off) and Pomodoro (focus sessions). They are tracked separately.',
        ],
      },
      {
        heading: 'Timetable statistics',
        body: [
          '- Overall completion: completed tasks ÷ scheduled tasks, from your first task up to today.',
          '- Completed today / Remaining today: what’s left on today’s timetable.',
          '- Weekly progress: the share of this week’s scheduled tasks you’ve completed.',
          '- Current and longest streak: days in a row where every scheduled task was done.',
        ],
      },
      {
        heading: 'Charts',
        body: [
          '- This week (bars): each day’s completion percentage.',
          '- Completion trend (line): your daily completion rate over 7, 30 or 90 days. Gaps are days with nothing scheduled.',
          '- Task performance: each habit ranked by how consistently you do it. Tap one for its own history and streak.',
          '- Completion (donut): completed versus scheduled tasks overall.',
        ],
      },
      {
        heading: 'Pomodoro statistics',
        body: [
          'Focus time today, this week and in total, number of sessions, your focus streak, a daily focus-minutes chart, and how your focus time is split between task names.',
        ],
      },
      {
        heading: 'History range',
        body: [
          'Free accounts see detailed charts for up to 30 days. Pro unlocks 90-day and full-history views.',
        ],
      },
    ],
  },
  {
    slug: 'how-to-use-focus-mode',
    title: 'How to use Focus mode (Pomodoro)',
    description: 'Work in focused blocks with short breaks, and name each session so you can see where your time goes.',
    keywords: ['focus', 'pomodoro', 'timer', 'break', 'session', 'sound', 'rain', 'white noise'],
    route: '/focus',
    public: true,
    sections: [
      {
        body: [
          'The Pomodoro technique alternates focused work with short breaks. By default: 25 minutes of focus, a 5-minute break, and a 15-minute long break after 4 sessions. You can change these lengths with the settings button on the Focus page.',
        ],
      },
      {
        heading: 'Start a session',
        body: [
          '1. Open Focus.',
          '2. Type what you’re working on, or tap one of today’s tasks to fill it in.',
          '3. Press Start. You can pause, finish early (saves the time you focused, at least one minute), or discard.',
          'The timer keeps running while you use other pages and shows in the top bar. When it ends you’ll hear a chime and the session is saved.',
        ],
      },
      {
        heading: 'Focus sounds (Pro)',
        body: [
          'Pro members can play background sounds such as rain or white noise while focusing, with a volume control.',
        ],
      },
    ],
  },
  {
    slug: 'account-and-security',
    title: 'Account, username and password recovery',
    description: 'Change your username, add a recovery email, change your password or delete your account.',
    keywords: ['username', 'change username', 'email', 'recovery email', 'password', 'forgot password', 'reset password', 'delete account', 'account', 'login'],
    route: '/settings',
    public: true,
    sections: [
      {
        heading: 'Change your username',
        body: [
          '1. Open Settings → Account.',
          '2. Choose “Change username”, enter the new name and your current password.',
          'It’s the same account: your trackers, history, friends and plan stay exactly as they are. Use the new username the next time you log in.',
        ],
      },
      {
        heading: 'Recovery email',
        body: [
          'An email address is optional. Without one, a forgotten password can’t be recovered. To add one, open Settings → Account → Recovery email and confirm the link we send you. If you change it, your old address stays active until the new one is confirmed.',
        ],
      },
      {
        heading: 'Forgot your password?',
        body: [
          'On the login page choose “Forgot password?” and enter your username or recovery email. If the account has a confirmed recovery email, we send a one-time link that expires after an hour.',
        ],
      },
      {
        heading: 'Delete your account',
        body: [
          'Settings → Data → Delete account. You’ll need your password. This permanently deletes your trackers, tasks, history, focus sessions and friends.',
        ],
      },
    ],
  },
  {
    slug: 'friends-and-leaderboards',
    title: 'Friends, comparisons and leaderboards',
    description: 'Add friends by username, compare totals and join an opt-in weekly leaderboard.',
    keywords: ['friend', 'friends', 'add friend', 'request', 'compare', 'leaderboard', 'privacy', 'share'],
    route: '/friends',
    public: true,
    sections: [
      {
        heading: 'Add a friend',
        body: [
          'Open Friends, enter their username and send a request. When they accept, you can compare progress. You can remove a friend at any time.',
        ],
      },
      {
        heading: 'What friends can see',
        body: [
          'Only daily totals: completion percentage, number of tasks completed, and focus minutes. Friends never see task names, descriptions, your timetable, your email or anything else. You can stop sharing totals in Settings → Privacy.',
        ],
      },
      {
        heading: 'Leaderboards (Pro)',
        body: [
          'The weekly leaderboard ranks you and friends who have also opted in. Participation is off by default — turn it on in Settings → Privacy.',
        ],
      },
    ],
  },
  {
    slug: 'timetable-assistant',
    title: 'Timetable assistant: AI, voice commands and rescheduling',
    description: 'Build a timetable with AI, check how balanced your week is, move activities around an event, and use typed or spoken commands.',
    keywords: ['ai', 'assistant', 'voice', 'speak', 'microphone', 'command', 'build', 'generate', 'reschedule', 'move', 'check', 'evaluate', 'balanced', 'history', 'undo'],
    route: '/dashboard',
    public: true,
    sections: [
      {
        body: [
          'The Timetable assistant is on the Dashboard, below your weekly timetable. It never changes anything on its own: it shows exactly what will change and waits for you to press Confirm, Move or Save.',
        ],
      },
      {
        heading: 'Commands (typed or spoken)',
        body: [
          'Type in the command box, or tap the microphone and speak. Examples:',
          '- “Add maths revision tomorrow 6 pm”',
          '- “Move today’s unfinished tasks to Saturday”',
          '- “Start a 25-minute focus session on chemistry”',
          '- “Mark reading done”',
          '- “What’s due this week?”',
          '- “Open my progress”',
          'Speech is turned into text by your browser or phone; HabbitFlow never receives audio. If the AI is unavailable or you’ve used your allowance, common commands still work.',
        ],
      },
      {
        heading: 'Build with AI (Plus and Pro)',
        body: [
          '1. Click “Build with AI”.',
          '2. Answer a few questions — your goals, subjects that need more time, fixed commitments, sleep times, when you focus best. Skip anything you like. If your school uses HabbitFlow, your class timetable, homework deadlines and exams are filled in automatically.',
          '3. Click “Build my timetable”. The AI explains what it included and why, and anything that didn’t fit.',
          '4. Click “Save as new timetable”. Your existing timetables aren’t changed. Your answers are saved for next time.',
        ],
      },
      {
        heading: 'Check my timetable',
        body: [
          'Shows hours per category and per day, and points out overloaded days, long stretches without breaks, late nights, clashes with school and exams with no revision planned. With AI available you also get personal advice.',
        ],
      },
      {
        heading: 'Reschedule for an event',
        body: [
          'Enter what’s happening (for example a football match), the day and time. The assistant lists the activities it displaces with before → after times. Untick any you want to leave, then click “Move”. Moves change your weekly timetable.',
        ],
      },
      {
        heading: 'History and undo',
        body: [
          '“History” lists every change made by the assistant. You can undo the most recent one, as long as you haven’t edited the timetable since. School timetables are never changed by the assistant.',
        ],
      },
      {
        heading: 'Limits',
        body: [
          'AI requests have a monthly or daily allowance depending on your plan (see Settings → AI usage). Requests that fail aren’t counted.',
        ],
      },
    ],
  },
  {
    slug: 'school-development-programmes',
    title: 'School: development score and programmes',
    description: 'What your development score means, how to improve it, and how school programmes and check-ins work.',
    keywords: ['development', 'score', 'report', 'programme', 'program', 'check in', 'school', 'weights', 'share habits'],
    route: '/school',
    public: true,
    sections: [
      {
        heading: 'Your development score',
        body: [
          'If your school uses HabbitFlow, your Overview shows “Your development”: a score from 1 to 10 for the last 90 days, built from academic results, homework, attendance, planning & habits and extracurricular activities. Open your report to see each part, why it is what it is, and suggestions.',
          'Parts without enough data are left out instead of counting as zero. Very long or late-night schedules are not rewarded.',
          'Planning & habits only counts if you tick “Share my habit consistency with my school”. Your teachers then see counts only, never your tasks or ticks.',
        ],
      },
      {
        heading: 'Programmes',
        body: [
          '1. Open School → Programmes.',
          '2. Choose Join on a programme that interests you.',
          '3. Press “Check in today” each time you do it. You can check in for today or the previous 6 days; each programme has a weekly target.',
          'Check-ins count towards the extracurricular part of your development score.',
        ],
      },
    ],
  },
  {
    slug: 'habbitflow-pro',
    title: 'Plans: Free, Plus and Pro',
    description: 'What each plan includes, how to upgrade and how to cancel.',
    keywords: ['pro', 'plus', 'upgrade', 'price', 'pricing', 'plan', 'plans', 'subscription', 'cancel', 'trial', 'export', 'csv', 'pdf', 'themes', 'ads'],
    route: '/pro',
    public: true,
    sections: [
      {
        heading: 'The three plans',
        body: [
          '- Free: 2 trackers, 30-day charts, the focus timer and up to 3 friends. Includes some ads.',
          '- Plus: no ads, unlimited trackers, full history and 90-day charts, colour themes, the AI timetable builder and up to 10 friends.',
          '- Pro: everything in Plus, plus PDF and CSV reports, focus sounds, weekly leaderboards and up to 50 friends. Pro has a free trial.',
          'Prices are shown on the pricing page and depend on your region.',
        ],
      },
      {
        heading: 'How to upgrade',
        body: [
          'Open the pricing page from the menu (“Upgrade”), choose monthly or yearly, and pick Plus or Pro. Payment is handled by our payment provider; your features switch on once the payment is confirmed. In the Android app, plans are bought through Google Play. You can switch from Plus to Pro at any time.',
        ],
      },
      {
        heading: 'If your plan ends',
        body: [
          'Nothing is deleted. You keep all trackers and history; the free limits simply apply to new items again.',
        ],
      },
    ],
  },
]

/** Short greeting for the assistant depending on the page. */
export function contextHint(path: string): string {
  if (path.startsWith('/dashboard')) return 'Need help with your timetable? I can show you how to add a time slot, a task, or another tracker.'
  if (path.startsWith('/progress')) return 'I can explain your completion graph, streaks and statistics.'
  if (path.startsWith('/focus')) return 'I can explain the Pomodoro timer, breaks and focus sounds.'
  if (path.startsWith('/friends')) return 'I can help you add friends, compare progress or understand what friends can see.'
  if (path.startsWith('/settings')) return 'I can help you change your username, recovery email, appearance or account settings.'
  if (path.startsWith('/pro')) return 'I can explain what Pro includes and how upgrading works.'
  return 'Ask me anything about using HabbitFlow.'
}

/** Plain-text version of all articles (for the AI system prompt). */
export function helpAsText(): string {
  return HELP_ARTICLES.map(
    (a) =>
      `# ${a.title}\n${a.description}\n` +
      a.sections.map((s) => `${s.heading ? `## ${s.heading}\n` : ''}${s.body.join('\n')}`).join('\n'),
  ).join('\n\n')
}

/** Keyword search used when the AI service is unavailable. */
export function searchHelp(query: string, path = ''): HelpArticle[] {
  const q = query.toLowerCase()
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  const scored = HELP_ARTICLES.map((a) => {
    let score = 0
    for (const k of a.keywords) if (q.includes(k)) score += k.includes(' ') ? 4 : 2
    const hay = `${a.title} ${a.description}`.toLowerCase()
    for (const w of words) if (hay.includes(w)) score += 1
    if (a.route && path.startsWith(a.route)) score += 0.5
    return { a, score }
  })
  return scored
    .filter((x) => x.score >= 2)
    .sort((x, y) => y.score - x.score)
    .slice(0, 2)
    .map((x) => x.a)
}
