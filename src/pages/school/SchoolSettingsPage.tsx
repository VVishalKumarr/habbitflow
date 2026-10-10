import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useStructure } from '../../components/school/data'
import { AiPanel } from '../../components/school/AiPanel'
import { LicencePanel } from '../../components/school/LicencePanel'
import { ErrorNote, List, Loading, PageHeader, Panel, Pill, Row } from '../../components/school/ui'
import { Field } from '../../components/ui/Field'
import { Spinner } from '../../components/ui/Spinner'
import { friendlyError } from '../../lib/errors'
import {
  CONFIGURABLE_ROLES,
  DEFAULT_PERMISSIONS,
  isHead,
  LOCKED_PERMISSIONS,
  PERMISSION_LABEL,
  ROLE_LABEL,
  type ConfigurableRole,
  type InstitutionSettings,
  type MyInstitution,
  type Permission,
} from '../../lib/institution'
import { supabase } from '../../lib/supabase'
import { unwrap, useLoad } from '../../lib/useLoad'
import { useCurrentInstitution, useInstitutionStore } from '../../store/institution'
import { toast } from '../../store/ui'

interface InstitutionRow {
  id: string
  name: string
  short_name: string | null
  timezone: string
  logo_url: string | null
  brand_color: string | null
  settings: Partial<InstitutionSettings>
}

export default function SchoolSettingsPage() {
  const { current, can } = useCurrentInstitution()
  const inst = current!
  const head = isHead(inst.role)
  const { data, error, loading, reload } = useLoad(async () => {
    const [row, settings] = await Promise.all([
      supabase.from('institutions').select('id, name, short_name, timezone, logo_url, brand_color, settings').eq('id', inst.institution_id).single(),
      supabase.rpc('institution_settings', { p_inst: inst.institution_id }),
    ])
    return { row: unwrap(row) as InstitutionRow, settings: unwrap(settings) as InstitutionSettings }
  }, [inst.institution_id])

  if (loading && !data) return <Loading />
  if (error || !data) return <ErrorNote>{error}</ErrorNote>

  return (
    <div className="space-y-5">
      <PageHeader title="Institution settings" description="Settings apply only to this institution. The app layout and security rules can’t be changed here." />
      {head && <BrandingPanel row={data.row} onSaved={reload} />}
      {head && <YearsPanel inst={inst} />}
      {can('set_homework_retention') && <RetentionPanel inst={inst} days={data.settings.homework_retention_days} onSaved={reload} />}
      {head && <AcademicRulesPanel row={data.row} settings={data.settings} onSaved={reload} />}
      {head && <PermissionsPanel inst={inst} />}
      {can('manage_license') && <LicencePanel institutionId={inst.institution_id} />}
      {can('manage_institution_settings') && <AiPanel institutionId={inst.institution_id} />}
    </div>
  )
}

function BrandingPanel({ row, onSaved }: { row: InstitutionRow; onSaved: () => void }) {
  const [name, setName] = useState(row.name)
  const [shortName, setShortName] = useState(row.short_name ?? '')
  const [logo, setLogo] = useState(row.logo_url ?? '')
  const [color, setColor] = useState(row.brand_color ?? '#5750e0')
  const [useColor, setUseColor] = useState(!!row.brand_color)
  const [timezone, setTimezone] = useState(row.timezone)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [row.timezone]

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (logo && !/^https:\/\/\S+$/.test(logo)) return setError('The logo must be an https:// link to an image.')
    setBusy(true)
    const { error: err } = await supabase
      .from('institutions')
      .update({ name: name.trim(), short_name: shortName.trim() || null, logo_url: logo.trim() || null, brand_color: useColor ? color : null, timezone })
      .eq('id', row.id)
    setBusy(false)
    if (err) return setError(friendlyError(err))
    setError(null)
    toast.success('Branding saved.')
    onSaved()
    useInstitutionStore.getState().load()
  }

  return (
    <Panel title="Name and branding">
      <form onSubmit={save} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Institution name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Field label="Short name" value={shortName} onChange={(e) => setShortName(e.target.value)} maxLength={30} />
          <Field label="Logo URL (https)" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…/logo.png" hint="A square PNG or SVG works best." />
          <div>
            <label className="field-label" htmlFor="tz">
              Time zone
            </label>
            <select id="tz" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={useColor} onChange={(e) => setUseColor(e.target.checked)} />
            Brand colour for the institution badge
          </label>
          {useColor && <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 cursor-pointer rounded-lg border border-line bg-surface" aria-label="Brand colour" />}
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          Save
        </button>
      </form>
    </Panel>
  )
}

