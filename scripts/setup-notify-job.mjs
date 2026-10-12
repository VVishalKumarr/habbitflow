// Sets up notification delivery.
//   node --env-file=.env scripts/setup-notify-job.mjs           (job only, rotates its secret)
//   node --env-file=.env scripts/setup-notify-job.mjs --vapid   (also creates browser-push keys)
// 1. with --vapid: generates a VAPID key pair and stores VAPID_PUBLIC_KEY /
//    VAPID_PRIVATE_KEY / VAPID_SUBJECT as function secrets. New keys make
//    existing browser subscriptions stop working (people re-enable push), so
//    only use --vapid the first time or if the private key leaked.
// 2. generates a random job secret (never printed), stores it as the
//    NOTIFY_JOB_SECRET function secret and in Supabase Vault;
// 3. (re)creates the pg_cron job that calls notify-deliver every minute —
//    only when a delivery is due, so idle minutes cost nothing.
import { randomBytes } from 'node:crypto'
import { generateVapidKeys } from '../supabase/functions/_shared/webpush.ts'

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

if (process.argv.includes('--vapid')) {
  const keys = await generateVapidKeys()
  const subject = process.env.VAPID_SUBJECT || 'https://vvishalkumarr.github.io/habbitflow'
  await api('/secrets', [
    { name: 'VAPID_PUBLIC_KEY', value: keys.publicKey },
    { name: 'VAPID_PRIVATE_KEY', value: keys.privateKey },
    { name: 'VAPID_SUBJECT', value: subject },
  ])
  console.log(`Browser push keys created (public key ${keys.publicKey.slice(0, 12)}…).`)
}

const secret = randomBytes(32).toString('hex')
await api('/secrets', [{ name: 'NOTIFY_JOB_SECRET', value: secret }])
await api('/database/query', {
  query: `
    do $$ begin
      perform vault.update_secret(id, '${secret}') from vault.secrets where name = 'notify_job_secret';
      if not found then perform vault.create_secret('${secret}', 'notify_job_secret', 'notify-deliver job'); end if;
    end $$;
    select cron.unschedule('notify-deliver') where exists (select 1 from cron.job where jobname = 'notify-deliver');
    select cron.schedule('notify-deliver', '* * * * *', $job$
      select net.http_post(
        url := '${url}/functions/v1/notify-deliver',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-secret',
                   (select decrypted_secret from vault.decrypted_secrets where name = 'notify_job_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000)
      where exists (select 1 from public.notification_deliveries where status = 'pending' and next_attempt_at <= now())
    $job$);
  `,
})
console.log('Notification delivery job scheduled every minute (secret rotated).')
