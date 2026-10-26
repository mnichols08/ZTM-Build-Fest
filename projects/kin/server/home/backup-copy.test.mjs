// The copy of each backup to a second folder (ADR 0025 §10, #763): what is
// copied and in what order, keeping 14, the folders Kin refuses, failures
// that leave nothing behind, and one copy at a time. Another disk and a full
// drive are stand-ins (the `files` seam), never real drives.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { BackupCopier, COPIES_FOLDER, copyFileFlushed, copyFolderFor } from "./backup-copy.mjs";
import { BACKUPS_KEPT, BACKUP_COPY_ERROR_CODES, BACKUP_COPY_STATUS, BACKUP_MANIFEST, backupsDirectory, listBackups, makeBackupSet } from "./backups.mjs";
import { HOME_KEY_FILE } from "./home-key.mjs";

const NAME = "fern.home.kin.journeytocode.io";
const HOUR = 60 * 60_000;

/**
 * A data directory with a home folder and settings naming `folder` (by
 * default an empty folder beside it, `chosen`), and a clock. `makeSet()`
 * makes a backup set with a small stand-in database.
 */
function fixture(t, { folder, name = NAME } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kin-backup-copy-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dataDirectory = join(root, "data");
  const chosen = join(root, "usb");
  mkdirSync(join(dataDirectory, "home"), { recursive: true });
  mkdirSync(chosen);
  writeFileSync(join(dataDirectory, "home", HOME_KEY_FILE), "synthetic home key\n");
  const settings = (value) => writeFileSync(join(dataDirectory, "home", "settings.json"), `${JSON.stringify({ format: 1, ...(name ? { name } : {}), ...(value ? { backupCopyFolder: value } : {}) })}\n`);
  settings(folder === undefined ? chosen : folder);
  let time = Date.parse("2026-10-25T03:00:00Z");
  const clock = { now: () => time, advance: (ms) => { time += ms; } };
  let made = 0;
  const makeSet = async () => {
    made += 1;
    const set = await makeBackupSet({
      dataDirectory, version: "1.6.0", reason: "scheduled", now: clock.now,
      copyDatabase: async (destination) => { writeFileSync(destination, `synthetic database ${made}\n`.repeat(100)); return destination; },
    });
    clock.advance(24 * HOUR);
    return set;
  };
  return { root, dataDirectory, chosen, copies: join(chosen, COPIES_FOLDER, name ?? "none"), clock, makeSet, settings };
}

/** A `stat` that puts everything under `root` on another disk. */
const otherDisk = (root) => async (path) => {
  const info = await stat(path);
  if (!path.startsWith(root)) return info;
  return { ...info, dev: info.dev + 1, isDirectory: () => info.isDirectory() };
};

function copier(context, { files = {}, events = [] } = {}) {
  return new BackupCopier({ dataDirectory: context.dataDirectory, env: {}, now: context.clock.now, log: (event) => events.push(event), files: { stat: otherDisk(context.chosen), ...files } });
}

async function writtenStatus(instance, context) {
  await instance.written;
  return JSON.parse(readFileSync(join(backupsDirectory(context.dataDirectory), BACKUP_COPY_STATUS), "utf8"));
}

const systemError = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

