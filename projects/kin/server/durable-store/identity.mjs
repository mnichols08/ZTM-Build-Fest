// DurableStore identity: households, members, devices and sessions loaded
// into and saved from the pairing service, and household settings.
import {
  validCredentialId,
  validStoredCredential,
  validStoredDevice,
} from "../durable-identity.mjs";
import {
  MAX_ACTIVE_ADULTS,
  MAX_ACTIVE_LIMITED_MEMBERS,
  MAX_ACTIVE_MEMBERS,
  MAX_TRUSTED_DEVICES,
} from "../identity-limits.mjs";
import {
  auditDetails,
  DurableConflictError,
  DurableStoreError,
  isId,
  isTimestamp,
  MAX_AUDIT_ROWS,
  parseJson,
  parseStoredJson,
  stringifyStored,
} from "./shared.mjs";

export const identityMethods = {
  loadIdentity() {
    this.assertAvailable();
    try {
      const households = new Map();
      const members = new Map();
      const credentials = new Map();
      const devices = new Map();
      const activeMemberCounts = new Map();
      const activeKindCounts = new Map();
      const trustedDeviceCounts = new Map();
      for (const row of this.db.prepare("SELECT * FROM households").all()) {
        if (
          !isId(row.id) ||
          !Number.isSafeInteger(row.version) ||
          row.version < 1 ||
          !["active", "deletion_pending", "deleted"].includes(
            row.lifecycle_state,
          ) ||
          (row.lifecycle_state === "active" &&
            (row.deletion_requested_at !== null ||
              row.deletion_finalize_at !== null ||
              row.deleted_at !== null)) ||
          (row.lifecycle_state === "deletion_pending" &&
            (!isTimestamp(row.deletion_requested_at) ||
              !isTimestamp(row.deletion_finalize_at) ||
              row.deletion_finalize_at <= row.deletion_requested_at ||
              row.deleted_at !== null)) ||
          (row.lifecycle_state === "deleted" &&
            (row.deletion_requested_at !== null ||
              row.deletion_finalize_at !== null ||
              !isTimestamp(row.deleted_at)))
        )
          throw new DurableStoreError("Kin server household data is invalid.");
        households.set(row.id, {
          id: row.id,
          members: new Set(),
          version: row.version,
          lifecycleState: row.lifecycle_state,
          deletionRequestedAt: row.deletion_requested_at,
          deletionFinalizeAt: row.deletion_finalize_at,
          deletedAt: row.deleted_at,
          ownerMemberId: row.owner_member_id ?? null,
        });
      }
      for (const row of this.db.prepare("SELECT * FROM members").all()) {
        const credentialIds = parseJson(row.credential_ids);
        if (
          !isId(row.id) ||
          !isId(row.household_id) ||
          ![0, 1].includes(row.active) ||
          !Array.isArray(credentialIds) ||
          credentialIds.some((id) => !validCredentialId(id)) ||
          new Set(credentialIds).size !== credentialIds.length
        )
          throw new DurableStoreError("Kin server membership data is invalid.");
        const member = {
          id: row.id,
          householdId: row.household_id,
          active: Boolean(row.active),
          memberStatus: row.member_status ?? (row.active ? "active" : "removed"),
          kind: row.kind ?? "adult",
          ...(row.expires_at == null ? {} : { expiresAt: row.expires_at }),
          ...(row.household_admin === 1 ? { householdAdmin: true } : {}),
          credentials: new Set(credentialIds),
        };
        if (!["adult", "limited", "temporary"].includes(member.kind) ||
            ![0, 1].includes(row.household_admin ?? 0) ||
            (member.householdAdmin && member.kind !== "adult") ||
            !["active", "removed", "expired"].includes(member.memberStatus) ||
            (member.memberStatus === "expired" && member.kind !== "temporary") ||
            (member.kind === "temporary" && !Number.isSafeInteger(member.expiresAt)) ||
            (member.kind !== "temporary" && member.expiresAt !== undefined))
          throw new DurableStoreError("Kin server membership data is invalid.");
        members.set(member.id, member);
        const household = households.get(member.householdId);
        if (!household)
          throw new DurableStoreError("Kin server membership data is invalid.");
        household.members.add(member.id);
        const activeCount =
          (activeMemberCounts.get(household.id) ?? 0) + row.active;
        if (activeCount > MAX_ACTIVE_MEMBERS)
          throw new DurableStoreError("Kin server membership data is invalid.");
        activeMemberCounts.set(household.id, activeCount);
        if (row.active) {
          const kindCount = activeKindCounts.get(`${household.id}:${member.kind}`) ?? 0;
          const limit = member.kind === "adult" ? MAX_ACTIVE_ADULTS : member.kind === "limited" ? MAX_ACTIVE_LIMITED_MEMBERS : MAX_ACTIVE_MEMBERS;
          if (kindCount + 1 > limit)
            throw new DurableStoreError("Kin server membership data is invalid.");
          activeKindCounts.set(`${household.id}:${member.kind}`, kindCount + 1);
        }
      }
      for (const household of households.values()) {
        if (household.ownerMemberId === null) continue;
        const owner = members.get(household.ownerMemberId);
        if (!isId(household.ownerMemberId) || !owner || owner.householdId !== household.id || owner.kind !== "adult")
          throw new DurableStoreError("Kin server household ownership data is invalid.");
      }
      for (const row of this.db.prepare("SELECT * FROM credentials").all()) {
        const credential = parseStoredJson(row.credential_json);
        if (
          !validStoredCredential(credential) ||
          !validCredentialId(row.id) ||
          credential.id !== row.id ||
          credential.memberId !== row.member_id ||
          !members.get(row.member_id)?.credentials.has(row.id)
        )
          throw new DurableStoreError("Kin server credential data is invalid.");
        credentials.set(row.id, credential);
      }
      for (const row of this.db.prepare("SELECT * FROM devices").all()) {
        const device = parseStoredJson(row.device_json);
        if (
          !validStoredDevice(device) ||
          !isId(row.id) ||
          !isId(row.household_id) ||
          !isId(row.member_id) ||
          device.id !== row.id ||
          device.memberId !== row.member_id ||
          device.householdId !== row.household_id ||
          device.tokenHash !== row.token_hash ||
          device.revokedAt !== row.revoked_at ||
          !households.has(row.household_id) ||
          members.get(row.member_id)?.householdId !== row.household_id
        )
          throw new DurableStoreError("Kin server device data is invalid.");
        devices.set(row.id, device);
        const trustedCount =
          (trustedDeviceCounts.get(row.household_id) ?? 0) +
          Number(row.revoked_at === null);
        if (trustedCount > MAX_TRUSTED_DEVICES)
          throw new DurableStoreError("Kin server device data is invalid.");
        trustedDeviceCounts.set(row.household_id, trustedCount);
      }
      for (const device of devices.values()) {
        const certificate = device.deviceAuthorizationCertificate;
        if (
          certificate &&
          devices.get(certificate.issuerDeviceId)?.householdId !== device.householdId
        )
          throw new DurableStoreError("Kin server device data is invalid.");
      }
      for (const member of members.values())
        for (const credentialId of member.credentials)
          if (credentials.get(credentialId)?.memberId !== member.id)
            throw new DurableStoreError(
              "Kin server credential data is invalid.",
            );
      for (const household of households.values())
        if (household.lifecycleState === "deleted" && household.members.size)
          throw new DurableStoreError("Kin deleted-household data is invalid.");
      return { households, members, credentials, devices };
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin server identity data is invalid.", {
        cause: error,
      });
    }
  },

  saveIdentityHousehold(householdId, service) {
    const household = service.households.get(householdId);
    if (!household)
      throw new DurableStoreError("Kin server household data is unavailable.");
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO households(id, version, owner_member_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, owner_member_id = excluded.owner_member_id",
        )
        .run(household.id, household.version, household.ownerMemberId ?? null);

      for (const memberId of household.members) {
        const member = service.members.get(memberId);
        if (!member || member.householdId !== householdId)
          throw new DurableStoreError("Kin server membership data is invalid.");
        this.db
          .prepare(
            "INSERT INTO members(id, household_id, active, credential_ids, kind, expires_at, member_status, household_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active = excluded.active, credential_ids = excluded.credential_ids, kind = excluded.kind, expires_at = excluded.expires_at, member_status = excluded.member_status, household_admin = excluded.household_admin",
          )
          .run(
            member.id,
            householdId,
            Number(member.active),
            JSON.stringify([...member.credentials]),
            member.kind ?? "adult",
            member.expiresAt ?? null,
            member.memberStatus ?? (member.active ? "active" : "removed"),
            Number(member.householdAdmin === true),
          );
        for (const credentialId of member.credentials) {
          const credential = service.credentials.get(credentialId);
          if (!credential || credential.memberId !== memberId)
            throw new DurableStoreError("Kin server credential data is invalid.");
          this.db
            .prepare(
              "INSERT INTO credentials(id, member_id, credential_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, credential_json = excluded.credential_json",
            )
            .run(credentialId, memberId, stringifyStored(credential));
        }
      }

      const retainedCredentialIds = [...household.members].flatMap(
        (memberId) => [...service.members.get(memberId).credentials],
      );
      const removeCredential = this.db.prepare(
        "DELETE FROM credentials WHERE member_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
      );
      for (const memberId of household.members)
        removeCredential.run(memberId, JSON.stringify(retainedCredentialIds));

      const devices = [...service.devices.values()].filter(
        (device) => device.householdId === householdId,
      );
      for (const device of devices) {
        this.db
          .prepare(
            "INSERT INTO devices(id, household_id, member_id, token_hash, revoked_at, device_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = excluded.revoked_at, device_json = excluded.device_json",
          )
          .run(
            device.id,
            householdId,
            device.memberId,
            device.tokenHash,
            device.revokedAt,
            stringifyStored(device),
          );
      }

      const pendingAudit = service.events.filter(
        (event) => event.persisted !== true && event.householdId === householdId,
      );
      const insertAudit = this.db.prepare(
        "INSERT INTO security_audit(household_id, created_at, event_type, details_json) VALUES (?, ?, ?, ?)",
      );
      for (const event of pendingAudit) {
        insertAudit.run(
          householdId,
          event.at,
          event.type,
          JSON.stringify(auditDetails(event)),
        );
        event.persisted = true;
      }
      this.db
        .prepare(
          "DELETE FROM security_audit WHERE sequence <= COALESCE((SELECT MAX(sequence) - ? FROM security_audit), 0)",
        )
        .run(MAX_AUDIT_ROWS);
    });
  },

  getHouseholdSettings(householdId) {
    const row = this.db.prepare("SELECT * FROM household_settings WHERE household_id = ?").get(householdId);
    return row ? { revision: row.revision, keyEpoch: row.key_epoch, ciphertext: Buffer.from(row.ciphertext), digest: row.digest, updatedAt: row.updated_at } : null;
  },

  putHouseholdSettings(householdId, expectedRevision, value) {
    return this.transaction(() => {
      const current = this.getHouseholdSettings(householdId);
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new DurableConflictError("household_settings_stale", "Household settings changed on another device. Reload and try again.");
      this.db.prepare(`INSERT INTO household_settings
        (household_id, revision, key_epoch, ciphertext, digest, updated_by_member_id, updated_by_device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(household_id) DO UPDATE SET revision=excluded.revision, key_epoch=excluded.key_epoch,
          ciphertext=excluded.ciphertext, digest=excluded.digest, updated_by_member_id=excluded.updated_by_member_id,
          updated_by_device_id=excluded.updated_by_device_id, updated_at=excluded.updated_at`)
        .run(householdId, expectedRevision + 1, value.keyEpoch, value.ciphertext, value.digest, value.memberId, value.deviceId, value.updatedAt);
      return expectedRevision + 1;
    });
  },
};
