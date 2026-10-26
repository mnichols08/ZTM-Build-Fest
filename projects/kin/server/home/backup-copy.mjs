// The copy of each backup to a second folder (ADR 0025 §10, #763): a USB
// drive or another disk the person chooses in the control panel.
//
// The launcher runs this, outside the sandbox. The sets are made by the
// service inside its data directory (backups.mjs, #721), which is all the
// service may write; the second folder is outside it. The launcher keeps
// that folder in step by looking again, never by being told which set is
// new, so a missed look does no harm. Three things make it look:
//
// - the service's `home_backup_created` line (in home mode the launcher
//   already reads the service's output, server/launcher.mjs);
// - the launcher starting;
// - a look every minute, which catches the set the updater makes before an
//   update (in the launcher, so no line is printed), a drive plugged in
//   later and a folder just chosen.
//
// Each look copies every finished set the folder lacks, newest first, to
//
//   <chosen folder>/Kin backups/<server name>/kin-<time>/
//
// in the same form as the set in `backups/`. `kin.sqlite` comes first, and
// is read back and checked against the original's size and SHA-256 and the
// manifest; then `home/`; `backup.json` last, so a folder without it is
// unfinished, as in `backups/`. Each file is flushed to the drive (removable
// drives hold writes back). Any failure removes that set's folder. The 14
// newest are kept there too, and only Kin's own folders are touched
// (pruneBackups): the person's own files, and another home server's folder
// on the same drive, stay.
//
// Kin never makes the chosen folder itself, and refuses one on the same
// disk as its data directory: a drive that isn't plugged in (or a Linux
// mount point with nothing mounted) is then reported, instead of filling
// this computer's own disk with copies that wouldn't survive it failing. A
// full drive is reported, never cleared to make room.
//
// How it went goes to `backups/copy-status.json`, which only the launcher
// writes and the control panel reads (backups.mjs). Kin's log gets codes
// and counts, never a path.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { writePrivateFile } from "../acme/keys.mjs";
import {
  BACKUP_COPY_FORMAT, BACKUP_COPY_STATUS, BACKUP_DATABASE, BACKUP_MANIFEST, BACKUP_RETRY_MS, HOME_FILES,
  backupsDirectory, listBackups, pruneBackups, readBackupCopyStatus,
} from "./backups.mjs";
import { homeSettingsPath, normalizeBackupCopyFolder, resolveHomeSettings } from "./settings.mjs";

export const COPIES_FOLDER = "Kin backups";
export const COPY_POLL_MS = 60_000;
/** How long after a failure of the copy itself (a full drive, a bad
 * read-back) Kin waits before trying again. */
export const COPY_RETRY_MS = BACKUP_RETRY_MS;
/** Room the drive must have beyond the set itself. */
const SPARE_BYTES = 1024 * 1024;
/** Problems with the folder rather than the copy: looked at every minute,
 * so a drive plugged in is copied to within one. */
const FOLDER_PROBLEMS = Object.freeze(["backup-copy-missing", "backup-copy-not-folder", "backup-copy-same-disk", "backup-copy-denied"]);

export class BackupCopyError extends Error {
  constructor(code) {
    super("Kin couldn't copy a backup to the second folder.");
    this.name = "BackupCopyError";
    this.code = code;
  }
}

// The launcher is stopping: the copy under way is removed and nothing is
// reported.
const STOPPED = new BackupCopyError("stopped");

/** Where this server's copies go in `folder`. */
export function copyFolderFor(folder, name, platform = process.platform) {
  return (platform === "win32" ? win32 : posix).join(folder, COPIES_FOLDER, name);
}

/** A failure as the code the control panel puts in plain words. */
export function copyErrorCode(error) {
  if (error instanceof BackupCopyError) return error.code;
  switch (error?.code) {
    case "ENOENT": return "backup-copy-missing";
    case "ENOTDIR": return "backup-copy-not-folder";
    case "EACCES": case "EPERM": case "EROFS": return "backup-copy-denied";
    case "ENOSPC": case "EDQUOT": return "backup-copy-full";
    // FAT32, common on USB sticks, holds no file over 4 GB.
    case "EFBIG": return "backup-copy-too-big";
    default: return "backup-copy-failed";
  }
}

/** For Kin's log only: the system's code, never a path. */
const systemCode = (error) => (typeof error?.code === "string" && /^E[A-Z0-9]{1,30}$/.test(error.code) ? error.code : null);

