// Generates gift codes, individual licence codes or an institution licence key
// and registers them in the database (only their SHA-256 hashes are stored).
// The codes are printed once — save them somewhere safe; they can't be shown again.
//
//   node --env-file=.env scripts/generate-codes.mjs --kind gift --plan plus --days 30 --count 10
//   node --env-file=.env scripts/generate-codes.mjs --kind gift --plan pro --days 90 --uses 100 --redeem-by 2026-12-31 --note "Diwali promo"
//   node --env-file=.env scripts/generate-codes.mjs --kind individual --plan pro --days 365 --note "Paid by bank transfer, order 1042"
//   node --env-file=.env scripts/generate-codes.mjs --kind institution --institution <uuid> --plan pro --days 365 --grace 14
//
// Options: --kind gift|individual|institution  --plan plus|pro  --days N (access length)
//          --count N (default 1)  --uses N (redemptions per code, default 1)
//          --redeem-by YYYY-MM-DD  --institution <id>  --grace N (institution, default 7)  --note "…"
// Needs SUPABASE_ACCESS_TOKEN and VITE_SUPABASE_URL in .env (same as db-apply.mjs).

const url = process.env.VITE_SUPABASE_URL
const token = process.env.SUPABASE_ACCESS_TOKEN
if (!url || !token) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_ACCESS_TOKEN in .env first.')
  process.exit(1)
}
const ref = new URL(url).hostname.split('.')[0]

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]
  if (!k.startsWith('--')) {
    console.error(`Unexpected argument: ${k}`)
    process.exit(1)
  }
  args[k.slice(2)] = process.argv[i + 1]
}

const int = (v, d) => (v === undefined ? d : Number.parseInt(v, 10))
const kind = args.kind
const plan = args.plan
const days = int(args.days)
if (!['gift', 'individual', 'institution'].includes(kind) || !plan || !Number.isInteger(days)) {
  console.error('Usage: --kind gift|individual|institution --plan <plan> --days <N> [--count N] [--uses N] [--redeem-by YYYY-MM-DD] [--institution <id>] [--grace N] [--note "…"]')
  process.exit(1)
}

// SQL literals: every value is validated or quoted here, and again inside the database function.
const q = (v) => (v === undefined || v === null ? 'null' : `'${String(v).replaceAll("'", "''")}'`)
const n = (v) => (Number.isInteger(v) ? String(v) : 'null')
if (args.institution && !/^[0-9a-f-]{36}$/i.test(args.institution)) {
  console.error('--institution must be an institution id (uuid).')
  process.exit(1)
}
if (args['redeem-by'] && !/^\d{4}-\d{2}-\d{2}$/.test(args['redeem-by'])) {
  console.error('--redeem-by must be YYYY-MM-DD.')
  process.exit(1)
}

const sql = `select id, code from public.generate_license_codes(
  null, ${q(kind)}, ${q(plan)}, ${n(int(args.count, 1))}, ${n(days)}, ${n(int(args.uses, 1))},
  ${args['redeem-by'] ? `${q(args['redeem-by'])}::date + interval '1 day'` : 'null'},
  ${args.institution ? `${q(args.institution)}::uuid` : 'null'}, ${q(args.note)}, ${n(int(args.grace, 7))})`

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})
const text = await res.text()
if (!res.ok) {
  const msg = text.match(/ERROR:\s*([^"\\]+)/)?.[1] ?? text
  console.error(`Failed: ${msg}`)
  process.exit(1)
}
const rows = JSON.parse(text)
console.log(`${rows.length} ${kind} code${rows.length === 1 ? '' : 's'} for ${plan}, ${days} days each. Save them now — they can't be shown again:\n`)
for (const r of rows) console.log(r.code)
