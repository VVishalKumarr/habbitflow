# AI limits and cost controls

Every AI request — the help assistant, the timetable assistant and voice commands
([AI_TIMETABLE.md](AI_TIMETABLE.md)) — passes one server-side gate before the model is called. Limits are enforced
in the database (`supabase/migrations/2026-10-15_ai_quotas_phase5.sql`); the app only
shows them. API keys stay in Edge Function secrets.

## Features and default limits

Requests per student. Empty = unlimited. All of these — change them
in **Platform admin → AI** without touching code.

| Feature (key) | Period | Free | Plus | Pro | Institution (max) |
|---|---|---|---|---|---|
| AI help assistant (`chat`) | month | 5 | 60 | 150 | 40 |
| AI voice commands (`voice_command`) | month | 5 | 100 | 200 | 60 |
| AI timetable generation (`timetable_generate`) | month | off | 3 | 8 | 3 |
| Timetable evaluation (`timetable_evaluate`) | month | 1 | 6 | 15 | 6 |
| Study plan explanations (`study_plan`) | month | off | 5 | 15 | 8 |
| AI rescheduling (`reschedule`) | month | 1 | 10 | 25 | 10 |

Lowered on 2026-10-12 (all monthly) so one user's worst-case AI cost on Claude Opus 5.5
stays around $0.15 (Free, lowered again the same day), $3.30 (Plus), $7.90 (Pro) and $2.60 per school student; a
typical user costs well under $1 a month. When an allowance runs out, commands fall back
to the built-in parser and help to the articles.

Periods reset at midnight (day), Monday (week) or the 1st (month) in the quota time zone
(default Asia/Kolkata, changeable in Platform admin → AI → Cost controls).

## Which model answers

Plus, Pro and school-paid requests use the most capable model (`AI_MODEL`, default
Claude Opus 5.5, with automatic fallback if a request is declined); Free requests use the
fast model (`AI_MODEL_FREE`, default Claude Haiku 5.5 — about 40× cheaper). The Edge
Functions pick it from the plan the database charged the request to
(`beginAi()` in `supabase/functions/_shared/ai-quota.ts`). The plans list
“Our most capable AI for answers and planning” (`advanced_ai`) for Plus and Pro.

## Which limit applies

- **Personal plan:** the highest plan from the user's own subscriptions, trials, gift
  codes and manual grants (Free if none).
- **Institution:** members (staff and students) of an institution with an active licence
  get the platform's *Institution* limits, which the principal/director can switch off or
  lower per feature (never raise) in **School → Settings → AI features**.
- The student gets **the more generous** of the two. Requests are charged to the
  personal allowance first and to the institution after that.
- **Shared pool (optional):** the platform owner can give an institution a monthly pool of
  requests and/or tokens (Platform admin → AI → Institutions → Credit pool). Requests charged
  to the institution also draw from the pool; when it's used up they're refused until next
  month, even if the student has allowance left. Each student's own limit still applies.
- One student's usage never touches another's.

## Counting rules

| Outcome | Counts? |
|---|---|
| Success | yes, 1 request |
| Refused by a limit, plan, size limit, burst limit, pool or cap | no (recorded as *rejected* for statistics) |
| Model or server error, AI not configured | no (*refunded*) |
| Retry with the same `request_id` after success | not charged again (*duplicate*) |
| Retry after a failure | allowed, counted once if it succeeds |
| Reservation that never finishes | stops counting after 10 minutes |

`ai_begin` takes a per-user lock while it checks and reserves, so simultaneous requests
(several tabs, devices or scripted calls) can never exceed a limit. The browser can't call
`ai_begin`/`ai_finish`, write `ai_usage` or change any limit; the Edge Function calls them
with the service role.

## Cost controls (Platform admin → AI → Cost controls)

- **Max request length** (characters, default 4,000) — longer requests are refused. For
  the timetable assistant this counts what the student typed (answers, command, event
  name, or the timetable listing for a check), not the school data the server adds.
- **Max answer length** (tokens, default 2,000) — passed to the model as `max_tokens`.
  Timetable generation uses at least 12,000 (a whole week plus the model's reasoning
  doesn't fit in less).
- **Requests per student per hour** (default 30, all features) — stops bursts.
- **Platform token cap per month** (default none) — AI pauses for everyone when reached.
- **Institution token cap per month** — part of the institution's credit pool.
- **$ per million tokens** — only for the cost *estimate*.

Token counts are **measured** from the provider's response (`usage`). Cost figures are
**estimates** from the prices you enter, not a bill. Speech for voice commands is
recognised in the browser/phone, so no audio is sent or stored; `audio_seconds` exists for
providers that bill audio.

## What people see

- **Students:** Settings → **AI usage**: each feature's limit, use so far, what's left and
  when it resets; "Not included in your plan" with an upgrade link, or a note that the
  school sets the limits.
- **When a limit is reached:** a structured response (`code`, `limit`, `used`, `period`,
  `resets_at`, `plan`, `institution`), shown as "You've used all N … It resets in 3 h" plus
  an upgrade or ask-your-school hint. Nothing pretends to have succeeded.
- **Principal/director:** School → Settings → **AI features**: switches and limits per
  feature, use this period, the pool, and requests per student this month (counts only).
- **Platform owner:** Platform admin → **AI**: monthly requests, refusals, refunds, tokens,
  cost estimate, use by feature/plan/institution, most active personal accounts, all limits.

No prompts or answers are stored — only counts, token numbers and outcomes. Changes to
limits and pools are recorded in the audit log.

## Adding a new AI feature (Phase 6 onwards)

1. `insert into public.ai_features (feature, label, period, sort) values (...)` and a row per
   plan in `ai_plan_quotas` (or set them in Platform admin → AI).
2. In the Edge Function: `beginAi(user, 'feature', requestId(body.request_id), inputChars)`
   → if refused, `return quotaResponse(req, quota)` → call the model with
   `max_tokens: quota.max_output_tokens` → `finishAi(usage_id, ok, { tokensIn, tokensOut, model })`
   (see `supabase/functions/_shared/ai-quota.ts` and the `assistant` function).