function YearsPanel({ inst }: { inst: MyInstitution }) {
  const { data: s, reload } = useStructure(inst.institution_id)
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [termFor, setTermFor] = useState<string | null>(null)
  const [term, setTerm] = useState({ name: '', start: '', end: '' })

  const run = async (p: PromiseLike<{ error: unknown }>, ok: string) => {
    const { error } = await p
    if (error) toast.error(friendlyError(error))
    else {
      toast.success(ok)
      reload()
    }
  }
  const addYear = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !start || !end) return toast.error('Enter a name, start and end date.')
    run(supabase.from('academic_years').insert({ institution_id: inst.institution_id, name: name.trim(), starts_on: start, ends_on: end, is_current: !s?.years.length }), 'Academic year added.')
    setName('')
  }
  const makeCurrent = async (id: string) => {
    const prev = s?.years.find((y) => y.is_current)
    if (prev) await supabase.from('academic_years').update({ is_current: false }).eq('id', prev.id)
    run(supabase.from('academic_years').update({ is_current: true }).eq('id', id), 'Current year changed.')
  }
  const addTerm = (e: FormEvent) => {
    e.preventDefault()
    if (!termFor || !term.name.trim() || !term.start || !term.end) return
    run(supabase.from('terms').insert({ institution_id: inst.institution_id, academic_year_id: termFor, name: term.name.trim(), starts_on: term.start, ends_on: term.end }), 'Term added.')
    setTerm({ name: '', start: '', end: '' })
  }

  return (
    <Panel title="Academic years and terms" description="The year-end transfer of classes and records arrives with reports (Phase 6); past years stay readable.">
      <List empty="No academic years yet.">
        {(s?.years ?? []).map((y) => (
          <Row key={y.id} className="items-start sm:items-start">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {y.name} {y.is_current && <Pill tone="brand">Current</Pill>}
              </p>
              <p className="text-sm text-muted">
                {y.starts_on} → {y.ends_on}
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {(s?.terms ?? [])
                  .filter((t) => t.academic_year_id === y.id)
                  .map((t) => (
                    <li key={t.id} className="inline-flex items-center gap-1 rounded-full border border-line py-0.5 pr-1 pl-2.5 text-xs">
                      {t.name}: {t.starts_on} → {t.ends_on}
                      <button type="button" className="rounded-full p-0.5 text-muted hover:text-danger" onClick={() => run(supabase.from('terms').delete().eq('id', t.id), 'Term removed.')} aria-label={`Remove ${t.name}`}>
                        <Trash2 className="size-3" />
                      </button>
                    </li>
                  ))}
              </ul>
              {termFor === y.id && (
                <form onSubmit={addTerm} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
                  <Field label="Term name" value={term.name} onChange={(e) => setTerm({ ...term, name: e.target.value })} maxLength={40} placeholder="Term 1" />
                  <Field label="Starts" type="date" value={term.start} min={y.starts_on} max={y.ends_on} onChange={(e) => setTerm({ ...term, start: e.target.value })} />
                  <Field label="Ends" type="date" value={term.end} min={term.start || y.starts_on} max={y.ends_on} onChange={(e) => setTerm({ ...term, end: e.target.value })} />
                  <button type="submit" className="btn-secondary h-11">
                    Add
                  </button>
                </form>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {!y.is_current && (
                <button type="button" className="btn-ghost h-9 px-3" onClick={() => makeCurrent(y.id)}>
                  Make current
                </button>
              )}
              <button type="button" className="btn-ghost h-9 px-3" onClick={() => setTermFor(termFor === y.id ? null : y.id)}>
                <Plus className="size-4" aria-hidden="true" />
                Term
              </button>
            </div>
          </Row>
        ))}
      </List>
      <form onSubmit={addYear} className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <Field label="New academic year" value={name} onChange={(e) => setName(e.target.value)} placeholder="2026–27" maxLength={40} />
        <Field label="Starts" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <Field label="Ends" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        <button type="submit" className="btn-secondary h-11">
          Add year
        </button>
      </form>
    </Panel>
  )
}

function RetentionPanel({ inst, days, onSaved }: { inst: MyInstitution; days: number; onSaved: () => void }) {
  const [value, setValue] = useState(String(days))
  const [busy, setBusy] = useState(false)
  useEffect(() => setValue(String(days)), [days])
  const n = Number(value)
  const valid = Number.isInteger(n) && n >= 0 && n <= 14

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    const { error } = await supabase.rpc('set_homework_retention', { p_inst: inst.institution_id, p_days: n })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Retention interval saved. It applies to new assignments.')
    onSaved()
  }

  return (
    <Panel title="Homework review and retention" description="How long uploaded homework files are kept after the deadline for review (0–14 days). After this an hourly job deletes the files automatically; submission, review and marks records stay. Coordinators can place a hold on an assignment when policy requires keeping files longer.">
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-48">
          <Field label="Days after the deadline" type="number" min={0} max={14} value={value} onChange={(e) => setValue(e.target.value)} error={valid ? null : 'Choose 0 to 14 days.'} />
        </div>
        <button type="submit" className="btn-primary h-11" disabled={busy || !valid}>
          Save
        </button>
      </form>
    </Panel>
  )
}

