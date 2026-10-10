// Printable PDF reports (generated in the browser / app; nothing is uploaded).
import { COMPONENT_LABEL, COMPONENTS, explain, suggestions, type DevelopmentScore } from './development'
import { saveFile } from './native'

type Doc = InstanceType<(typeof import('jspdf'))['jsPDF']>

const BRAND: [number, number, number] = [79, 70, 229]
const MUTED: [number, number, number] = [110, 110, 125]
const fmtDate = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

async function newDoc() {
  const { jsPDF } = await import('jspdf')
  return new jsPDF({ unit: 'pt', format: 'a4' })
}

function header(doc: Doc, title: string, sub: string[]) {
  doc.setFillColor(...BRAND)
  doc.rect(0, 0, 595, 6, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(20, 20, 30)
  doc.text(title, 40, 50)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...MUTED)
  sub.forEach((s, i) => doc.text(s, 40, 68 + i * 14))
  return 68 + sub.length * 14 + 10
}

function footer(doc: Doc) {
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(`HabitFlow · generated ${new Date().toLocaleString()} · page ${i} of ${pages}`, 40, 820)
  }
}

function wrap(doc: Doc, text: string, x: number, y: number, width: number, lineH = 13): number {
  const lines = doc.splitTextToSize(text, width) as string[]
  doc.text(lines, x, y)
  return y + lines.length * lineH
}

function ensure(doc: Doc, y: number, need: number): number {
  if (y + need > 790) {
    doc.addPage()
    return 50
  }
  return y
}

/** One student's development report. */
export async function studentReportPdf(s: DevelopmentScore, opts: { institution: string; student: string; className?: string | null }) {
  const doc = await newDoc()
  let y = header(doc, 'Development report', [
    `${opts.student}${opts.className ? ` · ${opts.className}` : ''} · ${opts.institution}`,
    `Period ${fmtDate(s.period_from)} – ${fmtDate(s.period_to)} · calculated ${fmtDate(s.created_at)}`,
  ])
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(32)
  doc.setTextColor(...BRAND)
  doc.text(s.score === null ? '—' : String(Number(s.score).toFixed(1)), 40, y + 30)
  doc.setFontSize(11)
  doc.setTextColor(20, 20, 30)
  doc.text(s.score === null ? 'Insufficient data for an overall score' : 'out of 10', 110, y + 28)
  y += 60

  for (const key of COMPONENTS) {
    const c = s.components[key]
    if (!c) continue
    y = ensure(doc, y, 60)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(20, 20, 30)
    doc.text(`${COMPONENT_LABEL[key]}  (weight ${c.weight}%)`, 40, y)
    doc.setFont('helvetica', 'normal')
    doc.text(c.has_data && c.score !== null ? `${Math.round(Number(c.score) * 100)}%` : 'no data', 555, y, { align: 'right' })
    y += 8
    doc.setFillColor(235, 235, 242)
    doc.rect(40, y, 515, 6, 'F')
    if (c.has_data && c.score !== null) {
      doc.setFillColor(...BRAND)
      doc.rect(40, y, 515 * Math.min(1, Number(c.score)), 6, 'F')
    }
    y += 20
    doc.setFontSize(9.5)
    doc.setTextColor(...MUTED)
    y = wrap(doc, explain(key, c), 40, y, 515) + 10
  }

  const tips = suggestions(s)
  if (tips.length) {
    y = ensure(doc, y, 40 + tips.length * 26)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(20, 20, 30)
    doc.text('Suggestions', 40, y + 6)
    y += 24
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    for (const t of tips) y = wrap(doc, `•  ${t}`, 40, y, 515) + 4
  }
  y = ensure(doc, y, 60)
  doc.setFontSize(8.5)
  doc.setTextColor(...MUTED)
  wrap(doc, 'The score (1–10) combines the parts that have enough data, using the weights shown. Parts without enough data are left out rather than counted as zero. Very long or late-night personal schedules are not rewarded.', 40, y + 14, 515, 11)
  footer(doc)
  await saveFile(`development-${opts.student.replace(/[^\w-]+/g, '_')}-${s.period_to}.pdf`, doc.output('blob'))
}

export interface ClassReport {
  class: string
  grade: string
  since: string
  teacher: string | null
  students: {
    student_id: string
    name: string
    external_id: string | null
    roll_no: string | null
    latest: { score: number | null; insufficient: boolean; components: DevelopmentScore['components']; created_at: string } | null
    attendance_rate: number | null
    homework_rate: number | null
    marks_pct: number | null
  }[]
}

const p = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(Number(v) * 100)}%`)

/** A class overview: one row per student. */
export async function classReportPdf(r: ClassReport, institution: string) {
  const doc = await newDoc()
  let y = header(doc, `Class report: ${r.class}`, [
    `${institution}${r.teacher ? ` · class teacher ${r.teacher}` : ''}`,
    `Attendance, homework and marks since ${fmtDate(r.since)} · latest development score per student`,
  ])
  const cols = [
    { h: 'Student', x: 40 },
    { h: 'Score', x: 250 },
    { h: 'Attendance', x: 300 },
    { h: 'Homework', x: 370 },
    { h: 'Marks', x: 440 },
    { h: 'Calculated', x: 490 },
  ]
  const head = () => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    cols.forEach((c) => doc.text(c.h, c.x, y))
    y += 6
    doc.setDrawColor(220, 220, 230)
    doc.line(40, y, 555, y)
    y += 14
  }
  head()
  doc.setFont('helvetica', 'normal')
  for (const s of r.students) {
    if (y > 790) {
      doc.addPage()
      y = 50
      head()
      doc.setFont('helvetica', 'normal')
    }
    doc.setFontSize(9.5)
    doc.setTextColor(20, 20, 30)
    doc.text(doc.splitTextToSize(`${s.roll_no ? `${s.roll_no}. ` : ''}${s.name}`, 200)[0], 40, y)
    doc.text(!s.latest ? 'not yet' : s.latest.score === null ? 'no data' : Number(s.latest.score).toFixed(1), 250, y)
    doc.text(p(s.attendance_rate), 300, y)
    doc.text(p(s.homework_rate), 370, y)
    doc.text(s.marks_pct === null ? '—' : `${s.marks_pct}%`, 440, y)
    doc.setTextColor(...MUTED)
    doc.text(s.latest ? fmtDate(s.latest.created_at) : 'not yet', 490, y)
    y += 18
  }
  const scored = r.students.filter((s) => s.latest?.score !== null && s.latest?.score !== undefined)
  y = ensure(doc, y, 40) + 10
  doc.setFontSize(10)
  doc.setTextColor(20, 20, 30)
  doc.text(`${r.students.length} students · ${scored.length} with a score${scored.length ? ` · class average ${(scored.reduce((a, s) => a + Number(s.latest!.score), 0) / scored.length).toFixed(1)}` : ''}`, 40, y)
  footer(doc)
  await saveFile(`class-report-${r.class.replace(/[^\w-]+/g, '_')}.pdf`, doc.output('blob'))
}
