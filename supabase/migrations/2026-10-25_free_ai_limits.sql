-- =====================================================================
-- Smaller AI allowance on the Free plan (per month): 5 help questions,
-- 5 commands, 1 timetable check, 1 reschedule. Generation and study plan
-- explanations stay Plus/Pro. When the allowance runs out, commands use the
-- built-in parser and help shows the articles.
-- Safe to re-run.
-- =====================================================================
update public.ai_plan_quotas q
   set max_requests = v.n, updated_at = now()
  from (values ('chat', 5), ('voice_command', 5), ('timetable_evaluate', 1), ('reschedule', 1)) as v(feature, n)
 where q.plan_key = 'free' and q.feature = v.feature;
