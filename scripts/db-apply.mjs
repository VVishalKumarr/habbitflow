// Applies a SQL file (or an inline query) to the Supabase project through the
// Management API. The whole file runs as one statement batch: if anything
// fails, nothing is applied.
//
//   node --env-file=.env scripts/db-apply.mjs supabase/migrations/<file>.sql
//   node --env-file=.env scripts/db-apply.mjs --query "select count(*) from public.institutions"
//
// Needs SUPABASE_ACCESS_TOKEN (supabase.com → Account → Access Tokens) and
// VITE_SUPABASE_URL in .env. Never commit the token.
import { readFileSync } from 'node:fs'

const url = process.env.VITE_SUPABASE_URL
const token = process.env.SUPABASE_ACCESS_TOKEN
if (!url || !token) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_ACCESS_TOKEN in .env first.')
  process.exit(1)
}
const ref = new URL(url).hostname.split('.')[0]

const args = process.argv.slice(2)
const query = args[0] === '--query' ? args[1] : readFileSync(args[0], 'utf8')
if (!query) {
  console.error('Usage: db-apply.mjs <file.sql> | --query "<sql>"')
  process.exit(1)
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
})
const text = await res.text()
if (!res.ok) {
  console.error(`Failed (${res.status}): ${text}`)
  process.exit(1)
}
console.log(args[0] === '--query' ? text : `Applied ${args[0]}`)
