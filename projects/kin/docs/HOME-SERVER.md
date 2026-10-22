# Kin at home: building, running and installing the home server

A household can run Kin on its own computer (a PC, a Mac, a Raspberry Pi or
a NAS) instead of the hosted service ([ADR 0025](decisions/0025-kin-at-home.md),
epic #708). This page is for the person who builds or runs that **home
server**. A plain guide for households comes with #740.

## What is built so far

| Part | State |
| --- | --- |
| `KIN_MODE=home` (§9) | Built (#713). |
| One executable for Linux x64 and arm64 (Raspberry Pi) (§10) | Built (#714): `scripts/build-sea.mjs`. |
| One executable for macOS arm64 and x64 | Built (#747): Kin's Mach-O injector and ad-hoc signature. Device check under #717. |
| One executable for Windows x64 | Built (#748): Kin's PE injector. Device check under #717. |
| Container image for NAS and server users | Built (#715): `deploy/home/Dockerfile`. |
| Running as a service: systemd, launchd, Windows | Built (#716). Windows uses the ADR's Task Scheduler fallback until the Rust service host (#749). |
| Device checks on each platform | #717. |
| Control panel and first-run setup page (§11) | #718. |
| Certificates (ACME, §5) and the tunnel to the connection relay (§2) | #723, #733. |
| Signed updates and scheduled backups (§10) | Later. |

Until the tunnel (#733) and the certificate client (#723) exist, a home
server is reachable only on its own computer, at `http://localhost:8000`.
Phones need an HTTPS name, so for now a technical household puts it behind
`tailscale serve` or its own TLS proxy, with `KIN_ORIGIN` set to that name
(README, "Running behind a TLS proxy"; ADR 0025, "Alternatives considered").

## Home mode

`KIN_MODE` is `hosted` (the default for `node server/start.mjs`, the
hosted service's behaviour) or `home`. The executable and the container
image run in home mode unless `KIN_MODE` says otherwise. Home mode changes
only this (`server/mode.mjs`):

- **One household.** `KIN_MAX_HOUSEHOLDS` defaults to 1, so creating a
  household closes once the owner's exists. Set `KIN_MAX_HOUSEHOLDS` to allow
  a few more (for grandparents' own household, say); the control panel will
  offer this (#718). `KIN_ALLOW_NEW_HOUSEHOLDS=false` still closes creation.
  Invitations into an existing household are never affected.
- **No Google Play settings.** `KIN_ANDROID_PACKAGE` and
  `KIN_ANDROID_CERT_SHA256` stop startup with an explanation: the Play app is
  bound to `kin.journeytocode.io` ([ADR 0020](decisions/0020-google-play-twa.md)).
- **System data folder.** Without `KIN_DATA_DIR`, data lives in the
  platform's system location instead of `.kin-data` in the app:

  | Platform | Data directory |
  | --- | --- |
  | Linux | `/var/lib/kin` |
  | macOS | `/Library/Application Support/Kin` |
  | Windows | `%ProgramData%\Kin` |
  | Container | `/data` (set by the image) |

Everything else is the same as hosted: the sandbox, the database, every
format, push, calendar sync. `KIN_FEEDBACK_GITHUB_*` still works and is off
unless set; reports stay on the home server for its admins.

## Building the executables

```sh
# from projects/kin, with Node 24.22.0 (the version the executables run on)
./build-wasm.sh                      # or: node scripts/fetch-wasm.mjs
node scripts/build-sea.mjs           # all five targets
node scripts/build-sea.mjs --target darwin-arm64,darwin-x64
node scripts/build-sea.mjs --target win-x64
node scripts/build-sea.mjs --target linux-x64 --measure
```

Every target builds on any machine: a Linux computer builds the Mac and
Windows executables, and the other way round. The script downloads the official node binary for each target from
nodejs.org, checks it against the release's `SHASUMS256.txt`, and caches it
in `target/sea/node/`. `--node-binary PATH` uses a binary you already have
(for one target), and `--node-version X.Y.Z` picks another release (the
build then needs that version of node on this machine to write the blob).
The results are in `target/sea/dist/`:

- `kin-<version>-linux-x64`, `kin-<version>-linux-arm64`,
  `kin-<version>-darwin-arm64`, `kin-<version>-darwin-x64` and
  `kin-<version>-win-x64.exe`, 95 to 135 MB each (node itself is most of
  it);
- `SHA256SUMS`, to check with `sha256sum -c SHA256SUMS`;
- `build-info.json`: the version, node release, the hash of every bundled
  file, and the hash of each node binary used;
- with `--measure`, `start-time.json`: the size, and the time from starting
  the executable for this machine to the service being ready, the first time
  (it unpacks its files) and after. On a development machine it was about
  330 ms and 300 ms.

Before writing each executable the script parses it back with the same
reader the injector uses and checks it (`checkExecutable`): the blob is
where Node looks for it and byte-identical, the fuse is flipped, and the
layout is one the system's loader accepts (below). On a Mac it also runs
`codesign --verify --strict` on the macOS executables.

The CI job `home-executables` builds all five targets on Linux for every
change, starts the Linux x64 one, runs the injector tests against the
official node binaries it downloaded, and keeps the results as the
`kin-home-executables` artifact. `home-executables-run` then takes the Mac
(arm64) and Windows executables to a Mac and a Windows runner: `codesign
--verify` must accept the macOS signatures, each executable must print its
version, start and answer `--health`, and the same target built natively
there must be byte-identical to the Linux build.

**Reproducible.** The same sources, engine and node binary give
byte-identical executables: files are bundled in sorted order, the blob has no
code cache or snapshot, and the injector is deterministic
(`scripts/build-sea.test.mjs` builds twice and compares).

**How it works.** The executable is a Node
[single executable application](https://nodejs.org/api/single-executable-applications.html).
`node --experimental-sea-config` writes a blob with `scripts/sea/main.cjs` as
its main script and the server, the web app, `package.json` and the WASM
engine as assets. Node usually adds the blob with the `postject` npm
package; Kin can't use npm packages, so `scripts/sea/elf.mjs` writes it into
a copy of the node binary itself, with the sentinel fuse flipped
(`scripts/sea/fuse.mjs`), in the form Node looks for on each system:

- **Linux** (`scripts/sea/elf.mjs`): a `NODE_SEA_BLOB` note in a new
  read-only segment, with the program header table moved to the end of the
  file.
- **macOS** (`scripts/sea/macho.mjs`): a section `__NODE_SEA_BLOB` in a new
  read-only segment `NODE_SEA` (the names Node's `src/node_sea_bin.cc`
  passes to `getsectdata`), placed where `__LINKEDIT` was; `__LINKEDIT`
  moves up and stays last, every load command that points into it is
  moved, and its chained fixups get an entry for the new segment, as dyld
  requires. Node's own signature (Developer ID) no longer matches, so it is
  cut off and replaced by an **ad-hoc signature** written by
  `scripts/sea/codesign.mjs`: a CodeDirectory of SHA-256 hashes of every
  4 KiB page, empty requirements, no certificate, the same as
  `codesign --sign -` writes. Apple silicon won't run a binary without one.
  Its page hashes are computed exactly as Apple's are (a test compares them
  with node's own signature), and no Mac or `codesign` is needed to build.
  A universal binary is reduced to the target's slice first; nodejs.org
  ships thin ones.
- **Windows** (`scripts/sea/pe.mjs`): an `RT_RCDATA` resource named
  `NODE_SEA_BLOB` (what `FindResource` looks up), in a new `.rsrc` section
  at the end holding every resource node.exe had (icons, version
  information, manifest) plus the blob. The old resource section stays,
  unused, as `.rsrc0`; no other section moves. node.exe's Authenticode
  certificate table is removed (the injection invalidates it), and
  `SizeOfImage`, the data directories and the checksum are rewritten.

When it runs, the executable writes its app files once to a cache folder
(`app-<bundle hash>` inside `KIN_APP_CACHE`; by default systemd's
`CACHE_DIRECTORY`, else `~/.cache/kin`, `~/Library/Caches/Kin` or
`%LOCALAPPDATA%\Kin`), checks every file's SHA-256 on each start and
rewrites any that changed. That folder is the service's read-only app
directory. The launcher then starts a second copy of the executable as the
service, with Node's permission flags in `NODE_OPTIONS` (an executable takes
no Node flags on its command line), so the service runs in the same sandbox
as `node server/start.mjs`: it reads the app, reads and writes only its data
directory, and can't start processes.

## Running it

```sh
chmod +x kin-1.6.0-linux-x64
KIN_DATA_DIR=~/kin-data ./kin-1.6.0-linux-x64
```

On a Mac, `KIN_DATA_DIR=~/kin-data ./kin-1.6.0-darwin-arm64` (or
`-darwin-x64` on an Intel Mac; the first time, see "Unsigned builds"
below). On Windows, in PowerShell:
`$env:KIN_DATA_DIR = "$HOME\kin-data"; .\kin-1.6.0-win-x64.exe`.

Open `http://localhost:8000`. Without `KIN_DATA_DIR` it uses the system
data folder (`/var/lib/kin` on Linux), which an ordinary account can't
write: install it as a service instead (below), or set `KIN_DATA_DIR`. The other settings are the
server's usual ones (README): `KIN_PORT`, `KIN_ORIGIN`,
`KIN_TRUSTED_PROXIES` and so on.

```text
kin --help                 every command
kin --version
kin --health               0 if the running service answers /health (as KIN_HOST/KIN_PORT)
kin admin backup PATH      the verified backup, as node server/admin.mjs backup
kin admin restore PATH --acknowledge-deletion-history
                           restore (stop Kin first; as node server/admin.mjs restore)
kin --print-service        print this computer's service definition
```

From a checkout, `node server/start.mjs` takes the same commands, and
`KIN_MODE=home node server/start.mjs` runs it in home mode.

## Installing it as a service

The service starts when the computer starts (no one needs to sign in),
restarts if it fails, and runs as an ordinary account, never as root or
Administrator. Install and uninstall need admin rights. **Uninstalling
removes the service and Kin's installed copy and keeps the data directory**;
delete that yourself only if you no longer need it. Use `--print-service`
to read what will be installed first.

### Linux (systemd)

```sh
sudo ./kin-1.6.0-linux-x64 --install-service
systemctl status kin
journalctl -u kin
sudo /usr/local/lib/kin/kin --uninstall-service
```

Installing creates a system account `kin`, copies the executable to
`/usr/local/lib/kin/kin` and writes `/etc/systemd/system/kin.service`:
`User=kin`, `StateDirectory=kin` (`/var/lib/kin`, mode 0700),
`CacheDirectory=kin` for the app files, `UMask=0077`,
`Restart=on-failure`, and hardening (`NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, no
capabilities; `MemoryDenyWriteExecute` stays off because V8 compiles code).
Change settings with `sudo systemctl edit kin` (for example
`Environment=KIN_PORT=8080`). Uninstalling keeps `/var/lib/kin` and the `kin`
account, so the files keep their owner.

### macOS (launchd)

```sh
sudo ./kin --install-service            # runs as the account that ran sudo
sudo ./kin --install-service --user kin # or as another account
sudo /usr/local/libexec/kin/kin --uninstall-service
```

Installing copies the executable to `/usr/local/libexec/kin/kin`, removes the
download's quarantine flag from that copy (launchd won't start a
quarantined unsigned program; you already chose to open it), creates
`/Library/Application Support/Kin`, `/Library/Caches/Kin` and
`/Library/Logs/Kin` owned by that account with mode 0700, and writes the
LaunchDaemon `/Library/LaunchDaemons/io.journeytocode.kin.plist` with
`UserName`, `RunAtLoad`, `KeepAlive` and `Umask` 077. Its log is
`/Library/Logs/Kin/kin.log`. The same commands work with
`node server/start.mjs` from a checkout.

### Windows (Task Scheduler, for now)

```powershell
# in a terminal opened with "Run as administrator"
.\kin.exe --install-service
.\kin.exe --uninstall-service
```

A program registered with `sc.exe` must answer the Service Control Manager,
which a console program can't. ADR 0025 plans a small Rust service host for
that (#749); until it exists Kin uses the ADR's fallback: a scheduled task
`\Kin` that starts at boot as the low-privilege **LOCAL SERVICE** account,
with no time limit, and the launcher restarting the service itself if it
fails (`--supervise`). Installing copies the executable to
`%ProgramFiles%\Kin\kin.exe`, creates `%ProgramData%\Kin` (data) and
`%ProgramData%\Kin-app` (app files) with access for LOCAL SERVICE, SYSTEM and
Administrators only, and registers and starts the task. Its log is
`%ProgramData%\Kin\logs\kin.log` (moved to `kin.log.1` past 10 MiB). Stopping
the task closes the pipe the service watches, so it closes its database
cleanly. From a checkout, `node server\start.mjs --install-service`
installs the same task for node.

## The container image

```sh
# from projects/kin
docker build -f deploy/home/Dockerfile -t kin-home .
docker run -d --name kin --restart unless-stopped -v kin-data:/data kin-home
docker inspect -f '{{.State.Health.Status}}' kin
docker exec kin /opt/kin/kin admin backup /data/backup.sqlite
```

The image holds the same executable as the downloads, built for the image's
architecture (x64 or arm64) from the official node in `node:24.22.0-slim`,
on `gcr.io/distroless/cc-debian12:nonroot`: glibc and the C++ runtime node
needs, and no shell or package manager. It runs as the unprivileged user
65532, in home mode, with its data in the `/data` volume and its app files
unpacked read-only at build time. Its health check runs `kin --health`.
For a bind mount instead of a volume, give the folder to that user first:
`sudo chown 65532:65532 /srv/kin-data`. The CI job `home-container` builds
the image and waits for it to report healthy.

Kin listens on loopback inside the container; nothing is published. That is
on purpose (home mode opens no public listener; the tunnel, #733, will dial
out). The hosted-style image with Caddy in front is still `deploy/`.

## Unsigned builds: what people will see

The owner decided (2026-10-22, #711) that the executables stay **unsigned**
for now: no Apple Developer ID and no Windows code-signing certificate.
They are checksummed instead: check a download against `SHA256SUMS` from the
same release before opening it (`sha256sum -c SHA256SUMS`, or
`Get-FileHash kin.exe` in PowerShell).

- **macOS Gatekeeper** says the app "can't be opened
  because Apple cannot check it for malicious software". Open it once from
  Finder with Control-click › **Open** › **Open**, or in **System Settings ›
  Privacy & Security** choose **Open Anyway**. From Terminal,
  `xattr -d com.apple.quarantine kin` removes the download flag.
  `--install-service` removes it from the installed copy. The executable
  carries an ad-hoc signature (Apple silicon needs one to run anything),
  which says nothing about who built it; `codesign -dv kin` shows
  `Signature=adhoc`.
- **Windows SmartScreen** says "Windows protected your PC". Choose
  **More info › Run anyway**. node.exe's own Authenticode signature is
  removed when Kin is added to it, so Windows shows the publisher as
  unknown. Some antivirus programs also warn
  about a new unsigned program; the checksum is how to tell it is Kin's.
- **Linux** has no such check; `chmod +x` is enough.

A household that can't get past these prompts should use the hosted service
or the container image for now.

## Updates

Decided (ADR 0025 §10; the owner's answer of 2026-10-22): patch and minor
releases install automatically at night after a backup, and major releases
wait for an admin. The signed updater isn't built yet; until it is, replace
the executable and restart the service (`sudo systemctl restart kin`).

## What still needs checking

The tests here ran on Linux x64 with Node 24.22.0. CI on Node 24.22.0 must
confirm the Linux build, the arm64 build (built, not run, in CI), the
container image (`home-container`) and `systemd-analyze verify` of the unit.
The macOS and Windows executables were built and checked on Linux only:
parsed back by Kin's readers and by `llvm-objdump` and `llvm-readobj`, the
ad-hoc signature's page hashes checked, but not run. `home-executables-run`
must confirm that a Mac accepts the signature (`codesign --verify`) and runs
the arm64 executable, and that Windows runs the x64 one; the Mac x64
executable runs in CI only on a runner with Rosetta.
#717 records install, reboot and uninstall on Windows, macOS, Linux and a
Raspberry Pi.
