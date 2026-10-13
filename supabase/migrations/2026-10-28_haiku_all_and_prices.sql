-- =====================================================================
-- Every plan uses Claude Haiku 5.5 (Free, Plus, Pro and school students),
-- so the "most capable AI" line is no longer advertised; cost tracking at
-- Haiku prices ($0.10 / $0.50 per million tokens, prompts up to 100K).
-- Prices: Plus ₹79/mo · ₹699/yr · $2.49/$19.99; Pro ₹149/mo · ₹1,299/yr ·
-- $4.99/$39.99. Razorpay / Play plans must use the same amounts.
-- Safe to re-run.
-- =====================================================================
update public.plans set features = array_remove(features, 'advanced_ai') where 'advanced_ai' = any (features);

update public.ai_settings set usd_per_mtok_input = 0.10, usd_per_mtok_output = 0.50;

update public.plans set price_monthly = 7900, price_yearly = 69900,
  prices = '{"IN": {"currency": "INR", "monthly": 7900, "yearly": 69900}, "default": {"currency": "USD", "monthly": 249, "yearly": 1999}}'
 where id = 'plus';
update public.plans set price_monthly = 14900, price_yearly = 129900,
  prices = '{"IN": {"currency": "INR", "monthly": 14900, "yearly": 129900}, "default": {"currency": "USD", "monthly": 499, "yearly": 3999}}'
 where id = 'pro';
