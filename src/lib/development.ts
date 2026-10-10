// Wording for development reports: what each component means, why a score
// is what it is, and what would improve it. Numbers come from the database
// (compute_development); this only explains them.

export type ComponentKey = 'academic' | 'homework' | 'attendance' | 'planning' | 'extracurricular'
export const COMPONENTS: ComponentKey[] = ['academic', 'homework', 'attendance', 'planning', 'extracurricular']

export interface Component {
  has_data: boolean
  score: number | null
  weight: number
  detail: Record<string, unknown>
}
export interface DevelopmentScore {
  id: string
  student_id: string
  student?: string
  period_from: string
  period_to: string
  score: number | null
  insufficient: boolean
  components: Record<ComponentKey, Component>
  weights: Record<ComponentKey, number>
  created_at: string
  calculated_by: string | null
}

export const COMPONENT_LABEL: Record<ComponentKey, string> = {
  academic: 'Academic results',
  homework: 'Homework',
  attendance: 'Attendance',
  planning: 'Planning & habits',
  extracurricular: 'Extracurricular & skills',
}

const pct = (v: unknown) => `${Math.round(Number(v) * 100)}%`

/** One line: what the component is based on. */
export function explain(key: ComponentKey, c: Component): string {
  const d = c.detail ?? {}
  switch (key) {
    case 'academic':
      return c.has_data
        ? `Average ${d.average_pct}%${d.grade ? ` (grade ${d.grade})` : ''} across ${d.marks} published marks.`
        : 'Needs at least 2 published marks.'
    case 'homework':
      return c.has_data
        ? `${d.expected} pieces of work due: ${d.missing} missing, ${d.late} late. On time counts fully, late counts 60%.`
        : 'Needs at least 3 pieces of homework that were due.'
    case 'attendance':
      return c.has_data ? `${d.records} sessions: ${d.absent} absent, ${d.late} late (late counts 75%).` : 'Needs at least 10 attendance records.'
    case 'planning':
      if (!d.shared) return 'Not shared — the student hasn’t chosen to share habit consistency with the school.'
      if (!c.has_data) return 'Needs a personal timetable with at least 2 weeks of activities.'
      return `${d.completed} of ${d.scheduled} planned activities ticked in the last 4 weeks.${d.healthy === false ? ' Capped at 60% because the timetable has very long days or late nights.' : ''}`
    case 'extracurricular':
      return c.has_data
        ? `${d.programmes} programme${d.programmes === 1 ? '' : 's'} joined${Number(d.goals_completed) ? `, ${d.goals_completed} skill or activity goals completed` : ''}; check-ins compared with each programme’s weekly target.`
        : 'Join a school programme to count here.'
  }
}

/** Improvement suggestions, most useful first (weak or missing components). */
export function suggestions(s: Pick<DevelopmentScore, 'components'>): string[] {
  const out: { w: number; text: string }[] = []
  for (const key of COMPONENTS) {
    const c = s.components[key]
    if (!c || c.weight === 0) continue
    const d = c.detail ?? {}
    const weak = c.has_data && Number(c.score) < 0.7
    if (key === 'academic' && weak) {
      const subjects = (d.subjects as { subject: string; pct: number }[] | undefined) ?? []
      const low = subjects.filter((x) => x.pct < 60).map((x) => x.subject)
      out.push({ w: c.weight, text: low.length ? `Plan regular revision for ${low.join(', ')}.` : 'Review mistakes from recent tests and plan short, regular revision.' })
    }
    if (key === 'homework' && weak) out.push({ w: c.weight, text: Number(d.missing) ? 'Hand in every piece of homework — missing work costs the most.' : 'Start homework earlier so it’s in on time.' })
    if (key === 'attendance' && weak) out.push({ w: c.weight, text: 'Attend every session you can; talk to your class teacher about anything that makes that hard.' })
    if (key === 'planning') {
      if (!d.shared) out.push({ w: 1, text: 'Optional: share your habit consistency with your school (Development card) so planning counts.' })
      else if (d.healthy === false) out.push({ w: c.weight, text: 'Make your timetable healthier: shorter days and nothing late at night.' })
      else if (weak) out.push({ w: c.weight, text: 'Tick off planned activities, or plan fewer so the plan is realistic.' })
    }
    if (key === 'extracurricular') {
      if (!c.has_data) out.push({ w: 2, text: 'Join a school programme (Programmes) and check in each week.' })
      else if (weak) out.push({ w: c.weight, text: 'Check in to your programmes as often as their weekly target.' })
    }
  }
  return out.sort((a, b) => b.w - a.w).map((x) => x.text).slice(0, 4)
}

export const scoreTone = (score: number | null) => (score === null ? 'muted' : score >= 7.5 ? 'success' : score >= 5 ? 'brand' : 'danger')

export const componentPct = (c: Component | undefined) => (c?.has_data && c.score !== null ? pct(c.score) : '—')
