import type { DayStat, TrackerStats } from './stats'
import type { ISODate } from './dates'

/**
 * Game-style 0–100 scores derived from a tracker's statistics, plus a
 * "potential": the level the student has already shown they can reach (their
 * best 7-day run), nudged a little higher so there is always something to aim for.
 */
export interface Scores {
  overall: number
  potential: number
  consistency: number
  week: number
  today: number
  streak: number
  topHabit: number
  topHabitTitle: string | null
  /** Best 7-day completion rate (0–100), the basis of the potential. */
  bestRun: number
}

const WINDOW = 30
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const ratio = (done: number, of: number) => (of ? (done / of) * 100 : 0)

/** Best completion rate over any 7 consecutive days. */
export function bestRunRate(daily: DayStat[]): number {
  let best = 0
  for (let i = 0; i + 7 <= daily.length; i++) {
    let s = 0
    let c = 0
    for (let j = i; j < i + 7; j++) {
      s += daily[j].scheduled
      c += daily[j].completed
    }
    if (s >= 3) best = Math.max(best, ratio(c, s))
  }
  return best
}

/** Potential for a current score: best proven run, or a third of the remaining gap, whichever is higher. */
export function potentialFor(current: number, bestRun = 0): number {
  return clamp(Math.max(bestRun, current + (100 - current) / 3, current))
}

export function computeScores(stats: TrackerStats, today: ISODate): Scores {
  const recent = stats.daily.slice(-WINDOW).filter((d) => d.scheduled > 0)
  const scheduled = recent.reduce((a, d) => a + d.scheduled, 0)
  const completed = recent.reduce((a, d) => a + d.completed, 0)
  const overall = clamp(ratio(completed, scheduled))
  const consistency = clamp(ratio(recent.filter((d) => d.completed / d.scheduled >= 0.8).length, recent.length))
  const weekSoFar = stats.week.filter((d) => d.date <= today)
  const week = clamp(
    ratio(
      weekSoFar.reduce((a, d) => a + d.completed, 0),
      weekSoFar.reduce((a, d) => a + d.scheduled, 0),
    ),
  )
  const streak = clamp(ratio(stats.streak.current, Math.max(7, stats.streak.longest)))
  const top = stats.habits[0]
  const bestRun = clamp(bestRunRate(stats.daily))
  return {
    overall,
    potential: potentialFor(overall, bestRun),
    consistency,
    week,
    today: clamp(ratio(stats.today.completed, stats.today.scheduled)),
    streak,
    topHabit: clamp((top?.rate ?? 0) * 100),
    topHabitTitle: top?.title ?? null,
    bestRun,
  }
}

export type Tier = 'Elite' | 'High' | 'Good' | 'Rising'

export function tierOf(score: number): Tier {
  if (score >= 90) return 'Elite'
  if (score >= 75) return 'High'
  if (score >= 50) return 'Good'
  return 'Rising'
}

/** Red → orange → yellow → lime → green, like a game rating. */
export function scoreColor(score: number): string {
  return `hsl(${Math.round(Math.max(0, Math.min(100, score)) * 1.25)} 80% 50%)`
}
