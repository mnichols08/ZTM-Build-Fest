// DurableStore schema: migrations to SERVER_SCHEMA_VERSION and the schema check.
import { MAX_ACTIVE_MEMBERS } from "../identity-limits.mjs";
import {
  DurableStoreError,
  MAX_ATTACHMENT_BYTES,
  SERVER_SCHEMA_VERSION,
  sqlitePragma,
} from "./shared.mjs";

export const schemaMethods = {
  migrate(migrationFault) {
    let version = sqlitePragma(this.db, "user_version", { simple: true });
    if (!Number.isSafeInteger(version) || version < 0)
      throw new DurableStoreError("Kin server schema metadata is invalid.");
    if (version > SERVER_SCHEMA_VERSION)
      throw new DurableStoreError(
        "The Kin database was created by a newer server version.",
      );
    if (version === SERVER_SCHEMA_VERSION) {
      const migrations = this.db
        .prepare("SELECT version FROM server_migrations ORDER BY version")
        .all();
      if (
        migrations.length !== SERVER_SCHEMA_VERSION ||
        migrations.some((row, index) => row.version !== index + 1)
      )
        throw new DurableStoreError("Kin server migration metadata is invalid.");
      return;
    }

    if (version === 0) {
      const existingTables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (existingTables.length)
        throw new DurableStoreError(
          "The Kin database has unversioned data and cannot be migrated safely.",
        );

      try {
        this.transaction(() => {
        this.db.exec(`
          CREATE TABLE server_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
          );
          CREATE TABLE households (
            id TEXT PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 1)
          );
          CREATE TABLE members (
            id TEXT PRIMARY KEY,
            household_id TEXT NOT NULL REFERENCES households(id),
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            credential_ids TEXT NOT NULL,
            UNIQUE (id, household_id)
          );
          CREATE INDEX members_by_household ON members(household_id);
          CREATE TRIGGER members_active_limit_insert
          BEFORE INSERT ON members
          WHEN NEW.active = 1 AND (
            SELECT COUNT(*) FROM members
            WHERE household_id = NEW.household_id AND active = 1
              AND id <> NEW.id
          ) >= ${MAX_ACTIVE_MEMBERS}
          BEGIN
            SELECT RAISE(ABORT, 'household active member limit');
          END;
          CREATE TRIGGER members_active_limit_update
          BEFORE UPDATE OF active, household_id ON members
          WHEN NEW.active = 1 AND (
            SELECT COUNT(*) FROM members
            WHERE household_id = NEW.household_id AND active = 1
              AND id <> NEW.id
          ) >= ${MAX_ACTIVE_MEMBERS}
          BEGIN
            SELECT RAISE(ABORT, 'household active member limit');
          END;
          CREATE TABLE credentials (
            id TEXT PRIMARY KEY,
            member_id TEXT NOT NULL REFERENCES members(id),
            credential_json TEXT NOT NULL
          );
          CREATE INDEX credentials_by_member ON credentials(member_id);
          CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            household_id TEXT NOT NULL REFERENCES households(id),
            member_id TEXT NOT NULL,
            token_hash TEXT UNIQUE,
            revoked_at INTEGER,
            device_json TEXT NOT NULL,
            FOREIGN KEY (member_id, household_id)
              REFERENCES members(id, household_id),
            UNIQUE (id, household_id)
          );
          CREATE INDEX devices_by_household ON devices(household_id);
          CREATE INDEX devices_by_member ON devices(member_id);
          CREATE TRIGGER devices_active_limit_insert
          BEFORE INSERT ON devices
          WHEN NEW.revoked_at IS NULL AND (
            SELECT COUNT(*) FROM devices
            WHERE household_id = NEW.household_id AND revoked_at IS NULL
              AND id <> NEW.id
          ) >= 16
          BEGIN
            SELECT RAISE(ABORT, 'household trusted device limit');
          END;
          CREATE TRIGGER devices_active_limit_update
          BEFORE UPDATE OF revoked_at, household_id ON devices
          WHEN NEW.revoked_at IS NULL AND (
            SELECT COUNT(*) FROM devices
            WHERE household_id = NEW.household_id AND revoked_at IS NULL
              AND id <> NEW.id
          ) >= 16
          BEGIN
            SELECT RAISE(ABORT, 'household trusted device limit');
          END;
          CREATE TABLE sync_households (
            household_id TEXT PRIMARY KEY REFERENCES households(id),
            current_epoch INTEGER NOT NULL CHECK (current_epoch BETWEEN 1 AND 128),
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            rotation_pending INTEGER NOT NULL CHECK (rotation_pending IN (0, 1)),
            next_sequence INTEGER NOT NULL CHECK (next_sequence BETWEEN 1 AND 100000001),
            last_rotation_json TEXT
          );
          CREATE TABLE sync_device_sequences (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            device_id TEXT NOT NULL,
            last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
            PRIMARY KEY (household_id, device_id),
            FOREIGN KEY (device_id, household_id)
              REFERENCES devices(id, household_id)
          );
          CREATE TABLE sync_events (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            relay_sequence INTEGER NOT NULL CHECK (relay_sequence BETWEEN 1 AND 100000000),
            event_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            device_sequence INTEGER NOT NULL CHECK (device_sequence >= 1),
            key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 1 AND 128),
            canonical_envelope TEXT NOT NULL,
            PRIMARY KEY (household_id, relay_sequence),
            UNIQUE (household_id, event_id),
            UNIQUE (household_id, device_id, device_sequence),
            FOREIGN KEY (device_id, household_id)
              REFERENCES devices(id, household_id)
          );
          CREATE INDEX sync_events_by_device_sequence
            ON sync_events(household_id, device_id, device_sequence);
          CREATE TABLE sync_bindings (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            event_id TEXT NOT NULL,
            canonical_envelope TEXT NOT NULL,
            PRIMARY KEY (household_id, event_id)
          );
          CREATE TABLE provisioning_grants (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            grant_id TEXT NOT NULL,
            sender_device_id TEXT NOT NULL,
            recipient_device_id TEXT NOT NULL,
            request_id TEXT,
            expires_at INTEGER NOT NULL,
            grant_json TEXT NOT NULL,
            PRIMARY KEY (household_id, grant_id),
            UNIQUE (household_id, sender_device_id, request_id),
            FOREIGN KEY (sender_device_id, household_id)
              REFERENCES devices(id, household_id),
            FOREIGN KEY (recipient_device_id, household_id)
              REFERENCES devices(id, household_id)
          );
          CREATE INDEX provisioning_by_expiry
            ON provisioning_grants(household_id, expires_at);
          CREATE TABLE security_audit (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id TEXT NOT NULL REFERENCES households(id),
            created_at INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            details_json TEXT NOT NULL
          );
          CREATE INDEX security_audit_by_household
            ON security_audit(household_id, sequence);
        `);
        migrationFault?.();
          this.db
          .prepare(
            "INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)",
          )
            .run(1, Date.now());
          sqlitePragma(this.db, "user_version = 1");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError(
          "Kin could not complete the server schema migration.",
          { cause: error },
        );
      }
      version = 1;
    }

    if (version === 1) {
      try {
        this.transaction(() => {
          this.db.exec(`
            ALTER TABLE households ADD COLUMN lifecycle_state TEXT NOT NULL
              DEFAULT 'active'
              CHECK (lifecycle_state IN ('active', 'deletion_pending', 'deleted'));
            ALTER TABLE households ADD COLUMN deletion_requested_at INTEGER;
            ALTER TABLE households ADD COLUMN deletion_finalize_at INTEGER;
            ALTER TABLE households ADD COLUMN deleted_at INTEGER;
            CREATE TRIGGER members_active_household_insert
            BEFORE INSERT ON members
            WHEN (SELECT lifecycle_state FROM households WHERE id = NEW.household_id)
              <> 'active'
            BEGIN
              SELECT RAISE(ABORT, 'household lifecycle is closed');
            END;
            CREATE TRIGGER devices_active_household_insert
            BEFORE INSERT ON devices
            WHEN (SELECT lifecycle_state FROM households WHERE id = NEW.household_id)
              <> 'active'
            BEGIN
              SELECT RAISE(ABORT, 'household lifecycle is closed');
            END;
            CREATE TRIGGER sync_households_active_household_insert
            BEFORE INSERT ON sync_households
            WHEN (SELECT lifecycle_state FROM households WHERE id = NEW.household_id)
              <> 'active'
            BEGIN
              SELECT RAISE(ABORT, 'household lifecycle is closed');
            END;
            CREATE TRIGGER sync_events_active_household_insert
            BEFORE INSERT ON sync_events
            WHEN (SELECT lifecycle_state FROM households WHERE id = NEW.household_id)
              <> 'active'
            BEGIN
              SELECT RAISE(ABORT, 'household lifecycle is closed');
            END;
            CREATE TRIGGER sync_bindings_active_household_insert
            BEFORE INSERT ON sync_bindings
            WHEN (SELECT lifecycle_state FROM households WHERE id = NEW.household_id)
              <> 'active'
            BEGIN
              SELECT RAISE(ABORT, 'household lifecycle is closed');
            END;
            CREATE TRIGGER provisioning_grants_active_household_insert
            BEFORE INSERT ON provisioning_grants
            WHEN (SELECT lifecycle_state FROM households WHERE id = NEW.household_id)
              <> 'active'
            BEGIN
              SELECT RAISE(ABORT, 'household lifecycle is closed');
            END;
          `);
          this.db
            .prepare(
              "INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)",
            )
            .run(2, Date.now());
          sqlitePragma(this.db, "user_version = 2");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError(
          "Kin could not complete the household lifecycle migration.",
          { cause: error },
        );
      }
      version = 2;
    }

    if (version === 2) {
      try {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE sync_attachments (
              household_id TEXT NOT NULL REFERENCES households(id),
              attachment_id TEXT NOT NULL,
              key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 1 AND 128),
              ciphertext BLOB NOT NULL,
              size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND ${MAX_ATTACHMENT_BYTES}),
              digest TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (household_id, attachment_id)
            );
            CREATE INDEX sync_attachments_by_household ON sync_attachments(household_id, attachment_id);
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(3, Date.now());
          sqlitePragma(this.db, "user_version = 3");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the encrypted attachment migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 3) {
      try {
        this.transaction(() => {
          this.db.exec(`
            DROP TRIGGER members_active_limit_insert;
            DROP TRIGGER members_active_limit_update;
            CREATE TRIGGER members_active_limit_insert
            BEFORE INSERT ON members
            WHEN NEW.active = 1 AND (
              SELECT COUNT(*) FROM members
              WHERE household_id = NEW.household_id AND active = 1
                AND id <> NEW.id
            ) >= ${MAX_ACTIVE_MEMBERS}
            BEGIN
              SELECT RAISE(ABORT, 'household active member limit');
            END;
            CREATE TRIGGER members_active_limit_update
            BEFORE UPDATE OF active, household_id ON members
            WHEN NEW.active = 1 AND (
              SELECT COUNT(*) FROM members
              WHERE household_id = NEW.household_id AND active = 1
                AND id <> NEW.id
            ) >= ${MAX_ACTIVE_MEMBERS}
            BEGIN
              SELECT RAISE(ABORT, 'household active member limit');
            END;
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(4, Date.now());
          sqlitePragma(this.db, "user_version = 4");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the adult membership migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 4) {
      try {
        this.transaction(() => {
          this.db.exec(`
            ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'adult'
              CHECK (kind IN ('adult', 'limited', 'temporary'));
            ALTER TABLE members ADD COLUMN expires_at INTEGER;
            CREATE TRIGGER members_temporary_expiry_insert
            BEFORE INSERT ON members
            WHEN NEW.kind = 'temporary' AND NEW.expires_at IS NULL
            BEGIN SELECT RAISE(ABORT, 'temporary member expiry required'); END;
            CREATE TRIGGER members_temporary_expiry_update
            BEFORE UPDATE OF kind, expires_at ON members
            WHEN NEW.kind = 'temporary' AND NEW.expires_at IS NULL
            BEGIN SELECT RAISE(ABORT, 'temporary member expiry required'); END;
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(5, Date.now());
          sqlitePragma(this.db, "user_version = 5");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the member-kind migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 5) {
      try {
        this.transaction(() => {
          this.db.exec(`
            ALTER TABLE members ADD COLUMN member_status TEXT NOT NULL DEFAULT 'active'
              CHECK (member_status IN ('active', 'removed', 'expired'));
            UPDATE members SET member_status = CASE
              WHEN active = 1 AND kind = 'temporary' AND expires_at <= ${Date.now()} THEN 'expired'
              WHEN active = 1 THEN 'active'
              WHEN (SELECT event_type FROM security_audit
                WHERE household_id = members.household_id
                  AND json_extract(details_json, '$.memberId') = members.id
                  AND event_type IN ('membership_removed', 'temporary_access_expired')
                ORDER BY sequence DESC LIMIT 1) = 'temporary_access_expired' THEN 'expired'
              WHEN (SELECT event_type FROM security_audit
                WHERE household_id = members.household_id
                  AND json_extract(details_json, '$.memberId') = members.id
                  AND event_type IN ('membership_removed', 'temporary_access_expired')
                ORDER BY sequence DESC LIMIT 1) = 'membership_removed' THEN 'removed'
              WHEN kind = 'temporary' AND expires_at <= ${Date.now()} THEN 'expired'
              ELSE 'removed'
            END;
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(6, Date.now());
          sqlitePragma(this.db, "user_version = 6");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the authoritative membership-status migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 6) {
      try {
        this.transaction(() => {
          this.db.exec(`
            ALTER TABLE households ADD COLUMN owner_member_id TEXT;
            CREATE TABLE household_settings (
              household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
              revision INTEGER NOT NULL CHECK (revision >= 1),
              key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 1 AND 128),
              ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 29 AND 4198400),
              digest TEXT NOT NULL CHECK (length(digest) = 64),
              updated_by_member_id TEXT NOT NULL,
              updated_by_device_id TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(7, Date.now());
          sqlitePragma(this.db, "user_version = 7");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the household owner/settings migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 7) {
      try {
        this.transaction(() => {
          // Only a recorded founder-owner becomes the first admin. Ownerless
          // legacy households stay adminless; nothing is inferred.
          this.db.exec(`
            ALTER TABLE members ADD COLUMN household_admin INTEGER NOT NULL DEFAULT 0
              CHECK (household_admin IN (0, 1));
            UPDATE members SET household_admin = 1
              WHERE kind = 'adult' AND id IN (
                SELECT owner_member_id FROM households
                WHERE owner_member_id IS NOT NULL AND households.id = members.household_id
              );
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(8, Date.now());
          sqlitePragma(this.db, "user_version = 8");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the household admin migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 8) {
      try {
        this.transaction(() => {
          // The member who uploaded each attachment. Rows stored before this
          // migration keep NULL: only an Adult may delete those.
          this.db.exec("ALTER TABLE sync_attachments ADD COLUMN uploader_member_id TEXT");
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(9, Date.now());
          sqlitePragma(this.db, "user_version = 9");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the attachment uploader migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 9) {
      try {
        this.transaction(() => {
          // v1.1 (#78): the install identity an admin chose to publish
          // unencrypted, so devices can show it on home screens. One row per
          // publishing household; withdrawing deletes the row. The revision
          // only grows (the second table keeps it across a withdrawal), so a
          // stale write is refused. content_tag hashes the published content:
          // icon URLs and the manifest ETag name it, so they change whenever
          // the content does, even after a backup restore.
          this.db.exec(`
            CREATE TABLE household_install_identity (
              household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
              rev INTEGER NOT NULL CHECK (rev >= 1),
              name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
              short_name TEXT NOT NULL CHECK (length(short_name) BETWEEN 1 AND 48),
              description TEXT NOT NULL CHECK (length(description) <= 200),
              icon_source TEXT NOT NULL CHECK (icon_source IN ('letter', 'upload')),
              content_tag TEXT NOT NULL CHECK (length(content_tag) = 16),
              icon_192 BLOB NOT NULL CHECK (length(icon_192) BETWEEN 33 AND 524288),
              icon_512 BLOB NOT NULL CHECK (length(icon_512) BETWEEN 33 AND 524288),
              icon_maskable_512 BLOB NOT NULL CHECK (length(icon_maskable_512) BETWEEN 33 AND 524288),
              icon_apple_180 BLOB NOT NULL CHECK (length(icon_apple_180) BETWEEN 33 AND 524288),
              updated_by_member_id TEXT NOT NULL,
              updated_by_device_id TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE household_install_identity_revisions (
              household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
              last_rev INTEGER NOT NULL CHECK (last_rev >= 1)
            );
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(10, Date.now());
          sqlitePragma(this.db, "user_version = 10");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the install identity migration.", { cause: error });
      }
    }

    if (sqlitePragma(this.db, "user_version", { simple: true }) === 10) {
      try {
        this.transaction(() => {
          // v1.1 (#85): Web Push. One subscription per device, deleted when
          // the device loses access; the VAPID key pair lives here rather
          // than in a file, because the sandboxed service cannot fsync files
          // and SQLite makes it durable and part of every backup.
          this.db.exec(`
            CREATE TABLE push_subscriptions (
              device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
              household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
              member_id TEXT NOT NULL,
              endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 9 AND 2048),
              p256dh BLOB NOT NULL CHECK (length(p256dh) = 65),
              auth BLOB NOT NULL CHECK (length(auth) = 16),
              muted_until INTEGER,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX push_subscriptions_household ON push_subscriptions(household_id);
            CREATE TABLE push_vapid_keys (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              private_jwk TEXT NOT NULL,
              public_jwk TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
          `);
          this.db.prepare("INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)").run(11, Date.now());
          sqlitePragma(this.db, "user_version = 11");
        });
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not complete the push notification migration.", { cause: error });
      }
    }
  },

  verify() {
    if (sqlitePragma(this.db, "user_version", { simple: true }) !== SERVER_SCHEMA_VERSION)
      throw new DurableStoreError("Kin server schema metadata is invalid.");
    const migrations = this.db
      .prepare("SELECT version, applied_at FROM server_migrations ORDER BY version")
      .all();
    if (
      migrations.length !== SERVER_SCHEMA_VERSION ||
      migrations.some(
        (row, index) =>
          row.version !== index + 1 ||
          !Number.isSafeInteger(row.applied_at) ||
          row.applied_at < 0,
      )
    )
      throw new DurableStoreError("Kin server migration metadata is invalid.");
    const integrity = sqlitePragma(this.db, "integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new DurableStoreError("Kin server database integrity check failed.");
    if (sqlitePragma(this.db, "foreign_key_check").length)
      throw new DurableStoreError(
        "Kin server database relationships are inconsistent.",
      );
  },
};
