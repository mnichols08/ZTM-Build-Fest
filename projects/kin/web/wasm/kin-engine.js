import {
  asBytes,
  assertCivilDate,
  assertTimestamp,
  idToHex,
  KinEngineError,
  MAX_EVENT_COUNT,
  MAX_ITEM_TEXT_BYTES,
  MAX_PROTOCOL_BYTES,
  MAX_STEP_TEXT_BYTES,
  MAX_STEP_TEXT_CHARS,
  PROTOCOL_VERSION,
  PULSE_VALUES,
  readAscii,
  ROUTINE_CADENCES,
  strictTextDecoder,
} from "./wire.js";
import { decodeProjection } from "./projection-decode.js";
import { HistoryMirror } from "./history-mirror.js";

export { idToHex, KinEngineError };

const REQUEST_HEADER_BYTES = 64;
export const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
export const MAX_LOGICAL_TIME = 9_007_199_254_740_991n;
const textEncoder = new TextEncoder();

const USER_MESSAGES = new Map([
  [1, "Kin could not safely access its household engine. Try again."],
  [
    2,
    "Kin could not read that household event. Your saved information was not deleted.",
  ],
  [
    3,
    "Kin needs a compatible household engine. Your saved information was not deleted.",
  ],
  [
    4,
    "That household change is not valid. Review its current state and try again.",
  ],
  [
    5,
    "Kin has reached a supported storage limit. Your saved information was not deleted.",
  ],
  [
    6,
    "Kin could not complete that action. Your saved information was not deleted.",
  ],
]);

// The exports of the most recently created engine. The module-level
// eventMetadata()/eventMetadataBatch() below use it, for callers that have no
// engine object at hand (snapshot helpers in storage). An EventStore passes
// its own engine instead (event-store.js appendRows). Disposing the engine
// that is current clears it, and those helpers then throw until another
// engine is created; avoid making short-lived engines while a store is open.
let sharedCodec = null;

export async function loadKinEngine(
  wasmUrl = new URL("./kin_engine.wasm", import.meta.url),
) {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new KinEngineError(
      6,
      "Kin could not load its household engine. Check the local WASM build and try again.",
    );
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return createEngine(instance.exports);
}

/** Wraps instantiated engine exports in the host API. Exposed separately so
 * Node tests can exercise ABI ownership against a substitute export table. */
export function createEngine(instanceExports) {
  let exports = instanceExports;
  const requiredExports = [
    "memory",
    "kin_alloc",
    "kin_free",
    "kin_history_reset",
    "kin_history_append",
    "kin_history_truncate",
    "kin_project",
    "kin_event_metadata",
    "kin_event_metadata_batch",
    "kin_encode_command",
    "kin_execute",
    "kin_encode_archive",
    "kin_decode_archive",
    "kin_archive_header",
    "kin_archive_layout",
    "kin_plan_import",
    "kin_clear",
    "kin_result_ptr",
    "kin_result_len",
    "kin_error_ptr",
    "kin_error_len",
  ];
  if (
    requiredExports.some((name) => !(name in exports)) ||
    !(exports.memory instanceof WebAssembly.Memory)
  ) {
    throw new KinEngineError(6, "Kin loaded an incompatible household engine.");
  }

  sharedCodec = exports;
  // The last state this engine decoded from a stamped projection. Each new
  // replay or command reuses its unchanged sections (projection-decode.js),
  // so states share those arrays; decoded states are never mutated.
  // applyEvents and executeCommand advance it. planImport (unstamped, always
  // decoded in full) and projectionBytes (no decode) do not; skipping an
  // update is always safe, it only means less reuse next time. A decode that
  // throws leaves the previous state in place for the same reason.
  let lastState = null;
  const decoded = (state) => (lastState = state);
  // What the instance's own history holds; replays and commands bring it up
  // to date with only the records that changed (history-mirror.js).
  const mirror = new HistoryMirror(
    exports,
    (batch) => callCore(exports, "kin_history_append", batch, { statusOnly: true }),
    asBytes,
  );
  return {
    dispose() {
      if (exports) {
        exports.kin_clear();
        mirror.forget();
        if (sharedCodec === exports) sharedCodec = null;
        exports = null;
        lastState = null;
      }
    },
    eventMetadata: (bytes) =>
      decodeMetadata(callCore(exports, "kin_event_metadata", asBytes(bytes))),
    eventMetadataBatch: (records) => metadataBatch(exports, records),
    executeCommand: (
      command,
      identity,
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) => {
      const result = executeCommand(
        exports,
        mirror,
        command,
        identity,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
        lastState,
      );
      decoded(result.state);
      return result;
    },
    encodeArchive: (metadata, ciphertext) =>
      encodeArchive(exports, metadata, ciphertext),
    decodeArchive: (bytes) => decodeArchive(exports, bytes),
    planImport: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      planImport(
        exports,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
      ),
    applyEvents: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      decoded(applyEvents(
        exports,
        mirror,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
        lastState,
      )),
    // The exact protocol-24 projection bytes, for equivalence checks that must
    // compare encodings rather than decoded objects. The section revisions in
    // these bytes depend on this engine's earlier calls, so two calls compare
    // equal only with nothing changed in between. This call moves Rust's
    // comparison basis but not `lastState`; the next decode stays correct
    // because a changed section always gets a new revision.
    projectionBytes: (
      records,
      asOf,
      cursorEventId = null,
      civilDate,
      syncIdentity = null,
    ) =>
      replayBytes(exports, mirror, records, asOf, cursorEventId, civilDate, syncIdentity),
  };
}

