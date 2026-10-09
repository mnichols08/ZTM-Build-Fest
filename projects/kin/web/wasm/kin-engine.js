const PROTOCOL_VERSION = 14;
const REQUEST_HEADER_BYTES = 64;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const PULSE_VALUES = ["good", "okay", "drained", "rough-day", "need-quiet"];
const RESULT_HEADER_BYTES = 12;
const ITEM_HEADER_BYTES = 48;
const MAX_EVENT_COUNT = 10_000;
const MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;
const MAX_ITEM_TEXT_BYTES = 4096;
const MAX_STEP_TEXT_BYTES = 256;
const MAX_STEP_TEXT_CHARS = 80;
const MAX_STEPS_PER_ITEM = 16;
const MAX_SUMMARY_ENTRIES = 8;
const SUMMARY_KINDS = [
  "",
  "item-added",
  "item-completed",
  "item-reopened",
  "item-archived",
  "handoff-added",
  "handoff-acknowledged",
  "handoff-archived",
  "talk-added",
  "talk-resolved",
  "talk-reopened",
  "talk-archived",
  "routine-created",
  "routine-occurrence-completed",
  "routine-occurrence-reopened",
  "routine-archived",
];
const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export class KinEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KinEngineError";
    this.code = code;
  }
}

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
  let exports = instance.exports;
  const requiredExports = [
    "memory",
    "kin_alloc",
    "kin_free",
    "kin_apply_events",
    "kin_event_metadata",
    "kin_event_metadata_batch",
    "kin_encode_command",
    "kin_execute_command",
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
  return {
    dispose() {
      if (exports) {
        exports.kin_clear();
        if (sharedCodec === exports) sharedCodec = null;
        exports = null;
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
    ) =>
      executeCommand(
        exports,
        command,
        identity,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
      ),
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
      applyEvents(
        exports,
        records,
        asOf,
        cursorEventId,
        civilDate,
        syncIdentity,
      ),
  };
}

export function randomId() {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  return id;
}

// Wire validation only. Rust owns recurrence and current-period selection.
function assertCivilDate(value) {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    !Number.isInteger(value) ||
    year < 1 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new KinEngineError(2, "Kin requires a valid civil date.");
  }
}

function civilOrdinal(value) {
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const previousYear = year - 1;
  let days =
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400);
  const monthLengths = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  for (let index = 0; index < month - 1; index += 1) days += monthLengths[index];
  return days + (value % 100) - 1;
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

export function idToHex(value) {
  return [...asBytes(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
            : textBytes.length),
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
  if (logicalTime < 0n || logicalTime > 0xffffffffffffffffn)
    throw new KinEngineError(2, "Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  if (![12, 13].includes(kind)) {
    const entity =
      command.stepId ??
      command.itemId ??
      command.handoffId ??
      command.talkId ??
      command.routineId ??
      command.areaId ??
      command.noteId ??
      command.id ??
      identity.entityId;
    packet.set(
      typeof entity === "string" ? idFromHex(entity) : assertId(entity),
      92,
    );
  }
  if ([14, 15, 16].includes(kind)) {
    const date = kind === 14 ? command.createdOn : command.occurrenceKey;
    assertCivilDate(date);
    view.setUint32(108, date, true);
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
    const code = ["daily", "weekly", "biweekly", "monthly"].indexOf(command.cadence);
    if (code < 0) throw new KinEngineError(2, "Choose a valid cadence.");
    packet[112] = code;
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
  } else {
    view.setUint32(124, textBytes.length, true);
    packet.set(textBytes, 128);
  }
  return packet;
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_TIMESTAMP) {
    throw new KinEngineError(2, "Kin needs a valid evaluation time.");
  }
}

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
  return {
    eventId: bytes.slice(8, 24),
    householdId: bytes.slice(24, 40),
    actorId: bytes.slice(40, 56),
    deviceId: bytes.slice(56, 72),
    timestamp,
    logicalTime: view.getBigUint64(80, true),
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
  request.set([75, 77, 68, 81, 1, 0, 0, 0]);
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
  command,
  identity,
  records,
  asOf,
  cursor,
  civilDate,
  syncIdentity,
) {
  const intent = encodeIntentPacket(
    {
      ...command,
      ...(command.type === "create-routine" ? { createdOn: civilDate } : {}),
    },
    identity,
  );
  const history = encodeRequest(records, asOf, cursor, civilDate, syncIdentity);
  const request = new Uint8Array(4 + intent.length + history.length);
  new DataView(request.buffer).setUint32(0, intent.length, true);
  request.set(intent, 4);
  request.set(history, 4 + intent.length);
  const bytes = callCore(exports, "kin_execute_command", request);
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
    state: decodeState(bytes.subarray(20 + eventLength + metadataLength)),
  };
}

