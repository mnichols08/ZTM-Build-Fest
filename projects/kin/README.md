# Kin

> A private, lightweight household coordination app for the little things families need to know, remember, hand off, or discuss.

**Current implementation line: `v1.6.0` — Kin for Everyone.** Released as `kin-v1.6.0` on 2026-10-21, this minor release makes Kin easier for someone who rarely uses apps: easy mode with bigger text and buttons and fewer things on screen, Help on every screen, household features an admin can switch off for everyone, reporting a problem or suggesting a feature from inside Kin, and setting Kin up for someone else with a printed "How to open Kin" sheet. It also prepares Kin for Google Play with an Android app, a public privacy policy and a release runbook. It builds on v1.5.0 (one account and private spaces) and adds server schemas 25–27 as forward migrations; see the [changelog](CHANGELOG.md) for the compatibility notes. Kin keeps household history in a local-first, encrypted event store on each device, and syncs it between a household's devices through a relay that only ever holds encrypted data.

The [v0.10 release record](docs/V0.10.0.md) describes local recovery, migration, compatibility, measurements and validation. Exports are encrypted history recovery and do not restore server membership, device trust, credentials, or sync authority. The v0.12 line adds household deletion with a 30-day cancellation period and permanent anti-resurrection tombstones; it cannot erase offline or exported copies. If every legitimate credential, trusted device, key copy, and archive secret is lost, Kin deliberately reports the encrypted history as unrecoverable rather than granting stale authority.

Kin's workspace has five destinations: Today, Lists (To do · Shopping · Staples), Routines, Updates (Handoffs · Talk) and Household, with a persistent desktop navigation, a shared item detail view, Quick add, keyboard shortcuts and a command palette, and bulk actions with undo. See [docs/WORKSPACE-UX.md](docs/WORKSPACE-UX.md).

v1.0 freezes Kin's storage, sync, export and server formats: every v1.x release keeps reading them ([v1.0 compatibility commitment](docs/V1.0-COMPATIBILITY.md)). v1.0 makes no compatibility promise for data created before it: start fresh. What v1.0 does not protect against is listed under [known limitations](docs/THREAT-MODEL.md#known-limitations-at-v10).

## The problem

Household information gets scattered across memory, messages, calendars, sticky notes, verbal conversations, and assumptions. That makes small handoffs easy to miss and everyday coordination harder than it needs to be. The gaps can lead to "I thought you knew," "Why didn't you tell me?", "I thought you were doing that," or conversations happening at the wrong time.

Kin aims to make useful household context easier to share and find. It is not a promise to prevent conflict or fix relationships, and it will not decide who is right or measure anyone's contribution.

## Intended direction

Kin is intended as a private, lightweight shared household operating layer. Today, Needs, and Shopping views, lightweight classification, capture, completion, reopening, and archival are implemented locally. Shopping items use existing canonical Item events and the encrypted sync envelope, so saved changes remain local while offline and synchronize through the existing household flow when connected. Handoff capture, acknowledgement, and recent context are implemented locally. Talk captures short topics for later, with Open/Resolved lists, resolve, reopen, and archive. Resolved is workflow state only, not agreement or an objective solution. Pulse adds fixed current capacity, set/replace/clear and explicit expiry, introduced in Rust protocol v5. Since You Last Looked shows at most eight recent meaningful household changes with an omitted-change count; Pulse is excluded. The user explicitly marks the displayed snapshot caught up. Values are context only, never scores or diagnoses. Routines support daily, Monday-start weekly, creation-anchored every-two-weeks, and calendar-month coordination without reminders, streaks, assignments or calendar UI.

The intended technical direction is Rust compiled to WebAssembly, native Web Components, vanilla JavaScript, and browser APIs, with a local-first start and no external framework unless a demonstrated requirement justifies one. Notes use canonical Rust events, local replay, plain-text rendering, and the existing encrypted sync envelope.

