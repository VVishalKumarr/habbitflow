# Licences, gift codes and plans

Everything here is enforced in the database
(`supabase/migrations/2026-10-13_licensing_phase4.sql`). The app only displays it.

## Who gets what (entitlement rules)

A user's access is the **best of every active source**, merged:

| Source | Who | Ends when |
|---|---|---|
| Paid subscription (Razorpay, Google Play…) | the buyer | the provider says so |
| Free trial | once per account | after `trial_days` |
| Gift code / personal licence code | whoever redeems it | `duration_days` after redemption (codes for the same plan stack) |
| Manual grant (platform owner) | one account | after the chosen days, or when ended |
| Institution licence | every **active** staff member and student of that institution (not parents, not suspended or revoked members, not if the institution is suspended) | `expires_at` + grace period, or at once if revoked |
| Free plan | everyone | never |

Merging: features are the union of all sources; each limit takes the most generous
value (empty = unlimited). The badge shows the highest-ranked plan. Example: a
student with personal Pro at a school with a Plus licence gets Pro.

One function decides this — `entitlement_sources(user)` → `effective_limits()` /
`effective_features()` — and every check uses it through `plan_of`, `plan_limit` and
`has_feature` (trackers, friends, history, exports, themes, leaderboards…).
`my_entitlements()` returns the same result to the app.

**Entitlements never grant permissions.** A licensed student is still a student.

## Plans

| | Free | Plus | Pro |
|---|---|---|---|
| Friends (incl. sent requests) | 1 | 3 | unlimited |
| Trackers | 2 | unlimited | unlimited |
| AI timetable that asks your needs first | — | ✓ | ✓ |

The full list is in [MONETIZATION.md](MONETIZATION.md). Change limits and features in
**Platform admin → Plans** (audited, applies immediately). Prices are set with the payment
providers, not there.

Lowering a limit never deletes anything: someone over their friend limit keeps every
friend and request, they just can't add more until they're under it.

Features listed in `UNRELEASED_FEATURES` (`src/config/features.ts`) are stored in plans
but not advertised on the pricing page until they ship.

## Codes

| Kind | Prefix | Redeemed by | Grants |
|---|---|---|---|
| Gift code | `HFG-` | any personal or institutional account, in **Settings → Plan → Redeem a code** | the plan for `duration_days` |
| Personal licence | `HFL-` | same as gift (use for sales outside the app stores, e.g. bank transfer) | the plan for `duration_days` |
| Institution licence | `HFI-` | the principal or director of **that** institution, in **School → Settings → Licence** | the plan for every active staff member and student for `duration_days` (+ grace) |

- 16 random characters from a 32-letter alphabet without 0/O/1/I (80 bits, pgcrypto).
- Shown **once** when generated. Only a SHA-256 hash and the last 4 characters are stored,
  so nobody — including you — can look a code up later. Save them when you generate them.
- Case, spaces and dashes don't matter when typing a code.
- Options: number of uses per code (gift/personal), a redeem-by date, a note.
- Redemption locks the code row, so a limited code can't be over-used by simultaneous
  requests; each account can redeem a given code once. Attempts are rate-limited
  (10 per hour per account).
- There is no master key: a code only works if its hash is in the database.

### Generating codes

**In the app:** Platform admin → **Codes** → Generate codes → copy or download the CSV.

**From the command line** (or ask Claude Code to run it for you):

```
node --env-file=.env scripts/generate-codes.mjs --kind gift --plan plus --days 30 --count 10
node --env-file=.env scripts/generate-codes.mjs --kind gift --plan pro --days 90 --uses 100 --redeem-by 2026-12-31 --note "Diwali promo"
node --env-file=.env scripts/generate-codes.mjs --kind individual --plan pro --days 365 --note "Order 1042, bank transfer"
node --env-file=.env scripts/generate-codes.mjs --kind institution --institution <institution id> --plan pro --days 365 --grace 14
```

The script needs `SUPABASE_ACCESS_TOKEN` in `.env`. The institution id is in the
institution's row in Platform admin (or `select id, name from public.institutions`).

### Revoking

Platform admin → Codes → click a code → Revoke (a reason is required).

- By default only **new redemptions stop**; people who already redeemed keep their period.
- Tick **"Also end access already granted"** for refunds or abuse: gift subscriptions from
  that code end now and institution licences from it are revoked.

## Institution licences

1. Create the institution and invite its principal (see [INSTITUTION_ONBOARDING.md](INSTITUTION_ONBOARDING.md)).
2. Generate an **Institution licence** key for that institution (plan, length, grace days).
3. Send the key to the principal/director. They enter it in **School → Settings → Licence**.
   A key for another institution, or a personal code, is refused with a clear message.
4. **Renewal:** generate a new key; once activated it starts when the current licence ends.

### Expiry and grace policy

- After `expires_at`, members keep licensed features for `grace_days` (default 7,
  0–60). Settings shows the licence as "Expired — grace period" to heads and a notice to members.
- After the grace period, licensed features stop. Free limits apply to *new* items only.
- **No academic record, tracker, friend or file is ever deleted** because a licence ended.
- Revoking a licence (Platform admin → Licences → Revoke) ends access immediately, no grace.

## Manual grants and support

Platform admin → **Accounts**: look up a username to see its plan sources and
subscriptions; grant a plan for N days with a note; end a manual grant or gift
subscription. Paid subscriptions are cancelled with the payment provider instead.

## History

Platform admin → **History** shows generated, redeemed, activated and revoked codes and
licences, plan changes and manual grants (from the append-only `audit_log`).
Institution licence activations and revocations also appear in that institution's
**Audit history**.
