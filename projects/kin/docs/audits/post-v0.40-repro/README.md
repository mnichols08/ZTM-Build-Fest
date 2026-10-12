# Post-v0.40 live verification reproductions

Standalone Node (>= 22.13) scripts for findings recorded in
[LIVE_HOUSEHOLD_VERIFICATION.md](../LIVE_HOUSEHOLD_VERIFICATION.md). Run each
from any directory with `node <file>`. They use synthetic identities and
in-memory services only. The `b` prefix marks release-blocking findings and `p`
marks polish findings, following the post-v0.38 convention.

| Script | Finding | State |
|---|---|---|
| `b001-lifecycle-route-500.mjs` | `GET /api/household/lifecycle` always answered 500. | Fixed in this PR; prints the corrected 200. |
| `b002-revoked-sender-rotation-strands-adult.mjs` | Revoking the device that committed the latest rotation discards undelivered key packages, and no remaining device can rotate past the epoch it never received. | Open; prints the stranded relay state. |
| `p001-rotation-omits-own-provisioned-epoch.mjs` | Rotation never records the new epoch for the rotating device, so other clients keep trying to provision it. | Open on the server; client no longer attempts Adult-only steps for non-Adults. |

The live multi-profile drill itself is `scripts/household-authority-regression.mjs`.
