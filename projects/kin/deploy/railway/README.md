# Kin test server on Railway

Railway builds Kin from this repository and serves it over HTTPS on your own
subdomain. There's no server to look after: you connect the repo, set a few
variables, attach a volume and add one DNS record.

> This is a **test server**. Data on it is test data: v1.0 starts fresh
> ([V1.0-COMPATIBILITY](../../docs/V1.0-COMPATIBILITY.md)). The relay only
> ever holds encrypted data, but the
> [known limitations](../../docs/THREAT-MODEL.md#known-limitations-at-v10)
> still apply.

## How it works

Railway sends traffic to a public port in your container, but Kin only listens
on loopback. So this image runs two processes: a small Caddy on Railway's
`$PORT`, passing requests to Kin on `127.0.0.1:8000`. Railway's edge handles
HTTPS and the certificate. Railway overwrites `X-Real-IP` with each visitor's
address, and Caddy hands that to Kin, so the per-person limits (pairing-code
guesses, new households) see real addresses and ignore anything a client
writes itself.

```text
browser ──HTTPS──▶ Railway edge ──▶ $PORT caddy ──▶ 127.0.0.1:8000 kin ──▶ /data (volume)
```

## 1. Pick the address first

Passkeys are tied to the domain name, so decide the address testers will use
before anyone sets up: your own subdomain (for example `kin.yourdomain.com`) or
the free `something.up.railway.app` one. Changing it later means every tester
sets up again.

## 2. Create the service

1. In Railway: **New Project → Deploy from GitHub repo →**
   `mnichols08/ZTM-Build-Fest`.
2. Open the service's **Settings**:
   - **Source → Root Directory:** `projects/kin`
   - **Source → Branch:** `kin-development`
   - **Source → Watch Paths:** `/projects/kin/**` (so other projects in the
     repo don't redeploy Kin)
   - **Deploy → Healthcheck Path:** `/health`
   - **Deploy → Replicas:** `1`. Kin's database is one SQLite file and allows
     one server process.
   - Leave **serverless / app sleeping** off.
3. **Variables** (the Variables tab):

   | Variable | Value |
   | --- | --- |
   | `KIN_ORIGIN` | `https://kin.yourdomain.com` (the address from step 1, with `https://`, no trailing slash) |
   | `KIN_MAX_HOUSEHOLDS` | optional; defaults to `10` |
   | `KIN_ALLOW_NEW_HOUSEHOLDS` | optional; set to `false` once testers' households exist |

4. **Volume:** right-click the service (or use the command palette) →
   **Attach Volume**, mount path **`/data`**. This keeps households across
   deploys and restarts.

## 3. Connect your subdomain

1. Service **Settings → Networking → Custom Domain**, enter
   `kin.yourdomain.com`. Railway shows a **CNAME** target (and sometimes a TXT
   record to prove you own the domain).
2. In **Squarespace → Domains → your domain → DNS settings**, add the record(s)
   exactly as Railway shows them: type `CNAME`, host `kin`, data the Railway
   target. Remove any other record for the same host first (an old A record or
   forwarding).
3. Railway issues the certificate once DNS has updated, usually within minutes.

Using the free `*.up.railway.app` address instead? **Networking → Generate
Domain**, and set `KIN_ORIGIN` to that address.

## 4. Deploy and check

Railway deploys after the settings change (or press **Deploy**). The first
build takes several minutes because it compiles Kin's Rust engine. In the
deploy logs, wait for:

```text
{"event":"service_ready","origin":"https://kin.yourdomain.com"}
```

Then open your address. If the logs say `Set the KIN_ORIGIN variable…`, the
variable is missing. If the build can't find a Dockerfile, check that Root
Directory is exactly `projects/kin`: Railway uses `projects/kin/Dockerfile`
from there automatically. Remove any `RAILWAY_DOCKERFILE_PATH` variable left
from an earlier setup.

## Day to day

- **Updates:** every push to `kin-development` that touches `projects/kin`
  redeploys automatically. Testers see Kin's update prompt the next time they
  open it.
- **Close sign-ups:** set `KIN_ALLOW_NEW_HOUSEHOLDS=false`. Existing households
  keep working and can still invite people; anyone else sees "This Kin server
  isn't accepting new households."
- **Back up:** from the service's shell (Railway CLI `railway ssh`, or the
  dashboard), run
  `node /app/server/admin.mjs backup /data/backup-$(date +%F).sqlite`.
- **Start over:** delete and re-attach the volume. This removes every household.

## Cost

Kin is small: one container and a volume of a few megabytes. Railway's Hobby
plan covers it; check Railway's pricing page for current rates.