export function randomId() {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  return id;
}

export function idFromHex(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new KinEngineError(4, "Kin received an invalid household reference.");
  }
  const id = new Uint8Array(16);
  for (let index = 0; index < id.length; index += 1) {
    id[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return id;
}

// Compatibility helpers encode intent packets; Rust alone writes event bytes.
export const encodeAddedRecord = (value) => encodeIntent("add", value);
export const encodeCompletedRecord = (value) => encodeIntent("complete", value);
export const encodeReopenedRecord = (value) => encodeIntent("reopen", value);
export const encodeArchivedRecord = (value) => encodeIntent("archive", value);
export const encodeHandoffAddedRecord = (value) =>
  encodeIntent("add-handoff", value);
export const encodeHandoffAcknowledgedRecord = (value) =>
  encodeIntent("acknowledge-handoff", value);
export const encodeHandoffArchivedRecord = (value) =>
  encodeIntent("archive-handoff", value);
export const encodeTalkAddedRecord = (value) => encodeIntent("add-talk", value);
export const encodeTalkResolvedRecord = (value) =>
  encodeIntent("resolve-talk", value);
export const encodeTalkReopenedRecord = (value) =>
  encodeIntent("reopen-talk", value);
export const encodeTalkArchivedRecord = (value) =>
  encodeIntent("archive-talk", value);
export const encodePulseSetRecord = (value) => encodeIntent("set-pulse", value);
export const encodePulseClearedRecord = (value) =>
  encodeIntent("clear-pulse", value);
export const encodeRoutineCreatedRecord = (value) =>
  encodeIntent("create-routine", value);
export const encodeRoutineActionRecord = (value) =>
  encodeIntent(
    {
      complete: "complete-routine-occurrence",
      reopen: "reopen-routine-occurrence",
      archive: "archive-routine",
    }[value.action],
    value,
  );
export const encodeNoteCreatedRecord = (value) => encodeIntent("create-note", value);
export const encodeNoteUpdatedRecord = (value) => encodeIntent("update-note", value);
export const encodeNoteArchivedRecord = (value) => encodeIntent("archive-note", value);
export const encodeHouseholdModeRecord = (value) =>
  encodeIntent("set-household-mode", value);
export const encodeItemPlanningDateRecord = (value) =>
  encodeIntent("set-item-planning-date", value);
export const eventMetadata = (bytes) =>
  decodeMetadata(callCore(sharedCodec, "kin_event_metadata", asBytes(bytes)));
export const eventMetadataBatch = (records) =>
  metadataBatch(sharedCodec, records);

const COMMAND_TYPES = [
  null,
  "add",
  "complete",
  "reopen",
  "archive",
  "add-handoff",
  "acknowledge-handoff",
  "archive-handoff",
  "add-talk",
  "resolve-talk",
  "reopen-talk",
  "archive-talk",
  "set-pulse",
  "clear-pulse",
  "create-routine",
  "complete-routine-occurrence",
  "reopen-routine-occurrence",
  "archive-routine",
  "create-area",
  "rename-area",
  "archive-area",
  "change-item-area",
  "create-note",
  "update-note",
  "archive-note",
  "add-item-step",
  "complete-item-step",
  "reopen-item-step",
  "archive-item-step",
  "set-household-mode",
  "set-item-planning-date",
  "pin",
  "unpin",
  "save-playbook",
  "archive-playbook",
  "save-reference-record",
  "archive-reference-record",
  "save-maintenance-event",
  "archive-maintenance-event",
  "bind-attachment",
  "remove-attachment",
  "change-responsibility",
];
const EVENT_KINDS = [
  null,
  "ITEM_ADDED",
  "ITEM_COMPLETED",
  "ITEM_REOPENED",
  "ITEM_ARCHIVED",
  "HANDOFF_ADDED",
  "HANDOFF_ACKNOWLEDGED",
  "HANDOFF_ARCHIVED",
  "TALK_ADDED",
  "TALK_RESOLVED",
  "TALK_REOPENED",
  "TALK_ARCHIVED",
  "PULSE_SET",
  "PULSE_CLEARED",
  "ROUTINE_CREATED",
  "ROUTINE_OCCURRENCE_COMPLETED",
  "ROUTINE_OCCURRENCE_REOPENED",
  "ROUTINE_ARCHIVED",
  "AREA_CREATED",
  "AREA_RENAMED",
  "AREA_ARCHIVED",
  "ITEM_AREA_CHANGED",
  "NOTE_CREATED",
  "NOTE_UPDATED",
  "NOTE_ARCHIVED",
  "ITEM_STEP_ADDED",
  "ITEM_STEP_COMPLETED",
  "ITEM_STEP_REOPENED",
  "ITEM_STEP_ARCHIVED",
  "HOUSEHOLD_MODE_CHANGED",
  "ITEM_PLANNING_DATE_CHANGED",
  "PIN_ADDED",
  "PIN_REMOVED",
  "PLAYBOOK_SAVED",
  "PLAYBOOK_ARCHIVED",
  "REFERENCE_RECORD_SAVED",
  "REFERENCE_RECORD_ARCHIVED",
  "MAINTENANCE_EVENT_SAVED",
  "MAINTENANCE_EVENT_ARCHIVED",
  "ATTACHMENT_BOUND",
  "ATTACHMENT_REMOVED",
  "RESPONSIBILITY_CHANGED",
];

function encodeIntent(type, value) {
  return callCore(
    sharedCodec,
    "kin_encode_command",
    encodeIntentPacket({ ...value, type }, value),
  );
}

function encodeIntentPacket(command, identity) {
  const kind = COMMAND_TYPES.indexOf(command.type);
  if (kind < 1)
    throw new KinEngineError(2, "Kin received an invalid household action.");
  const hasText = [1, 5, 8, 14, 18, 19].includes(kind);
  const text = hasText ? (command.name ?? command.text) : "";
  const stepText = kind === 25 ? textEncoder.encode(command.text ?? "") : null;
  if (
    kind === 25 &&
    (typeof command.text !== "string" ||
      strictTextDecoder.decode(stepText) !== command.text ||
      command.text.trim() !== command.text ||
      [...command.text].length < 1 ||
      [...command.text].length > MAX_STEP_TEXT_CHARS ||
      stepText.length > MAX_STEP_TEXT_BYTES ||
      [...command.text].some((character) => /\p{Cc}/u.test(character)))
  ) {
    throw new KinEngineError(2, "Step text must be short plain text.");
  }
  const noteTitle = kind === 22 || kind === 23 ? textEncoder.encode(command.title ?? "") : null;
  const noteBody = kind === 22 || kind === 23 ? textEncoder.encode(command.body ?? "") : null;
  if ((kind === 22 || kind === 23) && (typeof command.title !== "string" || typeof command.body !== "string" || strictTextDecoder.decode(noteTitle) !== command.title || strictTextDecoder.decode(noteBody) !== command.body || noteTitle.length > 256 || noteBody.length > 4096))
    throw new KinEngineError(2, "Note text must be valid Unicode and within its supported size.");
  const textBytes = textEncoder.encode(text);
  const playbookBytes = kind === 33 ? encodePlaybookPayload(command) : null;
  const referenceBytes = kind === 35 ? encodeReferencePayload(command) : null;
  const maintenanceBytes = kind === 37 ? encodeMaintenancePayload(command) : null;
  if (
    hasText &&
    (typeof text !== "string" ||
      strictTextDecoder.decode(textBytes) !== text ||
      textBytes.length < 1 ||
      textBytes.length > ([18, 19].includes(kind) ? 96 : MAX_ITEM_TEXT_BYTES))
  ) {
    throw new KinEngineError(
      2,
      "Text must be valid Unicode and no more than 4096 UTF-8 bytes.",
    );
  }
  const stepAction = kind >= 25 && kind <= 28;
  const packet = new Uint8Array(
    128 +
      (kind === 21 || (stepAction && kind !== 25)
        ? 16
        : kind === 25
          ? 16 + stepText.length
          : kind === 22 || kind === 23
            ? 24 + noteTitle.length + noteBody.length
            : kind === 33 ? playbookBytes.length : kind === 35 ? referenceBytes.length : kind === 37 ? maintenanceBytes.length : kind === 39 || kind === 41 ? 16 : textBytes.length),
  );
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  const view = new DataView(packet.buffer);
  view.setUint16(8, kind, true);
  for (const [name, offset] of [
    ["eventId", 12],
    ["householdId", 28],
    ["actorId", 44],
    ["deviceId", 60],
  ]) {
    packet.set(
      typeof identity[name] === "string"
        ? idFromHex(identity[name])
        : assertId(identity[name]),
      offset,
    );
  }
  assertTimestamp(identity.timestamp);
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n || logicalTime > MAX_LOGICAL_TIME)
    throw new KinEngineError(2, "Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  if (![12, 13, 29].includes(kind)) {
    const entity =
      command.stepId ??
      command.itemId ??
      command.handoffId ??
      command.talkId ??
      command.routineId ??
      command.areaId ??
      command.noteId ??
      command.playbookId ??
      command.maintenanceId ??
      command.recordId ??
      command.targetId ??
      command.id ??
      identity.entityId;
    packet.set(
      typeof entity === "string" ? idFromHex(entity) : assertId(entity),
      92,
    );
  }
  if ([14, 15, 16, 30].includes(kind)) {
    const date = kind === 14
      ? command.createdOn
      : kind === 30
        ? command.planningDate
        : command.occurrenceKey;
    if (kind === 30 && date === null) {
      view.setUint32(108, 0, true);
    } else {
      assertCivilDate(date);
      view.setUint32(108, date, true);
    }
  }
  if (kind === 1) {
    const code = ["today", "need", "shopping", "staple"].indexOf(command.classification ?? "need");
    if (code < 0) throw new KinEngineError(2, "Choose a valid list.");
    packet[112] = code;
  } else if (kind === 12) {
    const code = PULSE_VALUES.indexOf(command.value);
    if (code < 0) throw new KinEngineError(2, "Choose a valid capacity.");
    packet[112] = code;
    assertTimestamp(command.expiresAt);
    view.setBigInt64(116, BigInt(command.expiresAt), true);
  } else if (kind === 14) {
    const code = ROUTINE_CADENCES.indexOf(command.cadence);
    if (code < 0) throw new KinEngineError(2, "Choose a valid cadence.");
    packet[112] = code;
  } else if (kind === 29) {
    const code = ["normal", "vacation", "guests", "rest"].indexOf(command.mode);
    if (code < 0) throw new KinEngineError(2, "Choose a valid household mode.");
    packet[112] = code;
  } else if (kind === 31 || kind === 32) {
    const code = ["", "item", "note", "routine", "area"].indexOf(command.targetKind);
    if (code < 1) throw new KinEngineError(2, "Choose a valid Pin target.");
    packet[112] = code;
  } else if (kind === 39) {
    const code = ["", "note", "reference-record", "maintenance", "item"].indexOf(command.parentKind);
    if (code < 1 || !/^[a-f0-9]{32}$/.test(command.parentId ?? "")) throw new KinEngineError(2, "Choose a valid attachment parent.");
    packet[112] = code;
    packet.set(idFromHex(command.parentId), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 41) {
    const targetKind = ["", "item", "routine"].indexOf(command.targetKind);
    if (targetKind < 1 || (command.memberId !== null && !/^[a-f0-9]{32}$/.test(command.memberId ?? ""))) throw new KinEngineError(2, "Choose a household member.");
    packet[112] = targetKind;
    packet.set(command.memberId ? idFromHex(command.memberId) : new Uint8Array(16), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 33) {
    packet.set(playbookBytes, 128);
    view.setUint32(124, playbookBytes.length, true);
  } else if (kind === 35) {
    packet.set(referenceBytes, 128);
    view.setUint32(124, referenceBytes.length, true);
  } else if (kind === 37) {
    packet.set(maintenanceBytes, 128);
    view.setUint32(124, maintenanceBytes.length, true);
  }
  if (kind === 22 || kind === 23) {
    packet.set(command.areaId ? idFromHex(command.areaId) : new Uint8Array(16), 128);
    view.setUint32(144, noteTitle.length, true); view.setUint32(148, noteBody.length, true);
    packet.set(noteTitle, 152); packet.set(noteBody, 152 + noteTitle.length);
    view.setUint32(124, 24 + noteTitle.length + noteBody.length, true);
  } else if (kind === 21) {
    packet.set(command.areaId ? idFromHex(command.areaId) : new Uint8Array(16), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 25) {
    packet.set(idFromHex(command.itemId), 128);
    packet.set(stepText, 144);
    view.setUint32(124, 16 + stepText.length, true);
  } else if (stepAction) {
    packet.set(idFromHex(command.itemId), 128);
    view.setUint32(124, 16, true);
  } else if (kind === 33 || kind === 35 || kind === 37 || kind === 39 || kind === 41) {
    // The Playbook packet payload was encoded above.
  } else {
    view.setUint32(124, textBytes.length, true);
    packet.set(textBytes, 128);
  }
  return packet;
}

function encodeMaintenancePayload(command) {
  const summary = textEncoder.encode(command.summary ?? "");
  if (typeof command.summary !== "string" || summary.length < 1 || summary.length > 240 || strictTextDecoder.decode(summary) !== command.summary || command.summary.trim() !== command.summary || [...command.summary].some((character) => /\p{Cc}/u.test(character)))
    throw new KinEngineError(2, "Add a short maintenance note.");
  assertCivilDate(command.performedOn);
  if (command.nextOn != null) {
    assertCivilDate(command.nextOn);
    if (command.nextOn < command.performedOn) throw new KinEngineError(2, "The next date must be on or after the performed date.");
  }
  const bytes = new Uint8Array(42 + summary.length), view = new DataView(bytes.buffer);
  bytes.set(idFromHex(command.recordId), 0);
  view.setUint32(16, command.performedOn, true);
  view.setUint32(20, command.nextOn ?? 0, true);
  bytes.set(command.routineId ? idFromHex(command.routineId) : new Uint8Array(16), 24);
  view.setUint16(40, summary.length, true); bytes.set(summary, 42);
  return bytes;
}

function encodeReferencePayload(command) {
  if (typeof command.title !== "string" || !Array.isArray(command.fields) || command.fields.length < 1 || command.fields.length > 16)
    throw new KinEngineError(2, "A reference record needs a title and one to sixteen fields.");
  const title = textEncoder.encode(command.title.trim());
  const fields = command.fields.map((field) => {
    if (typeof field.label !== "string" || typeof field.value !== "string") throw new KinEngineError(2, "Reference field labels and values must be text.");
    const labelText = field.label.trim();
    return { id: idFromHex(field.fieldId), labelText, label: textEncoder.encode(labelText), valueText: field.value, value: textEncoder.encode(field.value) };
  });
  if (strictTextDecoder.decode(title) !== command.title.trim() || !title.length || title.length > 128 || fields.some((field) => strictTextDecoder.decode(field.label) !== field.labelText || strictTextDecoder.decode(field.value) !== field.valueText || !field.label.length || field.label.length > 64 || field.value.length > 1024))
    throw new KinEngineError(2, "Reference record text is outside its supported size.");
  const size = 36 + title.length + fields.reduce((sum, field) => sum + 20 + field.label.length + field.value.length, 0);
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  bytes.set(command.areaId ? idFromHex(command.areaId) : new Uint8Array(16), 16);
  view.setUint16(32, title.length, true); bytes[34] = fields.length;
  let offset = 36; bytes.set(title, offset); offset += title.length;
  for (const field of fields) { bytes.set(field.id, offset); view.setUint16(offset + 16, field.label.length, true); view.setUint16(offset + 18, field.value.length, true); offset += 20; bytes.set(field.label, offset); offset += field.label.length; bytes.set(field.value, offset); offset += field.value.length; }
  return bytes;
}

function encodePlaybookPayload(command) {
  if (typeof command.title !== "string" || !Array.isArray(command.entries) || command.entries.length < 1 || command.entries.length > 16)
    throw new KinEngineError(2, "A Playbook needs a title and one to sixteen entries.");
  const title = textEncoder.encode(command.title.trim());
  const entries = command.entries.map((entry) => textEncoder.encode(String(entry).trim()));
  if (title.length < 1 || title.length > 128 || entries.some((entry) => entry.length < 1 || entry.length > 256))
    throw new KinEngineError(2, "Playbook text is outside its supported size.");
  const size = 4 + title.length + entries.reduce((sum, entry) => sum + 2 + entry.length, 0);
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  view.setUint16(0, title.length, true); bytes[2] = entries.length; bytes[3] = 0;
  let offset = 4; bytes.set(title, offset); offset += title.length;
  for (const entry of entries) { view.setUint16(offset, entry.length, true); offset += 2; bytes.set(entry, offset); offset += entry.length; }
  return bytes;
}

// KMET v1, 92 bytes (ABI.md): "KMET", version u16, reserved u16, then
// event ID @8, household @24, actor @40, device @56 (16 bytes each),
// timestamp i64 @72, logical time u64 @80, event version u16 @88, kind u16 @90.
function decodeMetadata(bytes) {
  if (bytes.length !== 92 || readAscii(bytes, 0, 4) !== "KMET")
    throw new KinEngineError(6, "Kin received invalid event metadata.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0)
    throw new KinEngineError(6, "Kin received unsupported event metadata.");
  const kind = EVENT_KINDS[view.getUint16(90, true)];
  if (!kind)
    throw new KinEngineError(6, "Kin received unsupported event metadata.");
  const timestamp = Number(view.getBigInt64(72, true));
  if (!Number.isSafeInteger(timestamp))
    throw new KinEngineError(6, "Kin received an invalid event timestamp.");
  const logicalTime = view.getBigUint64(80, true);
  if (logicalTime > MAX_LOGICAL_TIME)
    throw new KinEngineError(4, USER_MESSAGES.get(4));
  return {
    eventId: bytes.slice(8, 24),
    householdId: bytes.slice(24, 40),
    actorId: bytes.slice(40, 56),
    deviceId: bytes.slice(56, 72),
    timestamp,
    logicalTime,
    eventVersion: view.getUint16(88, true),
    kind,
  };
}

function metadataBatch(exports, records) {
  if (!Array.isArray(records) || records.length > MAX_EVENT_COUNT)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const sources = records.map(asBytes);
  const length = sources.reduce((total, bytes) => total + 4 + bytes.length, 12);
  if (length > MAX_PROTOCOL_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = new Uint8Array(length);
  request.set([...textEncoder.encode("KMDQ"), 1, 0, 0, 0]); // magic, version 1, reserved
  const view = new DataView(request.buffer);
  view.setUint32(8, sources.length, true);
  let offset = 12;
  for (const source of sources) {
    view.setUint32(offset, source.length, true);
    request.set(source, offset + 4);
    offset += 4 + source.length;
  }
  const output = callCore(exports, "kin_event_metadata_batch", request);
  if (
    output.length !== 12 + 92 * sources.length ||
    readAscii(output, 0, 4) !== "KMDL"
  )
    throw new KinEngineError(6, "Kin received invalid batch metadata.");
  const resultView = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  if (
    resultView.getUint16(4, true) !== 1 ||
    resultView.getUint16(6, true) !== 0 ||
    resultView.getUint32(8, true) !== sources.length
  )
    throw new KinEngineError(6, "Kin received invalid batch metadata.");
  return sources.map((_, index) =>
    decodeMetadata(output.subarray(12 + 92 * index, 12 + 92 * (index + 1))),
  );
}

function executeCommand(
  exports,
  mirror,
  command,
  identity,
  records,
  asOf,
  cursor,
  civilDate,
  syncIdentity,
  previous,
) {
  const intent = encodeIntentPacket(
    {
      ...command,
      // Rust requires a new Routine's creation date to equal the request's
      // civil date, so the bridge fills it from the same value.
      ...(command.type === "create-routine" ? { createdOn: civilDate } : {}),
    },
    identity,
  );
  // Request layout: u32 intent length, the KCMD intent, then a record-less
  // KINE request giving the replay context; Rust validates the command
  // against the history the instance holds, brought up to date first. The
  // KCMT result is a 20-byte header ("KCMT", version, reserved, then event,
  // metadata and projection lengths as u32 @8, @12, @16) followed by those
  // three buffers.
  if (!exports) throw new KinEngineError(6, "Unlock Kin before using its household engine.");
  if (records.length > MAX_EVENT_COUNT) throw new KinEngineError(5, USER_MESSAGES.get(5));
  const request = encodeRequest([], asOf, cursor, civilDate, syncIdentity, 4 + intent.length);
  new DataView(request.buffer).setUint32(0, intent.length, true);
  request.set(intent, 4);
  const release = mirror.hold(records);
  let bytes;
  try {
    bytes = callCore(exports, "kin_execute", request);
  } finally {
    release();
  }
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "KCMT")
    throw new KinEngineError(6, "Kin received an invalid command result.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eventLength = view.getUint32(8, true),
    metadataLength = view.getUint32(12, true),
    stateLength = view.getUint32(16, true);
  if (
    view.getUint16(4, true) !== 1 ||
    view.getUint16(6, true) !== 0 ||
    20 + eventLength + metadataLength + stateLength !== bytes.length
  )
    throw new KinEngineError(6, "Kin received an invalid command result.");
  return {
    encodedEvent: bytes.slice(20, 20 + eventLength),
    metadata: decodeMetadata(
      bytes.subarray(20 + eventLength, 20 + eventLength + metadataLength),
    ),
    state: safeDecode(() => decodeProjection(bytes.subarray(20 + eventLength + metadataLength), { previous, stampedBy: exports })),
  };
}

function encodeArchive(exports, metadata, ciphertext) {
  metadata = asBytes(metadata);
  ciphertext = asBytes(ciphertext);
  if (metadata.length + ciphertext.length + 16 > MAX_ARCHIVE_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const lengths = new Uint8Array(8);
  const view = new DataView(lengths.buffer);
  view.setUint32(0, metadata.length, true);
  view.setUint32(4, ciphertext.length, true);
  const header = callCore(exports, "kin_archive_header", lengths);
  if (header.length !== 16)
    throw new KinEngineError(6, "Kin received an invalid archive header.");
  const bytes = new Uint8Array(16 + metadata.length + ciphertext.length);
  bytes.set(header);
  bytes.set(metadata, 16);
  bytes.set(ciphertext, 16 + metadata.length);
  return bytes;
}
function planImport(exports, records, asOf, cursor, civilDate, syncIdentity) {
  const bytes = callCore(
    exports,
    "kin_plan_import",
    encodeRequest(records, asOf, cursor, civilDate, syncIdentity),
  );
  if (bytes.length < 24 || readAscii(bytes, 0, 4) !== "KIMP")
    throw new KinEngineError(6, "Kin received an invalid import plan.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint16(4, true) !== 1 ||
    view.getUint16(6, true) !== 0 ||
    view.getUint32(20, true) + 24 !== bytes.length
  )
    throw new KinEngineError(6, "Kin received an invalid import plan.");
  return {
    eventCount: view.getUint32(8, true),
    nextLogicalTime: view.getBigUint64(12, true),
    state: decodeProjection(bytes.subarray(24)),
  };
}
function decodeArchive(exports, bytes) {
  bytes = asBytes(bytes);
  if (bytes.length > MAX_ARCHIVE_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  if (bytes.length < 16)
    throw new KinEngineError(2, USER_MESSAGES.get(2));
  const request = new Uint8Array(20);
  request.set(bytes.subarray(0, 16));
  new DataView(request.buffer).setUint32(16, bytes.length, true);
  const output = callCore(exports, "kin_archive_layout", request);
  if (output.length !== 8)
    throw new KinEngineError(6, "Kin received an invalid archive result.");
  const length = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  ).getUint32(0, true);
  const ciphertextLength = new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(4, true);
  if (16 + length + ciphertextLength !== bytes.length)
    throw new KinEngineError(6, "Kin received an invalid archive result.");
  return {
    version: 1,
    // These copies deliberately detach caller-owned archive input before any
    // asynchronous authentication; no view escapes into mutable source bytes.
    metadata: bytes.slice(16, 16 + length),
    ciphertext: bytes.slice(16 + length),
  };
}

// `statusOnly`: the operation publishes no result on success
// (kin_history_append); only a failure's KERR buffer is read.
function callCore(exports, operation, request, { statusOnly = false } = {}) {
  if (!exports)
    throw new KinEngineError(
      6,
      "Unlock Kin before using its household engine.",
    );
  if (request.length > MAX_PROTOCOL_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const pointer = exports.kin_alloc(request.length);
  if (!pointer) throw new KinEngineError(5, USER_MESSAGES.get(5));
  // Every exit, including a throwing copy, operation or decode, releases the
  // input allocation exactly once. A free failure only surfaces on success so
  // it never masks the original error.
  let completed = false;
  try {
    new Uint8Array(exports.memory.buffer, pointer, request.length).set(request);
    const status = exports[operation](pointer, request.length);
    if (status === 0 && statusOnly) {
      completed = true;
      return null;
    }
    const bytes =
      status === 0
        ? copyWasmBytes(
            exports.memory,
            exports.kin_result_ptr(),
            exports.kin_result_len(),
          )
        : copyWasmBytes(
            exports.memory,
            exports.kin_error_ptr(),
            exports.kin_error_len(),
          );
    if (status !== 0) throw decodeError(bytes, status);
    completed = true;
    return bytes;
  } finally {
    const freed = exports.kin_free(pointer, request.length);
    if (freed !== 0 && completed)
      throw new KinEngineError(1, USER_MESSAGES.get(1));
  }
}

// The KINS projection of `records` (a history view, a historyWith() result
// or an array): the instance's history is brought up to date, then replayed
// in the context of a record-less KINE request.
function replayBytes(exports, mirror, records, asOf, cursorEventId, civilDate, syncIdentity) {
  if (!exports)
    throw new KinEngineError(
      6,
      "Unlock Kin before using its household engine.",
    );
  if (records.length > MAX_EVENT_COUNT) {
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  }
  const context = encodeRequest([], asOf, cursorEventId, civilDate, syncIdentity);
  const release = mirror.hold(records);
  try {
    return callCore(exports, "kin_project", context);
  } finally {
    release();
  }
}

function applyEvents(
  exports,
  mirror,
  records,
  asOf,
  cursorEventId,
  civilDate,
  syncIdentity,
  previous,
) {
  return safeDecode(() => decodeProjection(
    replayBytes(exports, mirror, records, asOf, cursorEventId, civilDate, syncIdentity),
    { previous, stampedBy: exports },
  ));
}

// Any unexpected error while producing a state becomes a code-6 engine error,
// so callers always get a `code` and a safe message.
function safeDecode(decode) {
  try {
    return decode();
  } catch (error) {
    if (error instanceof KinEngineError) throw error;
    throw new KinEngineError(
      6,
      "Kin could not complete a household-engine operation.",
    );
  }
}

/**
 * Builds a protocol-24 KINE request. `records` is an array of canonical event
 * byte arrays, or a contiguous source exposing `length`, `byteLength` and
 * `copyTo(target, offset)` (the session event arena), which is copied in one
 * operation. `reserve` leaves that many leading bytes free for a caller prefix
 * so the history is never copied a second time.
 */
function encodeRequest(
  records,
  asOf,
  cursorEventId,
  civilDate,
  syncIdentity,
  reserve = 0,
) {
  assertTimestamp(asOf);
  assertCivilDate(civilDate);
  // Identity bindings map pre-sync placeholder IDs to the authenticated ones
  // (96 bytes each, at most 256). rust/src/request.rs documents the KINE
  // layout these offsets follow; docs/IDENTITY.md explains the bindings.
  const identityBindings = syncIdentity?.bindings ?? [];
  if (
    syncIdentity &&
    (!Array.isArray(identityBindings) || identityBindings.length > 256)
  ) {
    throw new KinEngineError(2, "Kin received invalid sync identity context.");
  }
  const contiguous = typeof records?.copyTo === "function";
  const headerBytes = REQUEST_HEADER_BYTES + identityBindings.length * 96;
  let length = headerBytes;
  if (contiguous) {
    length += records.byteLength;
  } else {
    for (const record of records) {
      length += asBytes(record).length;
      if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_BYTES) break;
    }
  }
  if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_BYTES) {
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  }

  const bytes = new Uint8Array(reserve + length);
  const view = new DataView(bytes.buffer, reserve);
  bytes.set([0x4b, 0x49, 0x4e, 0x45], reserve);
  view.setUint16(4, PROTOCOL_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, records.length, true);
  view.setBigInt64(12, BigInt(asOf), true);
  if (cursorEventId !== null) {
    const cursor =
      typeof cursorEventId === "string"
        ? idFromHex(cursorEventId)
        : assertId(cursorEventId);
    bytes[reserve + 20] = 1;
    bytes.set(cursor, reserve + 24);
  }
  view.setUint32(40, civilDate, true);
  if (syncIdentity) {
    bytes.set(idFromHex(syncIdentity.householdId), reserve + 44);
    view.setUint16(60, identityBindings.length, true);
    let bindingOffset = reserve + 64;
    for (const binding of identityBindings) {
      for (const id of [
        binding.legacyHouseholdId,
        binding.legacyActorId,
        binding.legacyDeviceId,
        binding.householdId,
        binding.actorId,
        binding.deviceId,
      ]) {
        bytes.set(idFromHex(id), bindingOffset);
        bindingOffset += 16;
      }
    }
  }
  let offset = reserve + headerBytes;
  if (contiguous) {
    records.copyTo(bytes, offset);
  } else {
    for (const record of records) {
      const eventBytes = asBytes(record);
      bytes.set(eventBytes, offset);
      offset += eventBytes.length;
    }
  }
  return bytes;
}

// Stage-level access for the performance harness; production callers use the
// engine API above.
export { encodeRequest as encodeReplayRequest, decodeProjection };

// Copies a published result or error out of WASM memory. Every result and
// error format starts with a magic header, so an empty buffer is invalid.
function copyWasmBytes(memory, pointer, length) {
  const start = Number(pointer);
  const size = Number(length);
  const end = start + size;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start <= 0 ||
    size <= 0 ||
    end > memory.buffer.byteLength
  ) {
    throw new KinEngineError(
      6,
      "Kin received an invalid buffer from its household engine.",
    );
  }
  return new Uint8Array(memory.buffer, start, size).slice();
}

function decodeError(bytes, status) {
  if (bytes.length < 12 || readAscii(bytes, 0, 4) !== "KERR") {
    return new KinEngineError(6, USER_MESSAGES.get(6));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const code = view.getUint16(6, true);
  const messageLength = view.getUint32(8, true);
  if (version !== 1 || code !== status || bytes.length !== 12 + messageLength) {
    return new KinEngineError(6, USER_MESSAGES.get(6));
  }
  return new KinEngineError(
    status,
    USER_MESSAGES.get(code) ?? USER_MESSAGES.get(6),
  );
}

function assertId(value) {
  const bytes = asBytes(value);
  if (bytes.length !== 16) {
    throw new KinEngineError(
      4,
      "Kin received an invalid household identifier.",
    );
  }
  return bytes;
}