Search runs against the unlocked local projection, excludes archived records,
and retains the query and filters only in memory until the component tree is
cleared on lock. It shows at most 100 results at once and adds no event,
protocol, or persistent index.

## Status and what's next

October 2026 took Kin from the v0.11 durable service through more than thirty capability lines to v1.0. The [roadmap](docs/ROADMAP.md) records that path; the [planned release contracts](docs/releases/) describe each line.

Post-v1.0 work is tracked as GitHub issues, not dated versions. v1.1 completed
device names (#71), household home-screen identity (#78), push notifications
(#85), QR pairing/phone sign-in (#93), and service sandboxing (#106). Remaining
planned work includes:

- Household chat (#104)

AI runtime features, gamification, surveillance, and enterprise workflows stay out of scope.

## Release history

- `v1.6.0` — Kin for Everyone: easy mode, Help on every screen, household
  features, report a problem and suggest a feature, setting Kin up for
  someone else, and the Android app for Google Play. Released 2026-10-21
  (`kin-v1.6.0`).
- `v1.5.0` — One Account and Private Spaces: accounts with a username and
  password, passkey and backup code, new-device sign-in, a private journal,
  Just for me, and reminders and settings that follow each member. Released
  2026-10-21 (`kin-v1.5.0`).
- `v1.4.0` — Fridge, Meals and Household Helpers: the family fridge, Meals,
  Simple view, Talk later, undo and redo, share into Kin, shopping mode and
  store sections, list import, This week, the sitter page and taking turns on
  routines. Released 2026-10-20 (`kin-v1.4.0`).
- `v1.3.0` — Member Names and Clearer Setup: members' own preferred names and
  friendly device labels, explicit invite-a-person versus add-my-device paths,
  and first-use and feedback improvements. Released 2026-10-19 (`kin-v1.3.0`).
- `v1.2.0` — Household Chat: one household chat room with receipts, typing,
  "online now", replies, reactions, polls, voice messages, and encrypted content
  blobs. Released 2026-10-19 (`kin-v1.2.0`).
- `v1.1.2` — Private Household Branding: private household name/icon in the
  unlocked shell with correct refresh and clearing across session transitions.
  Released 2026-10-18 (`kin-v1.1.2`).
- `v1.1.1` — Member and Notification Clarity: clearer member/device grouping,
  pairing choices, device trust, and push-recipient diagnostics. Released
  2026-10-18 (`kin-v1.1.1`).
- `v1.1.0` — Connected Household Devices: device names, installed-app identity,
  opt-in push, a sandboxed service, and QR pairing/phone sign-in. Released
  2026-10-18 (`kin-v1.1.0`).
- `v1.0.0` — Stable Kin Platform: everything below since v0.10.3, plus the v1.0 readiness work. Released 2026-10-17 (`kin-v1.0.0`).
- `v0.21.0`–`v0.47.0` — Household modes, planning dates, calendar export, history, search, pins, playbooks, reminders, offline install, reference and maintenance records, encrypted attachments, responsibility, more adults, Limited and Temporary members, portable export and restore, mobile experience, personal and household appearance, household admins. These were development candidates and were never tagged; they ship in v1.0.0.
- `v0.11.0`–`v0.20.1` — Durable service, household deletion, recovery and continuity, UX/UI consolidation, Areas, Notes, checklist steps, routine scheduling, shopping lists and staples. Tagged review lines (`kin-v0.11.0`–`kin-v0.20.1`, some versions untagged); not published on their own.
- `v0.1.0`–`v0.10.3` — From the first implementation (Household Heartbeat) through encrypted sync and local data security. `v0.10.3` (`kin-v0.10.3`) was the last release before v1.0.
- `v0.0.1`–`v0.0.12` — Planning and documentation releases.

The [changelog](CHANGELOG.md) has every version, newest first, and marks the ones that were never tagged.

## Install, build, and run

Requirements: Rust/Cargo with the `wasm32-unknown-unknown` target, Node.js 24.16.0 or later, npm, and a modern browser with WebAssembly, Web Crypto, Web Locks, ES modules, Custom Elements and IndexedDB. Passkeys are needed for server identity/pairing. Where the passkey supports the PRF extension, it becomes the everyday unlock on that device, online and offline; a password (for an account) or the user-held recovery key remains the backup unlock. Use HTTPS outside localhost.

From the repository root in PowerShell:

```powershell
npm ci --prefix projects/kin
rustup target add wasm32-unknown-unknown
./projects/kin/run.ps1
```

The script builds the WASM module and serves the web app at `http://localhost:8000`, inside Node's permission model (the service can read the app and write only its data directory; see [DEVELOPMENT](docs/DEVELOPMENT.md#the-service-sandbox)). On Windows, if PATH selects Node.js older than 24.16.0, `run.ps1` uses the lowest compatible version already installed with fnm; it does not install Node.js. On macOS/Linux, run `sh projects/kin/run.sh` from the repository root with Node.js 24.16.0 or later on PATH.

The service database defaults to `projects/kin/.kin-data/kin.sqlite`; set
`KIN_DATA_DIR` or `KIN_DATABASE_PATH` to choose another location. Keep the data
directory outside `web/`, restrict access to the service account, and back it
up separately. Kin uses SQLite through Node's built-in `node:sqlite` API and
has no npm runtime dependencies. Node.js 24.16.0 or later is required: it is
the first Node 24 release whose `node:sqlite` returns TEXT values with embedded
NUL characters intact. CI runs Node 24.22.0 on Windows and Linux; other
platform/runtime combinations are not yet certified.

### Test server with Docker

To let testers use Kin from their own devices and networks, [deploy/](deploy/README.md)
runs Kin behind Caddy (automatic HTTPS) with Docker Compose on any Linux server:
set your subdomain in `deploy/.env`, then `docker compose up -d --build`.
[deploy/railway/](deploy/railway/README.md) runs the same on Railway.

### Running behind a TLS proxy

Kin listens on loopback only (`KIN_HOST`, default `127.0.0.1`), so a hosted
deployment puts a TLS proxy in front of it and sets `KIN_ORIGIN` to the public
`https://` origin. Every request then arrives from the proxy's address. Kin
limits pairing-code guesses per client, so without more configuration all
clients share one limit, and a stranger's bad guesses can briefly block a
family's valid pairing code.

Set `KIN_TRUSTED_PROXIES` to the proxy's address as Kin sees it (a
comma-separated list of IP addresses, for example `127.0.0.1,::1`) and have
the proxy set `X-Forwarded-For` to the client address it received. Kin then
uses the right-most `X-Forwarded-For` address that is not itself a trusted
proxy. It ignores the header entirely when the setting is empty (the default)
or when the request comes from any other address, so clients cannot spoof it.
For nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

```sh
KIN_ORIGIN=https://kin.example.org KIN_TRUSTED_PROXIES=127.0.0.1,::1 node server/start.mjs
```

The proxy must **replace** `X-Forwarded-For` with the address it saw, as above;
a proxy that passes the client's own header through lets clients choose their
limit key. IPv4 clients are limited per address and IPv6 clients per /64
network. Only failed code attempts count toward a client's limit, so a
household's own successful pairing never uses it up. An invalid
`KIN_TRUSTED_PROXIES` value stops startup with an explanation.

### Linking a Google Play app

If Kin is also published as an Android app from Google Play (a Trusted Web
Activity, epic #527), Android checks `/.well-known/assetlinks.json` to confirm
the app and this site belong together; without it the app shows a browser
address bar. Set `KIN_ANDROID_PACKAGE` to the app's package name and
`KIN_ANDROID_CERT_SHA256` to its signing certificate's SHA-256 fingerprint
(`AA:BB:…`, comma-separated if there are several, such as the Play App Signing
key and an upload key). With neither set the file answers 404; setting only
one, or a malformed value, stops startup with an explanation.

The Android app itself is in `android/` ([ADR 0020](docs/decisions/0020-google-play-twa.md)):
it opens `https://kin.journeytocode.io` and is built with Gradle, Google's
`androidbrowserhelper` library being the one documented dependency exception,
kept out of Kin's web runtime. [ANDROID](docs/ANDROID.md) covers building,
versioning, signing (Play App Signing with an upload key), the asset-links
setup and the phone checklist.

### Limiting new households

Creating a household needs no account, so Kin limits it the same way: each
client (per the proxy setting above) can create at most 3 households an hour.
That limit is fixed; behind a proxy without `KIN_TRUSTED_PROXIES`, every client
shares it. It is kept in memory, so a restart resets it.
Two settings let an operator go further. Both default to the earlier
behaviour, and neither affects households that already exist:

- `KIN_ALLOW_NEW_HOUSEHOLDS=false` refuses every new household, for example
  once your family's household is set up.
- `KIN_MAX_HOUSEHOLDS=<n>` refuses a new household once `n` exist. Deleted
  households don't count; a household waiting out its deletion grace period
  still does.

A refused attempt shows "This Kin server isn't accepting new households.",
usually before any passkey prompt (the check runs again when the household is
created, so a cap reached in between refuses after it). An invalid value for either setting stops startup
with an explanation.

```sh
KIN_ORIGIN=https://kin.example.org KIN_TRUSTED_PROXIES=127.0.0.1,::1 KIN_ALLOW_NEW_HOUSEHOLDS=false node server/start.mjs
```

### Reports and suggestions from the app

People can report a problem from inside Kin (anyone, also from the lock
screen without signing in), and household admins can suggest a feature
([ADR 0021](docs/decisions/0021-kin-for-everyone.md) §3). Nothing is sent
until the person presses Send on a preview that shows every detail (each
removable) and where it goes. Reports arrive on this service, in server
schema 26's `feedback` and `feedback_screenshots` tables: the typed text and
the diagnostics the person kept (a version, browser, screen size, route
name, sync state, recent error codes; never household text, names,
usernames or IDs), plus a cropped picture of Kin's screen of at most 1 MiB
only if they chose one. A signed-in report is linked to its member, so they
can follow its status in What I've sent; one from the lock screen is linked
to nobody. Limits: 5 reports and 3 suggestions per member per hour, 20 per
address per day; without signing in 2 per address per hour and 5 per day.
Everything is purged after 180 days, with the member on removal and with
the household on its deletion.

Read them with the admin command, which is safe while the service runs:

```text
node server/admin.mjs feedback-list [--kind problem|suggestion] [--status received|planned|done|wont-do] [--limit n]
node server/admin.mjs feedback-show <reference> [--screenshot <new-file>]
node server/admin.mjs feedback-set-status <reference> received|planned|done|wont-do
node server/admin.mjs feedback-forward <reference>
node server/admin.mjs feedback-purge [<reference> --confirm-reference <reference>]
```

The status you set shows in the sender's What I've sent. `feedback-purge`
without a reference removes everything past 180 days now.

**Forwarding to GitHub issues** is optional. Set both
`KIN_FEEDBACK_GITHUB_REPO=owner/name` and `KIN_FEEDBACK_GITHUB_TOKEN` (a
fine-grained token for that one repository with Issues read and write only),
or neither; one without the other stops startup. `KIN_FEEDBACK_GITHUB_API`
may name a GitHub Enterprise API over https. Each report then becomes an
issue with its title, typed text, diagnostics and reference, labelled
`from-app` and `bug` or `enhancement`; never household or member IDs,
usernames or the picture, which stays on the service. **Use a private
repository**: the typed text is whatever the person wrote, and in a public
repository anyone can read it. The service asks GitHub whether the
repository is private and the preview says so ("anyone on the internet can
read" when public or unknown). Forwarding runs in the background, retries
with backoff (1 minute doubling to 6 hours, giving up after 8 attempts or a
refusal such as a bad token; `feedback-forward` tries again) and is
idempotent by reference: after a lost answer it looks for the issue before
opening another. Every 15 minutes the status follows the issue: closed as
completed is Done, closed as not planned is Won't do, open with the label
`planned` is Planned. A status set with the command holds until the issue
changes. The token goes only to that API and is never logged.

The service persists household identity, authorization metadata, opaque relay
events and synchronization state. Sessions and in-flight WebAuthn/pairing
ceremonies expire on restart, so members sign in again with a trusted device
and passkey. A successful event response means its SQLite transaction committed;
it does not mean a recipient received/read it or that a backup exists.

Create an online, integrity-checked database backup with
`npm run backup -- <destination>` from `projects/kin/`. Restore only while the
service is stopped using `npm run restore -- <backup-file>`; restore validates
the backup and preserves the replaced database and WAL sidecars with a
`.pre-restore-...` suffix. A stale service lock after a crash is not removed
automatically: verify the process is stopped before deleting
`<database-path>.service.lock`. Backups and preserved database copies contain
sensitive identity/routing metadata and encrypted envelopes; stale restores can
roll back revocations or key epochs. See [V0.11.0](docs/V0.11.0.md) for the
full operational and privacy boundaries.

First setup generates a recovery secret that must be confirmed and stored separately. Losing all unlock paths loses access; losing the browser profile also requires an encrypted backup. Drafts are memory-only and disappear on lock/reload. A refresh of the same tab keeps Kin unlocked (a device setting; [ADR 0010](docs/decisions/0010-reload-resume.md)); closing the tab, Lock and automatic lock still lock it. Encrypted archives restore exact history into an empty installation for local use; they do not recreate server identity or device trust. The static application shell supports offline recovery unlock after its first successful cache installation.

Sync is off until an authenticated adult enables it. The v0.11 implementation candidate persists identity, relay ciphertext, cursors and provisioning state in SQLite; sessions, incomplete pairing and passkey flows remain process-local and expire on restart. Device-token verifiers persist, but raw tokens and private keys do not. A new/replacement adult cannot receive pre-join epochs. Existing adults can pair another device after comparing fingerprints. Encryption does not protect a compromised unlocked runtime, origin, privileged extension or OS. This prototype has not received an independent security audit.

## Privacy policy

Kin's public, plain-language privacy policy is [`web/privacy.html`](web/privacy.html),
served at `/privacy.html` (for the hosted service,
<https://kin.journeytocode.io/privacy.html>) and linked from Household ›
Privacy & recovery. It is the policy URL for the Google Play listing; keep it
accurate to [PRIVACY](docs/PRIVACY.md), the [threat model](docs/THREAT-MODEL.md)
and [RETENTION](docs/RETENTION.md). A self-hosted server serves the same page,
which names the hosted service: an operator should publish their own.
The Play listing and Data safety answers are in
[PLAY-LISTING](docs/PLAY-LISTING.md); releasing to Play is in
[PLAY-RELEASE](docs/PLAY-RELEASE.md).

## AI usage

AI-assisted development tools are used for brainstorming, product planning, architecture exploration, documentation, implementation support, debugging, and testing. Kin has no AI runtime or analytics, and household data is not sent to an AI service. When sync is explicitly enabled, the service receives encrypted event envelopes and limited routing metadata, never plaintext household semantics or content keys.

## License

Kin is available under the [MIT License](LICENSE).

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [GitHub community files and monorepo limitations](docs/GITHUB-COMMUNITY.md)

Kin is nested in the ZTM Build Fest repository. Its community files and templates are kept inside `projects/kin/`; GitHub does not automatically apply nested `.github` templates or count them in the parent repository's Community Standards profile.

## Project documents

- [Routines release contract and test matrix](docs/V0.7.0.md)

- [Changelog](CHANGELOG.md)
- [Product vision](docs/PRODUCT.md)
- [Principles and non-goals](docs/PRINCIPLES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Conceptual data model](docs/DATA-MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Household domain](docs/DOMAIN.md)
- [Event contract](docs/EVENTS.md)
- [Derived state and replay](docs/STATE.md)
- [Entity lifecycles](docs/LIFECYCLES.md)
- [Identity and trusted devices](docs/IDENTITY.md)
- [Pairing](docs/PAIRING.md)
- [Synchronization design](docs/SYNC.md)
- [Cryptographic posture](docs/CRYPTOGRAPHY.md)
- [Threat model](docs/THREAT-MODEL.md)
- [v0.8.0 Household Pairing contract](docs/V0.8.0.md)
- [v0.9.0 Encrypted Event Sync contract](docs/V0.9.0.md)
- [Implementation layout and responsibilities](docs/IMPLEMENTATION.md)
- [JavaScript/WASM ABI](docs/ABI.md)
- [IndexedDB storage contract](docs/STORAGE.md)
- [Web Component contract](docs/COMPONENTS.md)
- [Testing contract](docs/TESTING.md)
- [Accessibility contract](docs/ACCESSIBILITY.md)
- [v1.0 compatibility and upgrade commitment](docs/V1.0-COMPATIBILITY.md)
- [Persistent contract versioning](docs/VERSIONING.md)
- [Migration safety](docs/MIGRATIONS.md)
- [Portable household data](docs/PORTABILITY.md)
- [Retention and deletion](docs/RETENTION.md)
- [Development workflow](docs/DEVELOPMENT.md)
- [Code style](docs/CODE-STYLE.md)
- [Release process](docs/RELEASES.md)
- [Android app for Google Play](docs/ANDROID.md) and [its decision record](docs/decisions/0020-google-play-twa.md)
- [Google Play listing and Data safety](docs/PLAY-LISTING.md) and [releasing on Google Play](docs/PLAY-RELEASE.md)
- [Debugging and diagnostics](docs/DEBUGGING.md)
- [Implementation preflight](docs/PREFLIGHT.md)
- [Requirement traceability](docs/TRACEABILITY.md)
- [v1.0 release acceptance matrix](docs/audits/V1.0_RELEASE_ACCEPTANCE.md), [reality check](docs/audits/V1.0_REALITY_CHECK.md), [tester guide](docs/audits/V1.0_TESTER_GUIDE.md) and [review-gate decisions](docs/audits/V1.0_REVIEW_GATES.md)
- [v0.47 release acceptance matrix](docs/audits/V0.47_RELEASE_ACCEPTANCE.md) (superseded by the v1.0 matrix)
- [Canonical test vectors](docs/TEST-VECTORS.md)
- [Since You Last Looked release contract](docs/V0.6.0.md)
- [Accepted architecture decision: event-sourced household state](docs/decisions/0001-event-sourced-household-state.md)
- [UX flows](docs/UX.md)
- [Roadmap](docs/ROADMAP.md)
- [Build Fest daily cadence](docs/BUILD-FEST-CADENCE.md)
- [Platform foundation and early October sequence through v0.16](docs/BRIDGE-0.11-0.16.md)
- [Product boundaries for the October plan](docs/PRODUCT-BOUNDARIES.md)
- [Minor-release stabilization protocol](docs/RELEASE-LINE-PROTOCOL.md)
- [v0.11 Durable Service & Deployment implementation candidate](docs/V0.11.0.md)
- [v0.12 Data Lifecycle, Retention & Deletion implementation candidate](docs/V0.12.0.md)
- [Planned v0.13 Recovery & Household Continuity contract](docs/V0.13.0.md)
- [v0.14 UX/UI Consolidation contract](docs/V0.14.0.md)
- [Planned v0.15 Household Areas contract](docs/releases/V0.15.0.md)
- [v0.16 Household Notes & Reference Context contract](docs/releases/V0.16.0.md)
- [Planned release contracts: October through v0.40 and undated v0.41–v0.45 follow-up](docs/releases/)
- [v0.1.0 implementation specification](docs/V0.1.0.md)
- [Handoff release contract and final validation](docs/V0.3.0.md)

- [Talk release contract and validation](docs/V0.4.0.md)
