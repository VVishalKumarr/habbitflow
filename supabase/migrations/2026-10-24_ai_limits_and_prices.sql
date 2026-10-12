-- =====================================================================
-- AI limits and plan prices (October 2026).
--
-- * Every AI allowance is monthly (help questions and commands were daily),
--   sized so one user's worst-case AI cost stays bounded:
--                         Free  Plus  Pro  Institution (max per student)
--     chat                  20    60  150   40
--     voice_command         20   100  200   60
--     timetable_generate     -     3    8    3
--     timetable_evaluate     2     6   15    6
--     reschedule             3    10   25   10
--     study_plan             -     5   15    8
--   When an allowance runs out, commands fall back to the built-in parser and
--   help to the articles; nothing else stops working.
-- * Cost estimates use Claude Opus 5.5 prices ($4 / $20 per million tokens).
-- * Prices: Plus ₹99/mo · ₹899/yr · $2.99/$24.99; Pro ₹199/mo · ₹1,799/yr ·
--   $5.99/$49.99. Razorpay / Play plans must be created with the same amounts.
-- Existing subscriptions keep what they paid until renewal.
-- Safe to re-run.
-- =====================================================================

update public.ai_features set period = 'month' where feature in ('chat', 'voice_command');

update public.ai_plan_quotas q
   set max_requests = v.n, enabled = v.on_, updated_at = now()
  from (values
    ('free', 'chat', true, 20),        ('plus', 'chat', true, 60),        ('pro', 'chat', true, 150),        ('institution', 'chat', true, 40),
    ('free', 'voice_command', true, 20), ('plus', 'voice_command', true, 100), ('pro', 'voice_command', true, 200), ('institution', 'voice_command', true, 60),
    ('free', 'timetable_generate', false, 0), ('plus', 'timetable_generate', true, 3), ('pro', 'timetable_generate', true, 8), ('institution', 'timetable_generate', true, 3),
    ('free', 'timetable_evaluate', true, 2), ('plus', 'timetable_evaluate', true, 6), ('pro', 'timetable_evaluate', true, 15), ('institution', 'timetable_evaluate', true, 6),
    ('free', 'reschedule', true, 3),     ('plus', 'reschedule', true, 10),    ('pro', 'reschedule', true, 25),   ('institution', 'reschedule', true, 10),
    ('free', 'study_plan', false, 0),    ('plus', 'study_plan', true, 5),     ('pro', 'study_plan', true, 15),   ('institution', 'study_plan', true, 8)
  ) as v(plan_key, feature, on_, n)
 where q.plan_key = v.plan_key and q.feature = v.feature;

-- Institutions can lower these for their students but never exceed them.
update public.institution_ai_quotas i
   set max_requests = q.max_requests
  from public.ai_plan_quotas q
 where q.plan_key = 'institution' and q.feature = i.feature and i.max_requests > q.max_requests;

-- Cost tracking at Claude Opus 5.5 prices.
update public.ai_settings set usd_per_mtok_input = 4, usd_per_mtok_output = 20;

update public.plans set price_monthly = 9900, price_yearly = 89900,
  prices = '{"IN": {"currency": "INR", "monthly": 9900, "yearly": 89900}, "default": {"currency": "USD", "monthly": 299, "yearly": 2499}}'
 where id = 'plus';
update public.plans set price_monthly = 19900, price_yearly = 179900,
  prices = '{"IN": {"currency": "INR", "monthly": 19900, "yearly": 179900}, "default": {"currency": "USD", "monthly": 599, "yearly": 4999}}'
 where id = 'pro';
