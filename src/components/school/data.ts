import type {
  AcademicYear,
  CoordinatorScope,
  Enrollment,
  Membership,
  SchoolClass,
  Subject,
  TeachingAssignment,
  Term,
} from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'

export interface SchoolStructure {
  members: Membership[]
  classes: SchoolClass[]
  subjects: Subject[]
  years: AcademicYear[]
  terms: Term[]
  enrollments: Enrollment[]
  teaching: TeachingAssignment[]
  scopes: CoordinatorScope[]
}

/**
 * Everything about the institution's structure that the signed-in user is
 * allowed to see. Row Level Security does the filtering: a teacher gets only
 * their classes and students, a student only their own class.
 */
export async function loadStructure(inst: string): Promise<SchoolStructure> {
  const [members, classes, subjects, years, terms, enrollments, teaching, scopes] = await Promise.all([
    supabase.from('institution_memberships').select('*').eq('institution_id', inst).order('display_name'),
    supabase.from('classes').select('*').eq('institution_id', inst).order('grade').order('name'),
    supabase.from('subjects').select('*').eq('institution_id', inst).order('name'),
    supabase.from('academic_years').select('*').eq('institution_id', inst).order('starts_on', { ascending: false }),
    supabase.from('terms').select('*').eq('institution_id', inst).order('starts_on'),
    supabase.from('class_enrollments').select('id, class_id, student_id, roll_no').eq('institution_id', inst),
    supabase.from('teaching_assignments').select('id, class_id, subject_id, teacher_id').eq('institution_id', inst),
    supabase.from('coordinator_scopes').select('id, coordinator_id, grade').eq('institution_id', inst),
  ])
  return {
    members: unwrap(members) as Membership[],
    classes: unwrap(classes) as SchoolClass[],
    subjects: unwrap(subjects) as Subject[],
    years: unwrap(years) as AcademicYear[],
    terms: unwrap(terms) as Term[],
    enrollments: unwrap(enrollments) as Enrollment[],
    teaching: unwrap(teaching) as TeachingAssignment[],
    scopes: unwrap(scopes) as CoordinatorScope[],
  }
}

export function useStructure(inst: string | undefined) {
  return useLoad(() => (inst ? loadStructure(inst) : Promise.resolve(null)), [inst])
}

/** Natural sort for grades like "2", "10", "FY BSc". */
export const gradeSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

export const uniqueGrades = (classes: SchoolClass[]) => [...new Set(classes.filter((c) => !c.archived).map((c) => c.grade))].sort(gradeSort)
