// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
import { PairingService } from "../../../server/pairing-service.mjs";
import { EncryptedSyncService } from "../../../server/sync-service.mjs";
const now = () => 1_000_000;
const service = new PairingService({ now });
const sync = new EncryptedSyncService(service, { now });
const adult = service.bootstrap({ credential: { id: "cred-a", publicKey: "k", algorithm: -7 }, deviceLabel: "Ana's phone" });
const memberId = "c".repeat(32), deviceId = "d".repeat(32);
service.members.set(memberId, { id: memberId, householdId: adult.householdId, active: true, kind: "temporary", expiresAt: 2_000_000, credentials: new Set() });
service.households.get(adult.householdId).members.add(memberId);
service.devices.set(deviceId, { id: deviceId, householdId: adult.householdId, memberId, label: "Babysitter phone", trustedAt: 1, revokedAt: null, tokenHash: null });
const temp = service.issueSession(memberId, deviceId);
console.log("before:", sync.status(adult.sessionToken).enabled);
console.log("temporary enable ->", sync.enable(temp.sessionToken));
console.log("adult sees enabled:", sync.status(adult.sessionToken).enabled);
console.log("temporary sees directory kinds:", sync.deviceDirectory(temp.sessionToken).map(d => [d.memberKind, d.memberExpiresAt ?? null]));