/** Copies `source` to a new file `destination` (0600) and flushes it to
 * the drive. Resolves with the source's { bytes, sha256 }. */
export async function copyFileFlushed(source, destination) {
  const hash = createHash("sha256");
  let bytes = 0;
  const target = await open(destination, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk);
      bytes += chunk.length;
      for (let offset = 0; offset < chunk.length;) offset += (await target.write(chunk, offset)).bytesWritten;
    }
    await target.sync();
  } finally {
    await target.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** A file's { bytes, sha256 }, read from the drive. */
async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

const blank = (folder) => ({ folder, checkedAt: null, lastCopyAt: null, lastCopiedCreatedAt: null, copies: 0, lastError: null });

/**
 * The launcher's copier for one home server. Test seams: `files` replaces
 * `stat`, `statfs` (free space) and `copyFile` (copyFileFlushed).
 */
export class BackupCopier {
  constructor({ dataDirectory, env = process.env, platform = process.platform, now = Date.now, log = () => {}, files = {}, pollMs = COPY_POLL_MS }) {
    Object.assign(this, { dataDirectory, env, platform, now, log, pollMs });
    this.files = { stat, statfs, copyFile: copyFileFlushed, ...files };
    this.source = backupsDirectory(dataDirectory);
    const previous = readBackupCopyStatus(dataDirectory);
    this.state = previous
      ? { state: previous.state, folder: previous.folder ?? null, checkedAt: previous.checkedAt ?? null, lastCopyAt: previous.lastCopyAt ?? null, lastCopiedCreatedAt: previous.lastCopiedCreatedAt ?? null, copies: previous.copies ?? 0, lastError: previous.lastError ?? null }
      : { state: "off", ...blank(null) };
    this.running = null;
    this.again = false;
    this.timer = null;
    this.stopped = false;
    // Settles once the last status written is on disk (see #write).
    this.written = Promise.resolve();
  }

  /** Looks once now, then every minute. */
  start() {
    if (this.timer || this.stopped) return;
    this.sync().catch(() => {});
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
  }

  /** Stops looking. A copy under way stops after the file it is on; the
   * launcher doesn't wait for it. */
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The service made a set. */
  backupMade() {
    if (!this.stopped) this.sync().catch(() => {});
  }

  /** The minute's look: copies when something may have changed. */
  async tick() {
    if (this.stopped || this.running || !this.due()) return null;
    return this.sync();
  }

  /** The folder and server name from the home settings, read as the
   * updater reads them; a file that doesn't read turns the copy off. */
  #settings() {
    let file = null;
    try { file = JSON.parse(readFileSync(homeSettingsPath(this.dataDirectory), "utf8")); } catch { file = null; }
    try {
      const settings = resolveHomeSettings(file, this.env);
      return { folder: settings.backupCopyFolder, name: settings.name };
    } catch {
      return { folder: null, name: null };
    }
  }

  /** True when a look should copy: the folder changed, a folder problem
   * (every minute), another failure an hour ago, or a newer set. */
  due(now = this.now()) {
    const { folder, name } = this.#settings();
    const last = this.state;
    if (!folder || !name) return last.state !== "off";
    if (last.folder !== folder) return true;
    if (last.state === "failed") return FOLDER_PROBLEMS.includes(last.lastError?.code) || !(now - Date.parse(last.lastError?.at) < COPY_RETRY_MS);
    const newest = listBackups(this.source)[0];
    return Boolean(newest) && (!last.lastCopiedCreatedAt || newest.createdAt > last.lastCopiedCreatedAt);
  }

  /** Copies what the folder lacks. One at a time: a call while one runs
   * makes it run once more after, for the set that may be new. Resolves
   * with { state, copied, removed } or { state, code }; never rejects. */
  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let result;
      do {
        this.again = false;
        result = await this.#sync();
      } while (this.again && !this.stopped);
      return result;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async #sync() {
    const { folder, name } = this.#settings();
    const at = new Date(this.now()).toISOString();
    if (!folder || !name) {
      if (this.state.state !== "off") this.#write({ state: "off", ...blank(null), checkedAt: at });
      return { state: "off" };
    }
    if (this.state.folder !== folder) this.state = { ...this.state, ...blank(folder) };
    try {
      const chosen = normalizeBackupCopyFolder(folder, this.platform);
      if (!chosen) throw new BackupCopyError("backup-copy-missing");
      await this.#check(chosen);
      const destination = copyFolderFor(chosen, name, this.platform);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const there = new Set(listBackups(destination).map((set) => set.id));
      const missing = listBackups(this.source).filter((set) => !there.has(set.id));
      if (missing.length) this.#write({ state: "copying", checkedAt: at });
      let copied = 0;
      for (const set of missing) if (await this.#copySet(set, destination)) copied += 1;
      const before = listBackups(destination).length;
      pruneBackups(destination, this.now());
      const kept = listBackups(destination);
      const done = new Date(this.now()).toISOString();
      this.#write({ state: "ok", checkedAt: done, lastCopyAt: copied ? done : this.state.lastCopyAt, lastCopiedCreatedAt: kept[0]?.createdAt ?? null, copies: kept.length, lastError: null });
      const removed = before - kept.length;
      if (copied || removed) this.log({ event: "home_backup_copied", copied, removed });
      return { state: "ok", copied, removed };
    } catch (error) {
      if (error === STOPPED) return { state: "stopped" };
      const code = copyErrorCode(error);
      // Logged when the problem is new, not every minute it lasts.
      if (this.state.state !== "failed" || this.state.lastError?.code !== code) {
        const reason = systemCode(error);
        this.log({ event: "home_backup_copy_failed", code, ...(reason ? { reason } : {}) });
      }
      this.#write({ state: "failed", checkedAt: at, lastError: { code, at } });
      return { state: "failed", code };
    }
  }

  /** Throws BackupCopyError (or the system's error) unless `folder` is a
   * folder on another disk than the data directory. */
  async #check(folder) {
    const info = await this.files.stat(folder);
    if (!info.isDirectory()) throw new BackupCopyError("backup-copy-not-folder");
    if ((await this.files.stat(this.dataDirectory)).dev === info.dev) throw new BackupCopyError("backup-copy-same-disk");
  }

  #stopping() {
    if (this.stopped) throw STOPPED;
  }

  /** Copies one set (see the top of this file). Resolves true, or false
   * when the service removed the set meanwhile (it keeps 14 too). */
  async #copySet(set, destination) {
    const from = join(this.source, set.id);
    const to = join(destination, set.id);
    try {
      this.#stopping();
      let home = [];
      try { home = (await readdir(join(from, "home"))).filter((name) => HOME_FILES.includes(name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      let needed = SPARE_BYTES;
      for (const path of [join(from, BACKUP_DATABASE), join(from, BACKUP_MANIFEST), ...home.map((name) => join(from, "home", name))]) needed += (await this.files.stat(path)).size;
      const disk = await this.files.statfs(destination);
      if (Number(disk.bavail) * Number(disk.bsize) < needed) throw new BackupCopyError("backup-copy-full");
      // A folder left without its manifest is unfinished: copied again.
      await rm(to, { recursive: true, force: true });
      await mkdir(to, { mode: 0o700 });
      const copied = await this.files.copyFile(join(from, BACKUP_DATABASE), join(to, BACKUP_DATABASE));
      const check = await hashFile(join(to, BACKUP_DATABASE));
      if (check.bytes !== copied.bytes || check.sha256 !== copied.sha256 || (set.databaseBytes !== null && copied.bytes !== set.databaseBytes))
        throw new BackupCopyError("backup-copy-failed");
      if (home.length) {
        this.#stopping();
        await mkdir(join(to, "home"), { mode: 0o700 });
        for (const name of home) {
          this.#stopping();
          await this.files.copyFile(join(from, "home", name), join(to, "home", name));
        }
      }
      this.#stopping();
      await this.files.copyFile(join(from, BACKUP_MANIFEST), join(to, BACKUP_MANIFEST));
      return true;
    } catch (error) {
      await rm(to, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      if (error !== STOPPED && !(await stat(join(from, BACKUP_MANIFEST)).then(() => true, () => false))) return false;
      throw error;
    }
  }

  // One write at a time, in order, so an older status never lands over a
  // newer one (the updater's pattern). A failed write leaves the panel the
  // last status it could read.
  #write(changes) {
    this.state = { ...this.state, ...changes };
    const text = `${JSON.stringify({ format: BACKUP_COPY_FORMAT, ...this.state })}\n`;
    this.written = this.written.then(async () => {
      await mkdir(this.source, { recursive: true, mode: 0o700 });
      await writePrivateFile(join(this.source, BACKUP_COPY_STATUS), text);
    }).catch(() => {});
  }
}

/** The copier runService starts in home mode (server/launcher.mjs). */
export function homeBackupCopier({ databasePath, env, log }) {
  return new BackupCopier({ dataDirectory: dirname(databasePath), env, log });
}