test("each finished set is copied into Kin backups/<name>/, newest first, verified, with backup.json last", async (t) => {
  const context = fixture(t);
  const older = await context.makeSet();
  const newer = await context.makeSet();
  const order = [];
  const events = [];
  const instance = copier(context, { events, files: { copyFile: async (source, destination) => { order.push(source); return copyFileFlushed(source, destination); } } });
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 2, removed: 0 });
  assert.equal(context.copies, copyFolderFor(context.chosen, NAME));
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), [newer.id, older.id]);
  for (const set of [older, newer]) {
    const from = join(backupsDirectory(context.dataDirectory), set.id);
    const to = join(context.copies, set.id);
    assert.deepEqual(readFileSync(join(to, "kin.sqlite")), readFileSync(join(from, "kin.sqlite")));
    assert.deepEqual(readdirSync(join(to, "home")).sort(), [HOME_KEY_FILE, "settings.json"]);
    assert.equal(readFileSync(join(to, BACKUP_MANIFEST), "utf8"), readFileSync(join(from, BACKUP_MANIFEST), "utf8"));
  }
  // Newest first; in each set the database first and the manifest last.
  assert.ok(order[0].includes(newer.id));
  for (const id of [newer.id, older.id]) {
    const files = order.filter((source) => source.includes(id)).map((source) => basename(source));
    assert.deepEqual(files, ["kin.sqlite", HOME_KEY_FILE, "settings.json", BACKUP_MANIFEST]);
  }
  const status = await writtenStatus(instance, context);
  assert.equal(status.format, 1);
  assert.equal(status.state, "ok");
  assert.equal(status.folder, context.chosen);
  assert.equal(status.copies, 2);
  assert.equal(status.lastCopiedCreatedAt, newer.createdAt);
  assert.equal(status.lastError, null);
  assert.deepEqual(events, [{ event: "home_backup_copied", copied: 2, removed: 0 }], "counts, never a path");
  // Nothing new: the next minute's look doesn't copy.
  assert.equal(instance.due(), false);
  await context.makeSet();
  assert.equal(instance.due(), true, "a newer set is due");
});

test("the 14 newest are kept; only Kin's own folders are touched", async (t) => {
  const context = fixture(t);
  writeFileSync(join(context.chosen, "holiday-photos.txt"), "the person's own file\n");
  const other = join(context.chosen, COPIES_FOLDER, "other.home.kin.journeytocode.io", "kin-20200101T000000Z");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, BACKUP_MANIFEST), JSON.stringify({ format: 1, createdAt: "2020-01-01T00:00:00.000Z" }));
  mkdirSync(join(context.copies, "kin-notaset"), { recursive: true });
  writeFileSync(join(context.copies, "my-notes.txt"), "notes\n");
  const made = [];
  for (let n = 0; n < BACKUPS_KEPT; n += 1) made.push((await context.makeSet()).id);
  const instance = copier(context);
  assert.equal((await instance.sync()).copied, BACKUPS_KEPT);
  for (let n = 0; n < 2; n += 1) made.push((await context.makeSet()).id);
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 2, removed: 2 });
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), made.slice(2).reverse(), "the two oldest went");
  assert.ok(existsSync(join(context.chosen, "holiday-photos.txt")));
  assert.ok(existsSync(join(other, BACKUP_MANIFEST)), "another home server's copies on the same drive stay");
  assert.ok(existsSync(join(context.copies, "kin-notaset")));
  assert.ok(existsSync(join(context.copies, "my-notes.txt")));
  assert.equal((await writtenStatus(instance, context)).copies, BACKUPS_KEPT);
});

test("a missing folder is reported and never made; once it exists the next minute's look copies", async (t) => {
  const context = fixture(t);
  const missing = join(context.root, "unplugged");
  context.settings(missing);
  await context.makeSet();
  const events = [];
  const instance = copier(context, { events, files: { stat: otherDisk(missing) } });
  assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-missing" });
  assert.ok(!existsSync(missing), "Kin never makes the chosen folder");
  const status = await writtenStatus(instance, context);
  assert.equal(status.state, "failed");
  assert.equal(status.lastError.code, "backup-copy-missing");
  // Looked at every minute, logged once.
  assert.equal(instance.due(), true);
  await instance.tick();
  assert.equal(events.filter((event) => event.event === "home_backup_copy_failed").length, 1);
  assert.deepEqual(events[0], { event: "home_backup_copy_failed", code: "backup-copy-missing", reason: "ENOENT" });
  mkdirSync(missing);
  context.clock.advance(60_000);
  assert.equal((await instance.tick()).state, "ok");
  assert.equal(listBackups(join(missing, COPIES_FOLDER, NAME)).length, 1);
  assert.equal((await writtenStatus(instance, context)).lastError, null);
});

