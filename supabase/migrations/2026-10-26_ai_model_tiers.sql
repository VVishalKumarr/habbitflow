-- =====================================================================
-- AI model tiers. Plus, Pro and school-paid requests use the most capable
-- model (Claude Opus 5.5); Free requests use the fast Claude Haiku 5.5. The
-- Edge Functions choose the model from the plan each request is charged to
-- (supabase/functions/_shared/ai-quota.ts); this only advertises it.
-- Safe to re-run.
-- =====================================================================
update public.plans set features = features || array['advanced_ai']
 where id in ('plus', 'pro') and not ('advanced_ai' = any (features));
