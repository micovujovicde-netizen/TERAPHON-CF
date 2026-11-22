# TERAPHON License — GitHub deploy and setup

This is the **TERAPHON-only** Cloudflare Worker. It is NOT BrakeMonster PRO. This package was prepared from the provided TERAPHON v0.2.176 source and the complete TERAPHON Creem IDs.

## Fixed settings

| Plan | Creem Product ID | Price |
|---|---|---|
| Monthly | `prod_g1lpJZPJbfKTkhr8qiqbn` | €3.50 / month |
| Yearly | `prod_6cQTQHjizsAhj9BAkvJoIn` | €30 / year |
| Lifetime | `prod_6fnL2AfTLkXb9WU1BYDZzL` | €60 once |

- First 7 days: free in the app; **no payment card**, all supported features unlocked.
- **Creem trial disabled** — prevent double trials.
- Worker: `teraphon-license`.
- D1: `teraphon-licenses`, binding `DB`.
- Confirmed in Cloudflare dashboard: 6 app tables (`_cf_KV` is Cloudflare internal).
- Expected Worker URL: `https://teraphon-license.micovujovic-de.workers.dev`.
- **BILLING_ENABLED is deliberately `false` in deploy.** Do not turn on until real end-to-end purchase/activation checks pass.

## GitHub repo structure

Upload the *contents* of this package into the main branch of `micovujovicde-netizen/teraphonia-site` (or another dedicated repository):

```
.github/workflows/teraphon-license-deploy.yml
worker/teraphon-license.js
worker/schema.sql
worker/test-teraphon-worker.mjs
worker/test-payment-hooks.mjs
worker/README.md
```

There is only **one TERAPHON license deployment workflow**. It is manual (`workflow_dispatch`) for the first safe release. It does not touch `.github/workflows/deploy.yml`, `TERAPHONIA_Website.zip`, BrakeMonster products, code, D1, Worker, or API endpoints.

## One-time GitHub setup

Under the repository **Settings → Secrets and variables → Actions**, add these two *repository secrets*:

- `CLOUDFLARE_API_TOKEN` — a **dedicated**, restricted API token with **Workers Scripts: Edit** and **D1: Read** permissions for the account; grant no permission to modify BrakeMonster or its database if scoped Workers permissions are available.
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID (32-character hex string; not a password).

Do not paste either credential into chat, workflow, source, screenshots or README.

In GitHub **Actions → TERAPHON — deploy license Worker → Run workflow**. The workflow:

1. Checks JavaScript syntax and runs the included local integration tests.
2. Looks up the already-created D1 database `teraphon-licenses` via the Cloudflare API; aborts if it is missing.
3. Generates a temporary Wrangler configuration with binding `DB` to exactly that database, the 3 product IDs, and **BILLING_ENABLED=false**.
4. Updates only `teraphon-license` Worker.
5. Checks the public `GET /v1/health` response for `billingEnabled: false` and all 3 product IDs configured.

**This does NOT create the D1 tables**: they are already present. `schema.sql` is an archive and should not be re-run unless explicitly needed.

## Next: secrets in Cloudflare Worker settings

Use **Workers & Pages → teraphon-license → Settings → Variables and Secrets**. Add *Secret* entries, never ordinary public variables:

- `CREEM_API_KEY` — existing Creem API credential, if it is authorized for these new products.
- `CREEM_WEBHOOK_SECRET` — **TERAPHON-specific** Creem webhook signing secret corresponding to a new webhook endpoint `/webhook`. Never re-use the BM webhook secret unless expressly verified as intended by Creem; creating a separate webhook is preferable.
- `ACTIVATION_ENCRYPTION_KEY` — securely generated random **32 bytes, base64 encoded**. Keep safe: changing it makes previously issued TP1 activation codes undecryptable.

No secret is shipped in this package. The workflow is not supposed to alter these Worker secrets; confirm they are preserved after deploy. Set the Creem webhook target to `https://teraphon-license.micovujovic-de.workers.dev/webhook` only after verifying the correct product events and signature mode.

**Remaining gap:** Purchases from a *direct Creem public product page*, outside the in-app checkout, have no automatic association with an Android installation token. A verified **claim/activate by purchase** flow is still required for those buyers, or provide a secure alternative. Do not promise automatic activation of those purchases until tested.

