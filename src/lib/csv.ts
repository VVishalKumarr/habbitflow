// CSV reading (imports) and writing (exports).
import { saveFile } from './native'

/** Quotes a cell and neutralises spreadsheet formulas (=, +, -, @ at the start). */
export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

/** Builds a CSV (with BOM so Excel reads UTF-8) and saves / shares it. */
export async function downloadCsv(filename: string, header: string[], rows: unknown[][]): Promise<void> {
  const csv = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
  await saveFile(filename, new Blob([csv], { type: 'text/csv;charset=utf-8' }))
}

/**
 * Parses CSV text (RFC 4180: quoted fields, "" escapes, newlines inside
 * quotes). Detects ',' / ';' / tab from the header line. Empty lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.slice(0, src.search(/\r?\n|$/))
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length }))
  const delim = counts.sort((a, b) => b.n - a.n)[0].d
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === delim) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''))
}

/**
 * Turns parsed rows into objects using the header row. `fields` maps each
 * field to the header names that mean it (case and spacing ignored).
 * Returns the records, which fields were found, and unknown columns.
 */
export function mapColumns<K extends string>(rows: string[][], fields: Record<K, string[]>) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const [head = [], ...body] = rows
  const index = {} as Record<K, number>
  const unknown: string[] = []
  head.forEach((h, i) => {
    const key = (Object.keys(fields) as K[]).find((k) => fields[k].some((alias) => norm(alias) === norm(h)))
    if (key && index[key] === undefined) index[key] = i
    else unknown.push(h)
  })
  const records = body.map((r) => {
    const o = {} as Record<K, string>
    for (const k of Object.keys(fields) as K[]) o[k] = index[k] === undefined ? '' : (r[index[k]] ?? '').trim()
    return o
  })
  return { records, found: Object.keys(index) as K[], unknown }
}
