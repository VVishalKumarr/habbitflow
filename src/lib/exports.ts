// Pro exports. Both formats get their rows from export_timetable(), which the
// database only answers for accounts with the csv_export feature, and only
// with the caller's own data.
import { csvCell } from './csv'
import { addDays, DAY_NAMES, formatDate, todayISO, type ISODate } from './dates'
import { friendlyError } from './errors'
import { saveFile } from './native'
import { supabase } from './supabase'

export interface ExportRow {
  day: string
  tracker_id: string
  tracker: string
  task: string
  category: string
  weekday: number
  start_time: string
  end_time: string
  completed: boolean
}

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

async function fetchRows(from: ISODate, to: ISODate): Promise<ExportRow[]> {
  const { data, error } = await supabase.rpc('export_timetable', { p_from: from, p_to: to, p_tz: timeZone() })
  if (error) throw new Error(friendlyError(error))
  return data as ExportRow[]
}


export async function exportCsv(from: ISODate, to: ISODate, username: string): Promise<number> {
  const rows = await fetchRows(from, to)
  const header = ['Date', 'Tracker', 'Task', 'Category', 'Day', 'Start', 'End', 'Completed']
  const lines = rows.map((r) =>
    [r.day, r.tracker, r.task, r.category, DAY_NAMES[r.weekday], r.start_time.slice(0, 5), r.end_time.slice(0, 5), r.completed ? 'Yes' : 'No']
      .map(csvCell)
      .join(','),
  )
  const csv = '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n')
  await saveFile(`habbitflow-${username}-${from}-to-${to}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  return rows.length
}

/** Longest run of consecutive days (with something scheduled) where everything was done. */
function streaks(days: { date: string; scheduled: number; done: number }[]) {
  let best = 0
  let run = 0
  for (const d of days) {
    if (!d.scheduled) continue
    run = d.done === d.scheduled ? run + 1 : 0
    best = Math.max(best, run)
  }
  let current = 0
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]
    if (!d.scheduled) continue
    if (d.done === d.scheduled) current++
    else if (i === days.length - 1) continue
    else break
  }
  return { best, current }
}

export async function exportPdf(opts: { trackerId: string; trackerName: string; from: ISODate; to: ISODate; username: string }): Promise<void> {
  const all = await fetchRows(opts.from, opts.to)
  const rows = all.filter((r) => r.tracker_id === opts.trackerId)
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const M = 48
  let y = M

  const brand: [number, number, number] = [87, 80, 224]
  const ink: [number, number, number] = [23, 26, 38]
  const muted: [number, number, number] = [95, 101, 120]

  const done = rows.filter((r) => r.completed).length
  const total = rows.length
  const rate = total ? done / total : 0

  // Daily series
  const byDay = new Map<string, { date: string; scheduled: number; done: number }>()
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) byDay.set(d, { date: d, scheduled: 0, done: 0 })
  for (const r of rows) {
    const d = byDay.get(r.day)
    if (!d) continue
    d.scheduled++
    if (r.completed) d.done++
  }
  const days = [...byDay.values()]
  const s = streaks(days)

  // Header
  doc.setFillColor(...brand)
  doc.rect(0, 0, W, 6, 'F')
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.text('HabbitFlow progress report', M, (y += 16))
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(...muted)
  doc.text(
    `${opts.trackerName} · ${formatDate(opts.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${formatDate(opts.to, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    M,
    (y += 20),
  )
  doc.text(`Prepared for ${opts.username} on ${formatDate(todayISO(), { month: 'long', day: 'numeric', year: 'numeric' })}`, M, (y += 16))

  // Summary tiles
  y += 24
  const tiles: [string, string][] = [
    ['Completion', `${Math.round(rate * 100)}%`],
    ['Completed', String(done)],
    ['Missed', String(total - done)],
    ['Best streak', `${s.best} day${s.best === 1 ? '' : 's'}`],
  ]
  const tw = (W - 2 * M - 3 * 12) / 4
  tiles.forEach(([k, v], i) => {
    const x = M + i * (tw + 12)
    doc.setFillColor(240, 241, 246)
    doc.roundedRect(x, y, tw, 58, 8, 8, 'F')
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text(k, x + 12, y + 20)
    doc.setFontSize(18)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...ink)
    doc.text(v, x + 12, y + 44)
    doc.setFont('helvetica', 'normal')
  })
  y += 58 + 32

  // Weekly chart: completion % per week
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  doc.text('Weekly completion', M, y)
  doc.setFont('helvetica', 'normal')
  y += 14
  const weeks: { label: string; scheduled: number; done: number }[] = []
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7)
    weeks.push({
      label: formatDate(chunk[0].date, { month: 'short', day: 'numeric' }),
      scheduled: chunk.reduce((a, d) => a + d.scheduled, 0),
      done: chunk.reduce((a, d) => a + d.done, 0),
    })
  }
  const shown = weeks.slice(-12)
  const chartH = 120
  const bw = Math.min(36, (W - 2 * M) / Math.max(1, shown.length) - 8)
  doc.setDrawColor(227, 229, 236)
  doc.line(M, y + chartH, W - M, y + chartH)
  shown.forEach((w, i) => {
    const r = w.scheduled ? w.done / w.scheduled : 0
    const h = Math.max(1, r * chartH)
    const x = M + i * (bw + 8) + 4
    doc.setFillColor(...brand)
    doc.roundedRect(x, y + chartH - h, bw, h, 3, 3, 'F')
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text(w.label, x + bw / 2, y + chartH + 12, { align: 'center' })
    doc.setTextColor(...ink)
    if (w.scheduled) doc.text(`${Math.round(r * 100)}%`, x + bw / 2, y + chartH - h - 4, { align: 'center' })
  })
  y += chartH + 40

  // Task performance
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...ink)
  doc.text('Task performance', M, y)
  doc.setFont('helvetica', 'normal')
  y += 18
  const perTask = new Map<string, { done: number; total: number }>()
  for (const r of rows) {
    const k = r.task.trim()
    const t = perTask.get(k) ?? { done: 0, total: 0 }
    t.total++
    if (r.completed) t.done++
    perTask.set(k, t)
  }
  const tasks = [...perTask.entries()].sort((a, b) => b[1].done / b[1].total - a[1].done / a[1].total)
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text('Task', M, y)
  doc.text('Done', W - M - 120, y)
  doc.text('Rate', W - M - 40, y)
  y += 8
  for (const [name, t] of tasks) {
    if (y > doc.internal.pageSize.getHeight() - M) {
      doc.addPage()
      y = M
    }
    y += 16
    doc.setTextColor(...ink)
    doc.setFontSize(10)
    doc.text(doc.splitTextToSize(name, W - 2 * M - 180)[0], M, y)
    doc.text(`${t.done}/${t.total}`, W - M - 120, y)
    doc.text(`${Math.round((t.done / t.total) * 100)}%`, W - M - 40, y)
  }
  if (!tasks.length) {
    y += 16
    doc.setTextColor(...muted)
    doc.text('No scheduled tasks in this period.', M, y)
  }

  await saveFile(`habbitflow-report-${opts.from}-to-${opts.to}.pdf`, doc.output('blob'))
}
