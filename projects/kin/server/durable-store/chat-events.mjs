// DurableStore chat relay (#111): encrypted chat events in their own relay
// stream. The relay never reads them; it orders them and keeps each device's
// chat sequence free of gaps (chat-relay-service.mjs has the rules).
import { canonicalEventEnvelope, isEventEnvelopeValid } from "../sync-contract.mjs";
import { DurableConflictError, DurableStoreError } from "./shared.mjs";

/** The relay cursor format (sync-service.mjs encodeCursor): an 8-byte
 * big-endian sequence, base64url. Kept here so the store doesn't import the
 * service. */
function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

function parseEnvelope(row, householdId) {
  let envelope;
  try { envelope = Object.fromEntries(JSON.parse(row.canonical_envelope)); } catch { envelope = null; }
  if (!isEventEnvelopeValid(envelope) || envelope.householdId !== householdId || envelope.eventId !== row.event_id ||
    envelope.deviceId !== row.device_id || envelope.deviceSequence !== row.device_sequence ||
    envelope.keyEpoch !== row.key_epoch || canonicalEventEnvelope(envelope) !== row.canonical_envelope) {
    const error = new DurableStoreError("Kin's stored chat history is invalid.");
    error.code = "sync_store_invalid";
    error.eventId = row.event_id;
    throw error;
  }
  return envelope;
}

export const chatEventMethods = {
  chatRelayState(householdId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT next_sequence, max_logical_time FROM chat_relay_state WHERE household_id = ?").get(householdId);
    const next = row?.next_sequence ?? 1;
    return { nextSequence: next, eventCount: next - 1, maxLogicalTime: row?.max_logical_time ?? "0" };
  },

  chatDeviceSequence(householdId, deviceId) {
    this.assertAvailable();
    return this.db.prepare("SELECT last_sequence FROM chat_device_sequences WHERE household_id = ? AND device_id = ?").get(householdId, deviceId)?.last_sequence ?? 0;
  },

  findChatEvent(householdId, eventId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT canonical_envelope AS canonical FROM chat_events WHERE household_id = ? AND event_id = ?").get(householdId, eventId);
    return row ?? null;
  },

  /** Appends a device's batch at the expected relay and device positions,
   * or fails with a conflict (another request moved them meanwhile). */
  commitChatEvents(householdId, { expectedNextSequence, deviceId, expectedDeviceSequence, entries, maxLogicalTime }) {
    this.transaction(() => {
      if (this.chatRelayState(householdId).nextSequence !== expectedNextSequence ||
        this.chatDeviceSequence(householdId, deviceId) !== expectedDeviceSequence)
        throw new DurableConflictError("chat_relay_conflict", "Chat changed meanwhile; retry.");
      const insert = this.db.prepare(`INSERT INTO chat_events
        (household_id, relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      let sequence = expectedNextSequence;
      for (const { canonical, envelope } of entries) {
        if (!isEventEnvelopeValid(envelope) || envelope.householdId !== householdId || envelope.deviceId !== deviceId ||
          canonicalEventEnvelope(envelope) !== canonical)
          throw new DurableStoreError("Kin encrypted chat data is invalid.");
        insert.run(householdId, sequence++, envelope.eventId, deviceId, envelope.deviceSequence, envelope.keyEpoch, canonical);
      }
      this.db.prepare(`INSERT INTO chat_device_sequences (household_id, device_id, last_sequence) VALUES (?, ?, ?)
        ON CONFLICT(household_id, device_id) DO UPDATE SET last_sequence = excluded.last_sequence`)
        .run(householdId, deviceId, entries.at(-1).envelope.deviceSequence);
      this.db.prepare(`INSERT INTO chat_relay_state (household_id, next_sequence, max_logical_time) VALUES (?, ?, ?)
        ON CONFLICT(household_id) DO UPDATE SET next_sequence = excluded.next_sequence, max_logical_time = excluded.max_logical_time`)
        .run(householdId, sequence, maxLogicalTime);
    });
  },

  readChatEvents(householdId, cursor, limit, minimumEpoch) {
    this.assertAvailable();
    const rows = this.db.prepare(`SELECT relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope
      FROM chat_events WHERE household_id = ? AND relay_sequence > ? ORDER BY relay_sequence LIMIT ?`).all(householdId, cursor, limit);
    const lastScanned = rows.at(-1)?.relay_sequence ?? cursor;
    const events = [];
    for (const row of rows) {
      const envelope = parseEnvelope(row, householdId);
      if (envelope.keyEpoch >= minimumEpoch) events.push({ cursor: encodeCursor(row.relay_sequence), envelope });
    }
    return {
      events,
      nextCursor: encodeCursor(lastScanned),
      hasMore: lastScanned < this.chatRelayState(householdId).nextSequence - 1,
    };
  },
};
