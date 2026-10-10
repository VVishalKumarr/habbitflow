import { GuardianRequests } from '../../components/school/Guardians'
import { useStructure } from '../../components/school/data'
import { Loading, PageHeader } from '../../components/school/ui'
import { useCurrentInstitution } from '../../store/institution'

/** Staff page for parent/guardian link requests (class teachers and student managers). */
export default function GuardiansPage() {
  const { current } = useCurrentInstitution()
  const { data: s, loading } = useStructure(current!.institution_id)
  if (loading && !s) return <Loading />
  const name = (id: string) => s?.members.find((m) => m.id === id)?.display_name ?? 'a student'
  return (
    <div className="space-y-5">
      <PageHeader title="Parents & guardians" description="Students ask to link a parent; you confirm it. Parents only ever see their own linked children." />
      <GuardianRequests institutionId={current!.institution_id} studentName={name} />
    </div>
  )
}
