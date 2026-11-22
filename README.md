# TERAPHON-CF — Licencing, Creem & Resend

**TERAPHON-only** Cloudflare Worker (`teraphon-license`). No BrakeMonster changes.

- **Plans:** Monthly €3.50, Yearly €30, Lifetime €60; seven-day trial in Android app, without card.
- **One activation code / three Android devices** (not three separate licence keys).
- **Payments:** signed Creem webhook activates licence; protected installation token and AES-GCM encrypted activation code in the existing TERAPHON D1 database.
- **Email:** optional automatic Resend activation email; OFF until verified and explicitly enabled.
- **Repository Actions:** [Deploy TERAPHON Worker](https://github.com/micovujovicde-netizen/TERAPHON-CF/actions).

## Quick status

[Worker health](https://teraphon-license.micovujovic-de.workers.dev/v1/health). `status=online` is the server health. `productConfigured=true` means product IDs are configured; it **does not** prove payment/webhook. `billingEnabled=false` means checkout is off; `emailEnabled=false` means automatic email is off.

## Source & instructions

Read [`worker/README.md`](worker/README.md) for the six-file ZIP workflow, D1 binding, Cloudflare/Creem secrets, Resend setup, retries, manual deployment and testing. Do not upload secrets to GitHub.

The existing GitHub `unpack.yml` expects **exactly six files** inside `TERAPHON_LICENSE_GITHUB_DEPLOY.zip`. The root `README.md` is therefore supplied **separately** and must be uploaded/edited directly in GitHub. The ZIP contains the more detailed `worker/README.md`.

## Safety

Do not enable billing on the strength of a successful health check alone. Complete test-mode checkout, signed webhooks, activation and email tests first. Do not replace the production D1 database or regenerate the activation encryption secret.