test("a folder on the same disk as the data directory is refused, and nothing is written there", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  const instance = new BackupCopier({ dataDirectory: context.dataDirectory, env: {}, now: context.clock.now });
  assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-same-disk" });
  assert.deepEqual(readdirSync(context.chosen), []);
  // A path that isn't a full path on this computer (settings restored from
  // another kind of computer) is refused the same way as a missing one.
  context.settings(process.platform === "win32" ? "/media/usb" : "E:\\Backups");
  assert.equal((await instance.sync()).code, "backup-copy-missing");
});

test("each problem has its code; a full drive is found before anything is written", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  const events = [];
  const failing = (code) => async (path) => { if (path.startsWith(context.chosen)) throw systemError(code); return stat(path); };
  const codeWith = async (files) => (await copier(context, { events, files }).sync()).code;
  assert.equal(await codeWith({ stat: failing("ENOTDIR") }), "backup-copy-not-folder");
  for (const code of ["EACCES", "EPERM", "EROFS"]) assert.equal(await codeWith({ stat: failing(code) }), "backup-copy-denied", code);
  assert.equal(await codeWith({ stat: failing("EIO") }), "backup-copy-failed");
  assert.equal(await codeWith({ statfs: async () => ({ bavail: 1, bsize: 4096 }) }), "backup-copy-full");
  assert.deepEqual(readdirSync(context.copies), [], "nothing was written");
  assert.equal(await codeWith({ copyFile: async () => { throw systemError("ENOSPC"); } }), "backup-copy-full");
  assert.equal(await codeWith({ copyFile: async () => { throw systemError("EFBIG"); } }), "backup-copy-too-big");
  assert.equal(await codeWith({ copyFile: async () => { throw systemError("EIO"); } }), "backup-copy-failed");
  assert.deepEqual(readdirSync(context.copies), [], "a failed copy leaves no folder");
  // A file where the folder should be.
  const file = join(context.root, "a-file");
  writeFileSync(file, "not a folder\n");
  context.settings(file);
  assert.equal((await copier(context, { events, files: { stat: otherDisk(file) } }).sync()).code, "backup-copy-not-folder");
  for (const event of events) assert.ok(BACKUP_COPY_ERROR_CODES.includes(event.code), event.code);
  assert.ok(!JSON.stringify(events).includes(context.root), "the log holds no path");
});

test("a copy that fails half-way leaves nothing behind, and an unfinished one is copied again", async (t) => {
  const context = fixture(t);
  const older = await context.makeSet();
  const newer = await context.makeSet();
  // The newer set copies; the older one fails between its files.
  const halfway = copier(context, { files: { copyFile: async (source, destination) => {
    if (source.includes(older.id) && source.includes("home")) throw systemError("EIO");
    return copyFileFlushed(source, destination);
  } } });
  assert.equal((await halfway.sync()).code, "backup-copy-failed");
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), [newer.id], "the copy that worked stays");
  assert.ok(!existsSync(join(context.copies, older.id)), "the half-made copy went");
  // A copy that doesn't read back as the original is removed too.
  const damaged = copier(context, { files: { copyFile: async (source, destination) => {
    const copied = await copyFileFlushed(source, destination);
    if (basename(source) === "kin.sqlite") appendFileSync(destination, "x");
    return copied;
  } } });
  assert.equal((await damaged.sync()).code, "backup-copy-failed");
  assert.ok(!existsSync(join(context.copies, older.id)));
  // A folder left without its manifest (Kin stopped mid-copy) is unfinished.
  mkdirSync(join(context.copies, older.id));
  writeFileSync(join(context.copies, older.id, "kin.sqlite"), "half");
  assert.equal((await copier(context).sync()).copied, 1);
  assert.deepEqual(readFileSync(join(context.copies, older.id, "kin.sqlite")), readFileSync(join(backupsDirectory(context.dataDirectory), older.id, "kin.sqlite")));
});

