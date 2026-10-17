// DurableStore install identity (#78): the household's published, unencrypted
// home-screen name and icons. One row per publishing household; withdrawing
// deletes it. household_install_identity_revisions keeps the last revision
// after a withdrawal so a later publish never reuses its icon URLs.
import { DurableConflictError } from "./shared.mjs";

const ICON_COLUMNS = ["icon_192", "icon_512", "icon_maskable_512", "icon_apple_180"];

function row(value) {
  return value ? {
    rev: value.rev, name: value.name, shortName: value.short_name, description: value.description,
    iconSource: value.icon_source, updatedAt: value.updated_at,
    icons: { icon192: Buffer.from(value.icon_192), icon512: Buffer.from(value.icon_512),
      maskable512: Buffer.from(value.icon_maskable_512), apple180: Buffer.from(value.icon_apple_180) },
  } : null;
}

export const installIdentityMethods = {
  getInstallIdentity(householdId) {
    this.assertAvailable();
    return row(this.db.prepare("SELECT * FROM household_install_identity WHERE household_id = ?").get(householdId));
  },

  /** Publishes `value` if the published revision is still `expectedRev` (0
   * when nothing is published) and returns the new revision. */
  putInstallIdentity(householdId, expectedRev, value) {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT rev FROM household_install_identity WHERE household_id = ?").get(householdId);
      if ((current?.rev ?? 0) !== expectedRev)
        throw new DurableConflictError("install_identity_stale", "The home screen details changed on another device. Reload and try again.");
      const last = this.db.prepare("SELECT last_rev FROM household_install_identity_revisions WHERE household_id = ?").get(householdId)?.last_rev ?? 0;
      const rev = Math.max(last, expectedRev) + 1;
      this.db.prepare(`INSERT INTO household_install_identity
        (household_id, rev, name, short_name, description, icon_source, ${ICON_COLUMNS.join(", ")},
         updated_by_member_id, updated_by_device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(household_id) DO UPDATE SET rev=excluded.rev, name=excluded.name, short_name=excluded.short_name,
          description=excluded.description, icon_source=excluded.icon_source, icon_192=excluded.icon_192,
          icon_512=excluded.icon_512, icon_maskable_512=excluded.icon_maskable_512, icon_apple_180=excluded.icon_apple_180,
          updated_by_member_id=excluded.updated_by_member_id, updated_by_device_id=excluded.updated_by_device_id,
          updated_at=excluded.updated_at`)
        .run(householdId, rev, value.name, value.shortName, value.description, value.iconSource,
          value.icons.icon192, value.icons.icon512, value.icons.maskable512, value.icons.apple180,
          value.memberId, value.deviceId, value.updatedAt);
      this.db.prepare(`INSERT INTO household_install_identity_revisions(household_id, last_rev) VALUES (?, ?)
        ON CONFLICT(household_id) DO UPDATE SET last_rev = excluded.last_rev`).run(householdId, rev);
      return rev;
    });
  },

  /** Deletes the published copy if its revision is still `expectedRev`.
   * Returns whether anything was published. */
  deleteInstallIdentity(householdId, expectedRev) {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT rev FROM household_install_identity WHERE household_id = ?").get(householdId);
      if (!current) return false;
      if (current.rev !== expectedRev)
        throw new DurableConflictError("install_identity_stale", "The home screen details changed on another device. Reload and try again.");
      this.db.prepare("DELETE FROM household_install_identity WHERE household_id = ?").run(householdId);
      return true;
    });
  },
};