function AcademicRulesPanel({ row, settings, onSaved }: { row: InstitutionRow; settings: InstitutionSettings; onSaved: () => void }) {
  const [perDay, setPerDay] = useState(String(settings.max_deadlines_per_day))
  const [perWeek, setPerWeek] = useState(String(settings.max_deadlines_per_week))
  const [scale, setScale] = useState(settings.grading_scale.map((g) => ({ label: g.label, min: String(g.min) })))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const grading = scale.map((g) => ({ label: g.label.trim(), min: Number(g.min) }))
    if (grading.some((g) => !g.label || !Number.isFinite(g.min) || g.min < 0 || g.min > 100)) return setError('Each grade needs a label and a minimum percentage from 0 to 100.')
    if (!grading.some((g) => g.min === 0)) return setError('Include a grade with minimum 0 so every mark gets a grade.')
    grading.sort((a, b) => b.min - a.min)
    setBusy(true)
    const { error: err } = await supabase
      .from('institutions')
      .update({ settings: { ...row.settings, max_deadlines_per_day: Number(perDay), max_deadlines_per_week: Number(perWeek), grading_scale: grading } })
      .eq('id', row.id)
    setBusy(false)
    if (err) return setError(friendlyError(err))
    setError(null)
    toast.success('Saved.')
    onSaved()
  }

  return (
    <Panel title="Workload limits and grading scale">
      <form onSubmit={save} className="space-y-5">
        <ErrorNote>{error}</ErrorNote>
        <div>
          <p className="text-sm text-muted">The deadline calendar flags a class when it has more deadlines than this.</p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:w-96">
            <Field label="Per day" type="number" min={1} max={10} value={perDay} onChange={(e) => setPerDay(e.target.value)} />
            <Field label="Per week" type="number" min={1} max={40} value={perWeek} onChange={(e) => setPerWeek(e.target.value)} />
          </div>
        </div>
        <fieldset>
          <legend className="field-label">Grading scale (minimum % for each grade)</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {scale.map((g, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-xl border border-line p-1.5">
                <input className="input h-9 w-16 px-2 text-sm" value={g.label} maxLength={10} onChange={(e) => setScale(scale.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`Grade ${i + 1} label`} />
                <input className="input h-9 w-16 px-2 text-sm" type="number" min={0} max={100} value={g.min} onChange={(e) => setScale(scale.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} aria-label={`Grade ${i + 1} minimum percent`} />
                <button type="button" className="icon-btn size-8" onClick={() => setScale(scale.filter((_, j) => j !== i))} aria-label={`Remove grade ${g.label}`} disabled={scale.length <= 1}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            {scale.length < 20 && (
              <button type="button" className="btn-ghost h-[50px] border border-dashed border-line" onClick={() => setScale([...scale, { label: '', min: '0' }])}>
                <Plus className="size-4" aria-hidden="true" />
                Grade
              </button>
            )}
          </div>
        </fieldset>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy && <Spinner className="size-4" />}
          Save
        </button>
      </form>
    </Panel>
  )
}

function PermissionsPanel({ inst }: { inst: MyInstitution }) {
  const { data, reload } = useLoad(
    async () =>
      unwrap(await supabase.from('institution_role_permissions').select('role, permission, allowed').eq('institution_id', inst.institution_id)) as {
        role: ConfigurableRole
        permission: Permission
        allowed: boolean
      }[],
    [inst.institution_id],
  )
  const configurable = (Object.keys(PERMISSION_LABEL) as Permission[]).filter((p) => !LOCKED_PERMISSIONS.includes(p))
  const effective = (role: ConfigurableRole, p: Permission) => data?.find((x) => x.role === role && x.permission === p)?.allowed ?? DEFAULT_PERMISSIONS[role].includes(p)

  const toggle = async (role: ConfigurableRole, p: Permission, allowed: boolean) => {
    const isDefault = DEFAULT_PERMISSIONS[role].includes(p) === allowed
    const { error } = isDefault
      ? await supabase.from('institution_role_permissions').delete().match({ institution_id: inst.institution_id, role, permission: p })
      : await supabase.from('institution_role_permissions').upsert({ institution_id: inst.institution_id, role, permission: p, allowed })
    if (error) toast.error(friendlyError(error))
    reload()
  }

  return (
    <Panel
      title="Role permissions"
      description="Coordinators and class teachers share a tier but have separate permissions. Staff management, licensing and institution settings always stay with the principal and director."
    >
      {/* Phones: one card per permission; wider screens: a grid. */}
      <div className="hidden grid-cols-[minmax(0,1fr)_repeat(3,110px)] gap-y-1 text-sm md:grid">
        <span />
        {CONFIGURABLE_ROLES.map((r) => (
          <span key={r} className="text-center text-xs font-semibold text-muted">
            {ROLE_LABEL[r]}
          </span>
        ))}
        {configurable.map((p) => (
          <PermissionLine key={p} p={p} effective={effective} toggle={toggle} />
        ))}
      </div>
      <ul className="divide-y divide-line md:hidden">
        {configurable.map((p) => (
          <li key={p} className="py-3">
            <p className="text-sm font-medium">{PERMISSION_LABEL[p]}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {CONFIGURABLE_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={effective(r, p)} onChange={(e) => toggle(r, p, e.target.checked)} />
                  {ROLE_LABEL[r]}
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function PermissionLine({ p, effective, toggle }: { p: Permission; effective: (r: ConfigurableRole, p: Permission) => boolean; toggle: (r: ConfigurableRole, p: Permission, v: boolean) => void }) {
  return (
    <>
      <span className="border-t border-line py-2">{PERMISSION_LABEL[p]}</span>
      {CONFIGURABLE_ROLES.map((r) => (
        <span key={r} className="flex justify-center border-t border-line py-2">
          <input
            type="checkbox"
            className="size-4 accent-[var(--brand)]"
            checked={effective(r, p)}
            onChange={(e) => toggle(r, p, e.target.checked)}
            aria-label={`${PERMISSION_LABEL[p]} for ${ROLE_LABEL[r]}`}
          />
        </span>
      ))}
    </>
  )
}