test("a set the service removes during the copy is skipped, not reported", async (t) => {
  const context = fixture(t);
  const older = await context.makeSet();
  const newer = await context.makeSet();
  const events = [];
  const instance = copier(context, { events, files: { copyFile: async (source, destination) => {
    if (source.includes(older.id)) rmSync(join(backupsDirectory(context.dataDirectory), older.id), { recursive: true, force: true });
    return copyFileFlushed(source, destination);
  } } });
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 1, removed: 0 });
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), [newer.id]);
  assert.ok(!existsSync(join(context.copies, older.id)));
  assert.ok(!events.some((event) => event.event === "home_backup_copy_failed"));
});

test("no folder or no name: off, and nothing outside the data directory is looked at; a folder chosen later is picked up", async (t) => {
  for (const options of [{ folder: null }, { name: null }]) {
    const context = fixture(t, options);
    await context.makeSet();
    const looked = [];
    const instance = copier(context, { files: { stat: async (path) => { looked.push(path); return stat(path); } } });
    assert.deepEqual(await instance.sync(), { state: "off" });
    assert.equal(instance.due(), false);
    assert.deepEqual(looked.filter((path) => !path.startsWith(context.dataDirectory)), [], JSON.stringify(options));
    assert.ok(!existsSync(join(backupsDirectory(context.dataDirectory), BACKUP_COPY_STATUS)), "off from the start: nothing to write");
  }
  const context = fixture(t, { folder: null });
  await context.makeSet();
  const instance = copier(context);
  await instance.sync();
  context.settings(context.chosen);
  assert.equal(instance.due(), true, "the folder changed");
  assert.equal((await instance.tick()).state, "ok");
  const status = await writtenStatus(instance, context);
  assert.equal(status.folder, context.chosen);
  assert.equal(status.copies, 1);
  // Turned off again: said once.
  context.settings(null);
  assert.equal(instance.due(), true);
  await instance.tick();
  assert.equal((await writtenStatus(instance, context)).state, "off");
  assert.equal(instance.due(), false);
});

test("one look at a time: a backup made during a copy is copied by the next run, never alongside", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const copying = new Promise((resolve) => { reached = resolve; });
  let active = 0;
  let most = 0;
  let first = true;
  const events = [];
  const instance = copier(context, { events, files: { copyFile: async (source, destination) => {
    active += 1;
    most = Math.max(most, active);
    try {
      if (first) { first = false; reached(); await held; }
      return await copyFileFlushed(source, destination);
    } finally {
      active -= 1;
    }
  } } });
  const running = instance.sync();
  await copying;
  assert.equal((await writtenStatus(instance, context)).state, "copying");
  const later = await context.makeSet();
  instance.backupMade();
  instance.backupMade();
  assert.equal(await instance.tick(), null, "the minute's look waits for the copy under way");
  release();
  await running;
  assert.equal(most, 1, "never two copies at once");
  assert.deepEqual(events.map((event) => event.copied), [1, 1], "two runs, one after the other");
  assert.equal(listBackups(context.copies)[0].id, later.id);
  const status = await writtenStatus(instance, context);
  assert.equal(status.state, "ok");
  assert.equal(status.copies, 2);
});

test("stopping: a copy under way stops after its file and leaves no half copy", async (t) => {
  const context = fixture(t);
  const set = await context.makeSet();
  let instance;
  instance = copier(context, { files: { copyFile: async (source, destination) => {
    const copied = await copyFileFlushed(source, destination);
    instance.stop();
    return copied;
  } } });
  assert.deepEqual(await instance.sync(), { state: "stopped" });
  assert.ok(!existsSync(join(context.copies, set.id)));
});
