import { Award, CheckCircle2, Plus, Target, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row, SelectField } from '../components/school/ui'
import { Field } from '../components/ui/Field'
import { Modal } from '../components/ui/Modal'
import { friendlyError } from '../lib/errors'
import { supabase } from '../lib/supabase'
import { unwrap, useLoad } from '../lib/useLoad'
import { toast } from '../store/ui'

type Category = 'academic' | 'skill' | 'health' | 'extracurricular' | 'personal'
const CATEGORY_LABEL: Record<Category, string> = { academic: 'Academic', skill: 'Skill', health: 'Health', extracurricular: 'Extracurricular', personal: 'Personal' }

interface Goal {
  id: string
  title: string
  description: string | null
  category: Category
  target_date: string | null
  progress: number
  status: 'active' | 'completed' | 'archived'
  completed_at: string | null
}

interface Achievement {
  id: string
  title: string
  description: string
  earned: boolean
  progress: number
  target: number
}

/** Personal goals (private to you) and achievements earned from real records. */
export default function GoalsPage() {
  const goals = useLoad(async () => unwrap(await supabase.from('student_goals').select('*').neq('status', 'archived').order('status').order('created_at', { ascending: false })) as Goal[], [])
  const ach = useLoad(async () => unwrap(await supabase.rpc('my_achievements')) as Achievement[], [])
  const [adding, setAdding] = useState(false)

  const update = async (g: Goal, patch: Partial<Goal>) => {
    goals.setData((goals.data ?? []).map((x) => (x.id === g.id ? { ...x, ...patch } : x)))
    const { error } = await supabase.from('student_goals').update(patch).eq('id', g.id)
    if (error) toast.error(friendlyError(error))
    goals.reload()
    ach.reload()
  }
  const remove = async (g: Goal) => {
    const { error } = await supabase.from('student_goals').update({ status: 'archived' }).eq('id', g.id)
    if (error) toast.error(friendlyError(error))
    goals.reload()
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Goals & achievements"
        description="Your goals are private to you. Achievements are awarded from your actual work, focus time and habits."
        actions={
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            New goal
          </button>
        }
      />
      <Panel title="Goals">
        <ErrorNote>{goals.error}</ErrorNote>
        {goals.loading && !goals.data ? (
          <Loading />
        ) : (
          <List empty="No goals yet. Set one you can make progress on this month.">
            {(goals.data ?? []).map((g) => (
              <Row key={g.id}>
                <div className="min-w-0 flex-1">
                  <p className={`font-medium ${g.status === 'completed' ? 'text-muted line-through' : ''}`}>{g.title}</p>
                  <p className="text-sm text-muted">
                    {CATEGORY_LABEL[g.category]}
                    {g.target_date && ` · by ${new Date(`${g.target_date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                  </p>
                  {g.status === 'active' && (
                    <label className="mt-2 flex items-center gap-3 text-sm">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={10}
                        value={g.progress}
                        onChange={(e) => goals.setData((goals.data ?? []).map((x) => (x.id === g.id ? { ...x, progress: Number(e.target.value) } : x)))}
                        onPointerUp={(e) => update(g, { progress: Number((e.target as HTMLInputElement).value) })}
                        onKeyUp={(e) => update(g, { progress: Number((e.target as HTMLInputElement).value) })}
                        className="w-40 accent-[var(--brand)]"
                        aria-label={`Progress on ${g.title}`}
                      />
                      <span className="tabular-nums text-muted">{g.progress}%</span>
                    </label>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {g.status === 'active' ? (
                    <button type="button" className="btn-secondary h-9 px-3" onClick={() => update(g, { status: 'completed' })}>
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                      Done
                    </button>
                  ) : (
                    <Pill tone="success">Completed</Pill>
                  )}
                  <button type="button" className="icon-btn" onClick={() => remove(g)} aria-label={`Remove ${g.title}`}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </Row>
            ))}
          </List>
        )}
      </Panel>
      <Panel title="Achievements">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(ach.data ?? []).map((a) => (
            <div key={a.id} className={`flex gap-3 rounded-xl border p-3 ${a.earned ? 'border-brand/40 bg-brand-soft/50' : 'border-line'}`}>
              <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${a.earned ? 'bg-brand text-white' : 'bg-subtle text-muted'}`}>
                {a.earned ? <Award className="size-5" aria-hidden="true" /> : <Target className="size-5" aria-hidden="true" />}
              </span>
              <div className="min-w-0">
                <p className="font-medium">{a.title}</p>
                <p className="text-sm text-muted">{a.description}</p>
                {!a.earned && (
                  <p className="mt-1 text-xs text-muted tabular-nums">
                    {a.progress} / {a.target}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </Panel>
      {adding && <NewGoal onClose={() => (setAdding(false), goals.reload())} />}
    </div>
  )
}

function NewGoal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<Category>('academic')
  const [date, setDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError('Describe your goal.')
    const { error: err } = await supabase.from('student_goals').insert({ title: title.trim(), category, target_date: date || null })
    if (err) return setError(friendlyError(err))
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="New goal"
      subtitle="Make it specific: “Finish maths revision chapters 1–4” beats “Study more”."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-goal" className="btn-primary">
            Add goal
          </button>
        </>
      }
    >
      <form id="new-goal" onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Goal" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Type" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </SelectField>
          <Field label="Target date (optional)" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </form>
    </Modal>
  )
}