Do not enable billing (`BILLING_ENABLED=true`) until the actual paid webhook and claim workflow is demonstrated against real controlled purchases. If enabling billing later, update only this TERAPHON workflow after validation.


## Verified-payment email via Resend (optional; disabled by default)

A buyer receives **one TERAPHON activation code for three Android devices** — not three separate licences. Automatic mail is only sent for a *signed, accepted* `subscription.paid` or paid lifetime `checkout.completed` event whose product matches TERAPHON. Duplicate events and subscription renewals do **not** create extra codes or separate accounts.

### Email prerequisites

In Cloudflare **Workers & Pages → teraphon-license → Settings → Variables and Secrets**, keep the existing `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET` and `ACTIVATION_ENCRYPTION_KEY` unchanged. Add secrets:

- `RESEND_API_KEY` — an API key with send rights from your verified Resend account.
- `TERAPHON_EMAIL_FROM` — sender identity on a **verified domain** (for example an address at teraphonia.com, but use the actual verified address).

Add an ordinary Worker variable `EMAIL_ENABLED` with value **`false`** while testing. The default if missing is also false. To opt in after completing all tests, change only this TERAPHON variable to `true`. Keep `BILLING_ENABLED=false` until separate paid checkout production verification is complete. **Do not put keys into files, GitHub commits or chat.**

### Safe behaviour

- There is a seventh, *additive* D1 table, `teraphon_email_outbox`. When mail is enabled, the Worker creates it automatically on the first **verified paid** webhook; the table definition is also archived in `schema.sql`.
- Code generation uses existing AES-GCM encryption from `ACTIVATION_ENCRYPTION_KEY`; keep that key unchanged.
- An email is sent via Resend with a stable idempotency key. A completed send is tracked so renewals cannot produce repeated activation messages.
- A verified paid licence remains active **even when Resend is temporarily unavailable**. Unsent messages remain pending in D1, retry on a signed duplicate paid webhook, or via a configured Worker Cron Trigger calling `scheduled()`.
- For reliable automatic retries, add a Cron Trigger to the TERAPHON Worker (e.g. every 15 minutes) and keep it in the *actual* `.github/workflows/teraphon-license-deploy.yml` generated Wrangler config. The currently active GitHub workflow does **not** configure a cron. Without a cron, retries are opportunistic only.
- `GET /v1/health` now includes `emailEnabled`, indicating presence of the required mail configuration and its enable flag (not a test of real delivery).

### Real test checklist

1. Run all included Node tests and check `/v1/health` for `billingEnabled=false`, `emailEnabled=false` before changing anything.
2. Confirm Resend sender verification and Cloudflare secrets without disclosing secret values.
3. Verify Creem webhook target and HMAC signature in Creem dashboard logs.
4. With a controlled test environment, prove that one signed paid event creates one active code and sends exactly one email; a repeated event should not send another.
5. Check that the same code activates devices 1, 2 and 3, and device 4 is refused.
6. Confirm failure/retry, refunds, cancellation/renewal, no mail for an unmatched product, and no mail on a forged signature.
7. Only when verified, explicitly enable `EMAIL_ENABLED=true`; production `BILLING_ENABLED` stays OFF until separately approved.

**Repo deployment caution:** the existing `unpack.yml` writes the bundled deployment workflow under `worker/teraphon-license-deploy.yml`, not the active `.github/workflows/teraphon-license-deploy.yml`. That active workflow must be updated separately if you choose to add Cron Triggers or change its generated Wrangler variables. Updating this package alone does not edit it.

## Quick checks

```text
https://teraphon-license.micovujovic-de.workers.dev/v1/health
```

Successful safe setup: `status=online`, `productConfigured=true`, `billingEnabled=false`.

Local Node.js 22+ checks:

```sh
node --check worker/teraphon-license.js
node --no-warnings worker/test-teraphon-worker.mjs
node --no-warnings worker/test-payment-hooks.mjs
```

The included tests simulate the Creem webhook and D1 logic; they are **not** real purchase validation or a deployed Android APK test.
