-- =====================================================================
-- Razorpay for international (US$) payments too.
-- The existing razorpay_plan_* columns hold the Indian (₹) plans; these hold
-- the matching Razorpay plans created in USD. The billing function picks the
-- set that matches the visitor's pricing region.
-- Safe to re-run.
-- =====================================================================
alter table public.plans add column if not exists razorpay_plan_monthly_usd text;
alter table public.plans add column if not exists razorpay_plan_yearly_usd  text;