function encodeArchive(exports, metadata, ciphertext) {
  metadata = asBytes(metadata);
  ciphertext = asBytes(ciphertext);
  if (metadata.length + ciphertext.length + 16 > MAX_PROTOCOL_BYTES)
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
    state: decodeState(bytes.subarray(24)),
  };
}
function decodeArchive(exports, bytes) {
  bytes = asBytes(bytes);
  if (bytes.length > MAX_PROTOCOL_BYTES)
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

function callCore(exports, operation, request) {
  if (!exports)
    throw new KinEngineError(
      6,
      "Unlock Kin before using its household engine.",
    );
  if (request.length > MAX_PROTOCOL_BYTES)
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  const pointer = exports.kin_alloc(request.length);
  if (!pointer) throw new KinEngineError(5, USER_MESSAGES.get(5));
  try {
    new Uint8Array(exports.memory.buffer, pointer, request.length).set(request);
    const status = exports[operation](pointer, request.length);
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
    return bytes;
  } finally {
    if (exports.kin_free(pointer, request.length) !== 0)
      throw new KinEngineError(1, USER_MESSAGES.get(1));
  }
}

function applyEvents(
  exports,
  records,
  asOf,
  cursorEventId,
  civilDate,
  syncIdentity,
) {
  if (!exports)
    throw new KinEngineError(
      6,
      "Unlock Kin before using its household engine.",
    );
  if (records.length > MAX_EVENT_COUNT) {
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  }
  const request = encodeRequest(
    records,
    asOf,
    cursorEventId,
    civilDate,
    syncIdentity,
  );
  const inputPointer = exports.kin_alloc(request.length);
  if (inputPointer === 0) {
    throw new KinEngineError(5, USER_MESSAGES.get(5));
  }

  let result;
  let operationError;
  try {
    new Uint8Array(exports.memory.buffer, inputPointer, request.length).set(
      request,
    );
    const status = exports.kin_apply_events(inputPointer, request.length);
    const output =
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
    if (status !== 0) {
      throw decodeError(output, status);
    }
    result = decodeState(output);
  } catch (error) {
    operationError =
      error instanceof KinEngineError
        ? error
        : new KinEngineError(
            6,
            "Kin could not complete a household-engine operation.",
          );
  }

  const freeStatus = exports.kin_free(inputPointer, request.length);
  if (operationError) {
    throw operationError;
  }
  if (freeStatus !== 0) {
    throw new KinEngineError(1, USER_MESSAGES.get(1));
  }
  return result;
}

function encodeRequest(records, asOf, cursorEventId, civilDate, syncIdentity) {
  assertTimestamp(asOf);
  assertCivilDate(civilDate);
  const identityBindings = syncIdentity?.bindings ?? [];
  if (
    syncIdentity &&
    (!Array.isArray(identityBindings) || identityBindings.length > 256)
  ) {
    throw new KinEngineError(2, "Kin received invalid sync identity context.");
  }
  const headerBytes = REQUEST_HEADER_BYTES + identityBindings.length * 96;
  let length = headerBytes;
  for (const record of records) {
    length += asBytes(record).length;
    if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_BYTES) {
      throw new KinEngineError(5, USER_MESSAGES.get(5));
    }
  }

  const bytes = new Uint8Array(length);
  bytes.set([0x4b, 0x49, 0x4e, 0x45]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, PROTOCOL_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, records.length, true);
  view.setBigInt64(12, BigInt(asOf), true);
  if (cursorEventId !== null) {
    const cursor =
      typeof cursorEventId === "string"
        ? idFromHex(cursorEventId)
        : assertId(cursorEventId);
    bytes[20] = 1;
    bytes.set(cursor, 24);
  }
  view.setUint32(40, civilDate, true);
  if (syncIdentity) {
    bytes.set(idFromHex(syncIdentity.householdId), 44);
    view.setUint16(60, identityBindings.length, true);
    let bindingOffset = 64;
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
  let offset = headerBytes;
  for (const record of records) {
    const eventBytes = asBytes(record);
    bytes.set(eventBytes, offset);
    offset += eventBytes.length;
  }
  return bytes;
}

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

function decodeState(bytes) {
  if (
    bytes.length < RESULT_HEADER_BYTES ||
    bytes.length > MAX_PROTOCOL_BYTES ||
    readAscii(bytes, 0, 4) !== "KINS"
  ) {
    throw new KinEngineError(
      6,
      "Kin received an invalid state from its household engine.",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const protocolVersion = view.getUint16(4, true);
  if (
    ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(protocolVersion) ||
    view.getUint16(6, true) !== 0
  ) {
    throw new KinEngineError(6, "Kin received an unsupported state format.");
  }
  const resultHeaderBytes =
    protocolVersion >= 11 ? 68 : protocolVersion >= 10 ? 64 : protocolVersion >= 9
      ? 60
      : protocolVersion >= 7
      ? 56
      : protocolVersion >= 6
        ? 52
        : protocolVersion === 5
          ? 24
          : protocolVersion === 4
            ? 20
            : protocolVersion === 3
              ? 16
              : 12;
  if (bytes.length < resultHeaderBytes) {
    throw new KinEngineError(6, "Kin received a truncated state header.");
  }
  const handoffCount = protocolVersion >= 3 ? view.getUint32(12, true) : 0;
  const talkCount = protocolVersion >= 4 ? view.getUint32(16, true) : 0;
  const pulseCount = protocolVersion >= 5 ? view.getUint32(20, true) : 0;
  const itemCount = view.getUint32(8, true);
  const routineCount = protocolVersion >= 7 ? view.getUint32(52, true) : 0;
  const areaCount = protocolVersion >= 9 ? view.getUint32(56, true) : 0;
  const noteCount = protocolVersion >= 10 ? view.getUint32(60, true) : 0;
  const stepCount = protocolVersion >= 11 ? view.getUint32(64, true) : 0;
  const summaryCount = protocolVersion >= 6 ? view.getUint32(24, true) : 0;
  const summaryTotalCount = protocolVersion >= 6 ? view.getUint32(28, true) : 0;
  const summaryThroughPresent = protocolVersion >= 6 ? view.getUint8(32) : 0;
  const summaryThroughBytes =
    protocolVersion >= 6 ? bytes.subarray(36, 52) : null;
  const summaryThroughEventId =
    protocolVersion >= 6 && summaryThroughPresent === 1
      ? idToHex(summaryThroughBytes)
      : null;
  if (
    protocolVersion >= 6 &&
    (summaryCount > MAX_SUMMARY_ENTRIES ||
      summaryCount > summaryTotalCount ||
      summaryTotalCount > MAX_EVENT_COUNT ||
      summaryThroughPresent > 1 ||
      (summaryTotalCount > 0 && summaryThroughPresent !== 1) ||
      (summaryCount > 0 && summaryThroughPresent !== 1) ||
      bytes.subarray(33, 36).some((byte) => byte !== 0) ||
      (summaryThroughPresent === 0 &&
        summaryThroughBytes.some((byte) => byte !== 0)))
  ) {
    throw new KinEngineError(6, "Kin received invalid summary metadata.");
  }
  if (
    areaCount > 32 ||
    noteCount > 128 ||
    stepCount > MAX_EVENT_COUNT ||
    stepCount > itemCount * MAX_STEPS_PER_ITEM ||
    itemCount + handoffCount + talkCount + pulseCount + routineCount + noteCount >
      MAX_EVENT_COUNT
  ) {
    throw new KinEngineError(
      6,
      "Kin received too many items from its household engine.",
    );
  }
  const items = [];
  let offset = resultHeaderBytes;
  for (let index = 0; index < itemCount; index += 1) {
    const headerEnd = offset + ITEM_HEADER_BYTES;
    if (headerEnd > bytes.length) {
      throw new KinEngineError(
        6,
        "Kin received a truncated state from its household engine.",
      );
    }
    const textLength = view.getUint32(offset + 44, true);
    const recordEnd = headerEnd + textLength;
    const classificationCode = view.getUint8(offset + 40);
    const statusCode =
      protocolVersion === 1 ? classificationCode : view.getUint8(offset + 41);
    const validStatus =
      protocolVersion === 1
        ? classificationCode <= 1 &&
          view.getUint8(offset + 41) === 0 &&
          view.getUint8(offset + 42) === 0 &&
          view.getUint8(offset + 43) === 0
        : classificationCode <= (protocolVersion >= 14 ? 3 : protocolVersion >= 13 ? 2 : 1) &&
          statusCode <= 2 &&
          view.getUint8(offset + 42) === 0 &&
          view.getUint8(offset + 43) === 0;
    if (
      recordEnd > bytes.length ||
      textLength < 1 ||
      textLength > MAX_ITEM_TEXT_BYTES ||
      !validStatus
    ) {
      throw new KinEngineError(
        6,
        "Kin received an invalid item record from its household engine.",
      );
    }
    const createdAt = view.getBigInt64(offset + 32, true);
    const createdAtNumber = Number(createdAt);
    if (!Number.isSafeInteger(createdAtNumber)) {
      throw new KinEngineError(
        6,
        "Kin received an invalid item timestamp from its household engine.",
      );
    }
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, recordEnd));
    } catch {
      throw new KinEngineError(
        6,
        "Kin received invalid item text from its household engine.",
      );
    }
    items.push({
      itemId: idToHex(bytes.subarray(offset, offset + 16)),
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt: createdAtNumber,
      classification:
        protocolVersion === 1
          ? "today"
          : ["today", "need", "shopping", "staple"][classificationCode],
      status: ["active", "completed", "archived"][statusCode],
      ...(protocolVersion >= 9 ? { areaId: null } : {}),
      ...(protocolVersion >= 11 ? { steps: [] } : {}),
      text,
    });
    offset = recordEnd;
  }
  const handoffs = [];
  for (let index = 0; index < handoffCount; index += 1) {
    const headerEnd = offset + 48;
    if (headerEnd > bytes.length)
      throw new KinEngineError(6, "Kin received a truncated handoff record.");
    const textLength = view.getUint32(offset + 44, true);
    const end = headerEnd + textLength;
    const status = bytes[offset + 40];
    const createdAt = Number(view.getBigInt64(offset + 32, true));
    if (
      end > bytes.length ||
      textLength < 1 ||
      textLength > MAX_ITEM_TEXT_BYTES ||
      status > 2 ||
      bytes.slice(offset + 41, offset + 44).some((value) => value !== 0) ||
      !Number.isSafeInteger(createdAt)
    ) {
      throw new KinEngineError(6, "Kin received an invalid handoff record.");
    }
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw new KinEngineError(6, "Kin received invalid handoff text.");
    }
    handoffs.push({
      handoffId: idToHex(bytes.subarray(offset, offset + 16)),
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt,
      text,
      status: ["unacknowledged", "acknowledged", "archived"][status],
    });
    offset = end;
  }
  const talks = [];
  for (let index = 0; index < talkCount; index += 1) {
    const headerEnd = offset + 48;
    if (headerEnd > bytes.length)
      throw new KinEngineError(6, "Kin received a truncated talk record.");
    const textLength = view.getUint32(offset + 44, true);
    const end = headerEnd + textLength;
    const status = bytes[offset + 40];
    const createdAt = Number(view.getBigInt64(offset + 32, true));
    if (
      end > bytes.length ||
      textLength < 1 ||
      textLength > MAX_ITEM_TEXT_BYTES ||
      status > 2 ||
      bytes.slice(offset + 41, offset + 44).some((value) => value !== 0) ||
      !Number.isSafeInteger(createdAt)
    ) {
      throw new KinEngineError(6, "Kin received an invalid talk record.");
    }
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw new KinEngineError(6, "Kin received invalid talk text.");
    }
    talks.push({
      talkId: idToHex(bytes.subarray(offset, offset + 16)),
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt,
      text,
      status: ["open", "resolved", "archived"][status],
    });
    offset = end;
  }
  const pulses = [];
  let previousActor = null;
  for (let index = 0; index < pulseCount; index += 1) {
    if (offset + 40 > bytes.length)
      throw new KinEngineError(6, "Kin received a truncated pulse record.");
    const actorId = idToHex(bytes.subarray(offset, offset + 16));
    const setAt = Number(view.getBigInt64(offset + 16, true));
    const expiresAt = Number(view.getBigInt64(offset + 24, true));
    const value = bytes[offset + 32];
    const status = bytes[offset + 33];
    if (
      !Number.isSafeInteger(setAt) ||
      !Number.isSafeInteger(expiresAt) ||
      Math.abs(setAt) > MAX_TIMESTAMP ||
      Math.abs(expiresAt) > MAX_TIMESTAMP ||
      expiresAt <= setAt ||
      value > 4 ||
      status > 1 ||
      bytes.subarray(offset + 34, offset + 40).some((byte) => byte !== 0) ||
      (previousActor !== null && actorId <= previousActor)
    ) {
      throw new KinEngineError(6, "Kin received an invalid pulse record.");
    }
    pulses.push({
      actorId,
      setAt,
      expiresAt,
      value: PULSE_VALUES[value],
      status: ["active", "expired"][status],
    });
    previousActor = actorId;
    offset += 40;
  }
  if (protocolVersion >= 9) {
    for (const item of items) {
      if (offset + 16 > bytes.length)
        throw new KinEngineError(6, "Kin received truncated Area assignments.");
      const id = bytes.subarray(offset, offset + 16);
      item.areaId = id.every((byte) => byte === 0) ? null : idToHex(id);
      offset += 16;
    }
  }
  const routines = [];
  const routineIds = new Set();
  for (let index = 0; index < routineCount; index += 1) {
    const headerEnd = offset + 56;
    if (headerEnd > bytes.length)
      throw new KinEngineError(6, "Kin received a truncated routine.");
    const length = view.getUint32(offset + 52, true);
    const end = headerEnd + length;
    const routineId = idToHex(bytes.subarray(offset, offset + 16));
    const createdAt = Number(view.getBigInt64(offset + 32, true));
    const createdOn = view.getUint32(offset + 40, true);
    const key = view.getUint32(offset + 44, true);
    const cadence = bytes[offset + 48],
      status = bytes[offset + 49],
      occurrence = bytes[offset + 50];
    if (
      length < 1 ||
      length > 4096 ||
      end > bytes.length ||
      cadence > 3 ||
      (protocolVersion < 12 && cadence > 1) ||
      status > 1 ||
      occurrence > 2 ||
      bytes[offset + 51] !== 0 ||
      (key === 0) !== (occurrence === 0) ||
      (status === 1 && occurrence !== 0) ||
      routineIds.has(routineId)
    ) {
      throw new KinEngineError(6, "Kin received an invalid routine.");
    }
    let text;
    try {
      assertTimestamp(createdAt);
      assertCivilDate(createdOn);
      if (key) assertCivilDate(key);
      // Validate wire combinations without calculating the household's current period.
      if (key && cadence === 0 && key < createdOn) throw new Error();
      if (key && cadence === 1) {
        const d = new Date(0);
        d.setUTCFullYear(
          Math.floor(key / 10000),
          (Math.floor(key / 100) % 100) - 1,
          key % 100,
        );
        if (d.getUTCDay() !== 1) throw new Error();
        d.setUTCDate(d.getUTCDate() + 6);
        const endKey =
          d.getUTCFullYear() * 10000 +
          (d.getUTCMonth() + 1) * 100 +
          d.getUTCDate();
        if (endKey < createdOn) throw new Error();
      }
      if (
        key &&
        cadence === 2 &&
        (key < createdOn || (civilOrdinal(key) - civilOrdinal(createdOn)) % 14 !== 0)
      ) throw new Error();
      if (
        key &&
        cadence === 3 &&
        (key % 100 !== 1 || key < Math.floor(createdOn / 100) * 100 + 1)
      ) throw new Error();
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw new KinEngineError(6, "Kin received invalid routine fields.");
    }
    routineIds.add(routineId);
    routines.push({
      routineId,
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)),
      createdAt,
      createdOn,
      cadence: ["daily", "weekly", "biweekly", "monthly"][cadence],
      status: ["active", "archived"][status],
      occurrenceKey: key || null,
      occurrenceStatus: ["unavailable", "open", "completed"][occurrence],
      text,
    });
    offset = end;
  }
  const areas = [];
  const areaIds = new Set();
  for (let index = 0; index < areaCount; index += 1) {
    const headerEnd = offset + 24;
    if (headerEnd > bytes.length) throw new KinEngineError(6, "Kin received a truncated Area.");
    const areaId = idToHex(bytes.subarray(offset, offset + 16));
    const archived = bytes[offset + 16];
    const length = view.getUint32(offset + 20, true);
    const end = headerEnd + length;
    if (archived > 1 || bytes.subarray(offset + 17, offset + 20).some((byte) => byte !== 0) || length < 1 || length > 96 || end > bytes.length || areaIds.has(areaId))
      throw new KinEngineError(6, "Kin received an invalid Area.");
    let name;
    try { name = strictTextDecoder.decode(bytes.subarray(headerEnd, end)); }
    catch { throw new KinEngineError(6, "Kin received invalid Area text."); }
    if (name.trim() !== name || [...name].length > 48 || /[\u0000-\u001f\u007f]/u.test(name))
      throw new KinEngineError(6, "Kin received invalid Area text.");
    areaIds.add(areaId);
    areas.push({ areaId, name, archived: archived === 1 });
    offset = end;
  }
  if (items.some((item) => item.areaId && !areaIds.has(item.areaId)))
    throw new KinEngineError(6, "Kin received an unknown Area assignment.");
  const notes = [];
  const noteIds = new Set();
  for (let index = 0; index < noteCount; index += 1) {
    const headerEnd = offset + 92;
    if (headerEnd > bytes.length) throw new KinEngineError(6, "Kin received a truncated Note.");
    const titleLength = view.getUint32(offset + 84, true), bodyLength = view.getUint32(offset + 88, true), end = headerEnd + titleLength + bodyLength;
    const noteId = idToHex(bytes.subarray(offset, offset + 16)), area = bytes.subarray(offset + 64, offset + 80), archived = bytes[offset + 80];
    if (titleLength < 1 || titleLength > 256 || bodyLength > 4096 || end > bytes.length || archived > 1 || bytes.subarray(offset + 81, offset + 84).some(Boolean) || noteIds.has(noteId)) throw new KinEngineError(6, "Kin received an invalid Note.");
    let title, body;
    try { title = strictTextDecoder.decode(bytes.subarray(headerEnd, headerEnd + titleLength)); body = strictTextDecoder.decode(bytes.subarray(headerEnd + titleLength, end)); }
    catch { throw new KinEngineError(6, "Kin received invalid Note text."); }
    if (noteId === "00".repeat(16) || !title.trim() || title.trim() !== title || [...title].length > 80 || [...title].some((character) => /\p{Cc}/u.test(character)) || [...body].some((character) => /\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character))) throw new KinEngineError(6, "Kin received invalid Note text.");
    notes.push({ noteId, title, body, areaId: area.every((byte) => byte === 0) ? null : idToHex(area), archived: archived === 1,
      createdBy: idToHex(bytes.subarray(offset + 16, offset + 32)), updatedBy: idToHex(bytes.subarray(offset + 32, offset + 48)),
      createdAt: Number(view.getBigInt64(offset + 48, true)), updatedAt: Number(view.getBigInt64(offset + 56, true)) });
    noteIds.add(noteId); offset = end;
  }
  if (notes.some((note) => note.areaId && !areaIds.has(note.areaId))) throw new KinEngineError(6, "Kin received a Note with an unknown Area.");
  if (protocolVersion >= 11) {
    const itemById = new Map(items.map((item) => [item.itemId, item]));
    const stepIds = new Set();
    for (let index = 0; index < stepCount; index += 1) {
      const headerEnd = offset + 40;
      if (headerEnd > bytes.length)
        throw new KinEngineError(6, "Kin received a truncated Step.");
      const itemId = idToHex(bytes.subarray(offset, offset + 16));
      const stepId = idToHex(bytes.subarray(offset + 16, offset + 32));
      const completed = bytes[offset + 32];
      const archived = bytes[offset + 33];
      const textLength = view.getUint32(offset + 36, true);
      const end = headerEnd + textLength;
      const item = itemById.get(itemId);
      if (
        !item ||
        stepId === "00".repeat(16) ||
        stepIds.has(stepId) ||
        item.steps.length >= MAX_STEPS_PER_ITEM ||
        completed > 1 ||
        archived > 1 ||
        bytes.subarray(offset + 34, offset + 36).some(Boolean) ||
        textLength < 1 ||
        textLength > MAX_STEP_TEXT_BYTES ||
        end > bytes.length
      ) {
        throw new KinEngineError(6, "Kin received an invalid Step.");
      }
      let text;
      try {
        text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
      } catch {
        throw new KinEngineError(6, "Kin received invalid Step text.");
      }
      if (
        text.trim() !== text ||
        [...text].length > MAX_STEP_TEXT_CHARS ||
        [...text].some((character) => /\p{Cc}/u.test(character))
      ) {
        throw new KinEngineError(6, "Kin received invalid Step text.");
      }
      stepIds.add(stepId);
      item.steps.push({ stepId, text, completed: completed === 1, archived: archived === 1 });
      offset = end;
    }
  }
  const summaryEntries = [];
  const entityNames = ["", "item", "handoff", "talk", "routine"];
  for (let index = 0; index < summaryCount; index += 1) {
    const headerEnd = offset + 24;
    if (headerEnd > bytes.length) {
      throw new KinEngineError(6, "Kin received a truncated summary entry.");
    }
    const kindCode = bytes[offset + 16];
    const entityCode = bytes[offset + 17];
    const classificationCode = bytes[offset + 18];
    const textLength = view.getUint32(offset + 20, true);
    const end = headerEnd + textLength;
    const expectedEntity =
      kindCode >= 1 && kindCode <= 4
        ? 1
        : kindCode >= 5 && kindCode <= 7
          ? 2
          : kindCode >= 8 && kindCode <= 11
            ? 3
            : protocolVersion >= 7 && kindCode >= 12 && kindCode <= 15
              ? 4
              : 0;
    const validClassification =
      kindCode === 1
        ? classificationCode <= (protocolVersion >= 14 ? 3 : protocolVersion >= 13 ? 2 : 1)
        : classificationCode === 255;
    if (
      end > bytes.length ||
      kindCode === 0 ||
      expectedEntity === 0 ||
      entityCode !== expectedEntity ||
      !validClassification ||
      bytes[offset + 19] !== 0 ||
      textLength < 1 ||
      textLength > MAX_ITEM_TEXT_BYTES
    ) {
      throw new KinEngineError(6, "Kin received an invalid summary entry.");
    }
    let text;
    try {
      text = strictTextDecoder.decode(bytes.subarray(headerEnd, end));
    } catch {
      throw new KinEngineError(6, "Kin received invalid summary text.");
    }
    summaryEntries.push({
      eventId: idToHex(bytes.subarray(offset, offset + 16)),
      kind: SUMMARY_KINDS[kindCode],
      entityKind: entityNames[entityCode],
      text,
      classification:
        classificationCode === 255
          ? null
          : classificationCode === 0
            ? "today"
            : classificationCode === 1
              ? "need"
              : classificationCode === 2
                ? "shopping"
                : "staple",
    });
    offset = end;
  }
  if (offset !== bytes.length) {
    throw new KinEngineError(
      6,
      "Kin received trailing bytes from its household engine.",
    );
  }
  if (protocolVersion >= 6) {
    return {
      items,
      handoffs,
      talks,
      pulses,
      ...(protocolVersion >= 7 ? { routines } : {}),
      ...(protocolVersion >= 9 ? { areas } : {}),
      ...(protocolVersion >= 10 ? { notes } : {}),
      summary: {
        entries: summaryEntries,
        totalCount: summaryTotalCount,
        throughEventId: summaryThroughEventId,
      },
    };
  }
  return { items, handoffs, talks, pulses };
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

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new KinEngineError(2, "Kin could not read a stored event record.");
}

function readAscii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
