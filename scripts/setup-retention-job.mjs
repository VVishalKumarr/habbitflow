// Schedules the hourly homework retention job.
//   node --env-file=.env scripts/setup-retention-job.mjs
// 1. generates a random secret (never printed),
// 2. stores it as the RETENTION_JOB_SECRET function secret,
// 3. stores the same value in Supabase Vault,
// 4. (re)creates the pg_cron job that POSTs to the homework-retention function
//    with that secret every hour at minute 17.
// Safe to re-run: it rotates the secret and replaces the job.
import { randomBytes } from 'node:crypto'

const url = process.env.VITE_SUPABASE_URL
const token = process.env.SUPABASE_ACCESS_TOKEN
if (!url || !token) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_ACCESS_TOKEN in .env first.')
  process.exit(1)
}
const ref = new URL(url).hostname.split('.')[0]
const api = (path, body) =>
  fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`)
    return r.text()
  })

const secret = randomBytes(32).toString('hex')
await api('/secrets', [{ name: 'RETENTION_JOB_SECRET', value: secret }])
await api('/database/query', {
  query: `
    do $$ begin
      perform vault.update_secret(id, '${secret}') from vault.secrets where name = 'homework_retention_secret';
      if not found then perform vault.create_secret('${secret}', 'homework_retention_secret', 'homework-retention job'); end if;
    end $$;
    select cron.unschedule('homework-retention') where exists (select 1 from cron.job where jobname = 'homework-retention');
    select cron.schedule('homework-retention', '17 * * * *', $job$
      select net.http_post(
        url := '${url}/functions/v1/homework-retention',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-secret',
                   (select decrypted_secret from vault.decrypted_secrets where name = 'homework_retention_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000)
    $job$);
  `,
})
console.log('Homework retention job scheduled hourly (secret rotated).')
