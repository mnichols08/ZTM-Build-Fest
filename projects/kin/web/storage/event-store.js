import {
  encodeAddedRecord,
  encodeCompletedRecord,
  idFromHex,
  randomId,
} from "../wasm/kin-engine.js";

const DATABASE_NAME = "kin";
const DATABASE_VERSION = 1;
const EVENT_STORE = "events";
const CONTEXT_STORE = "local_context";
const CONTEXT_KEY = "installation";
const MAX_EVENT_COUNT = 10_000;
const MAX_LOGICAL_TIME = (1n << 64n) - 1n;

export class EventStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "EventStoreError";
    this.userMessage = message;
  }
}

export class EventStore {
  constructor(database) {
    this.database = database;
  }

  static async open() {
    if (!globalThis.indexedDB) {
      throw new EventStoreError(
        "Kin could not access local household storage. Your information was not intentionally deleted.",
      );
    }

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let settled = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EVENT_STORE)) {
          const events = db.createObjectStore(EVENT_STORE, {
            keyPath: "local_sequence",
            autoIncrement: true,
          });
          events.createIndex("event_id", "event_id", { unique: true });
        }
        if (!db.objectStoreNames.contains(CONTEXT_STORE)) {
          db.createObjectStore(CONTEXT_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(storageError(request.error));
        }
      };
      request.onblocked = () => {
        if (!settled) {
          settled = true;
          reject(
            new EventStoreError(
              "Kin could not finish opening local household storage. Close other Kin tabs and try again.",
            ),
          );
        }
      };
    });

    const store = new EventStore(database);
    database.onversionchange = () => database.close();
    try {
      await store.ensureContext();
    } catch (error) {
      database.close();
      throw error;
    }
    return store;
  }

  async loadEvents() {
    const transaction = this.database.transaction(EVENT_STORE, "readonly");
    const request = transaction.objectStore(EVENT_STORE).getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        try {
          finish(validateEventRows(request.result));
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  append(command, engine) {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readwrite",
    );
    const events = transaction.objectStore(EVENT_STORE);
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const eventRequest = events.getAll();
    const contextRequest = contextStore.get(CONTEXT_KEY);

    return transactionResult(transaction, (finish) => {
      let loadedEvents;
      let context;
      let eventsReady = false;
      let contextReady = false;
      let candidateState;

      const prepareCandidate = () => {
        if (!eventsReady || !contextReady) {
          return;
        }
        try {
          loadedEvents = validateEventRows(loadedEvents);
          validateContext(context);
          if (loadedEvents.length >= MAX_EVENT_COUNT) {
            throw new EventStoreError(
              "Kin has reached its local event limit. Your saved information was not deleted.",
            );
          }

          const logicalTime = BigInt(context.next_logical_time);
          if (logicalTime <= 0n || logicalTime >= MAX_LOGICAL_TIME) {
            throw new EventStoreError(
              "Kin has reached a supported event-order limit. Your saved information was not deleted.",
            );
          }
          const eventId = randomId();
          const timestamp = Date.now();
          const identity = {
            eventId,
            householdId: context.household_id,
            actorId: context.actor_id,
            deviceId: context.device_id,
            timestamp,
            logicalTime,
          };
          let kind;
          let encodedEvent;
          if (command.type === "add") {
            kind = "ITEM_ADDED";
            encodedEvent = encodeAddedRecord({
              ...identity,
              itemId: randomId(),
              text: command.text,
            });
          } else if (command.type === "complete") {
            kind = "ITEM_COMPLETED";
            encodedEvent = encodeCompletedRecord({
              ...identity,
              itemId: idFromHex(command.itemId),
            });
          } else {
            throw new EventStoreError(
              "Kin could not identify that household action.",
            );
          }

          candidateState = engine.applyEvents([
            ...loadedEvents.map((event) => event.encoded_event),
            encodedEvent,
          ]);

          const existingRequest = events.index("event_id").get(eventId);
          existingRequest.onsuccess = () => {
            const existing = existingRequest.result;
            if (existing) {
              if (!bytesEqual(existing.encoded_event, encodedEvent)) {
                abortWith(
                  transaction,
                  new EventStoreError(
                    "Kin found a conflicting local event identifier. Your saved information was not deleted.",
                  ),
                );
                return;
              }
              finish(candidateState);
              return;
            }

            const row = {
              event_id: eventId,
              household_id: context.household_id,
              actor_id: context.actor_id,
              device_id: context.device_id,
              timestamp,
              logical_time: logicalTime,
              kind,
              event_version: 1,
              encoded_event: encodedEvent,
            };
            const addRequest = events.add(row);
            const contextWrite = contextStore.put({
              ...context,
              next_logical_time: logicalTime + 1n,
            });
            addRequest.onerror = () =>
              abortWith(transaction, storageError(addRequest.error));
            contextWrite.onerror = () =>
              abortWith(transaction, storageError(contextWrite.error));
            finish(candidateState);
          };
          existingRequest.onerror = () =>
            abortWith(transaction, storageError(existingRequest.error));
        } catch (error) {
          abortWith(
            transaction,
            error instanceof EventStoreError
              ? error
              : new EventStoreError(
                  error.userMessage ??
                    "Kin could not validate that household change.",
                  error,
                ),
          );
        }
      };

      eventRequest.onsuccess = () => {
        loadedEvents = eventRequest.result;
        eventsReady = true;
        prepareCandidate();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        contextReady = true;
        prepareCandidate();
      };
      eventRequest.onerror = () =>
        abortWith(transaction, storageError(eventRequest.error));
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
    });
  }

  ensureContext() {
    const transaction = this.database.transaction(CONTEXT_STORE, "readwrite");
    const contexts = transaction.objectStore(CONTEXT_STORE);
    const request = contexts.get(CONTEXT_KEY);
    let context;

    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        context = request.result;
        if (context) {
          try {
            validateContext(context);
            finish(context);
          } catch (error) {
            abortWith(transaction, error);
          }
          return;
        }

        context = {
          key: CONTEXT_KEY,
          household_id: randomId(),
          actor_id: randomId(),
          device_id: randomId(),
          next_logical_time: 1n,
        };
        const write = contexts.add(context);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(context);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  close() {
    this.database.close();
  }
}

function transactionResult(transaction, schedule) {
  return new Promise((resolve, reject) => {
    let failure;
    let result;
    let hasResult = false;
    const finish = (value) => {
      result = value;
      hasResult = true;
    };
    transaction.oncomplete = () => {
      if (hasResult) {
        resolve(result);
      } else {
        reject(storageError(transaction.error));
      }
    };
    transaction.onerror = () => {
      failure ??= transaction.__kinFailure ?? storageError(transaction.error);
    };
    transaction.onabort = () =>
      reject(
        failure ?? transaction.__kinFailure ?? storageError(transaction.error),
      );
    try {
      schedule(finish);
    } catch (error) {
      abortWith(transaction, error);
    }
  });
}

function abortWith(transaction, error) {
  try {
    transaction.__kinFailure ??= error;
    transaction.abort();
  } catch {
    transaction.__kinFailure ??= error;
  }
}

function storageError(cause) {
  const message =
    cause?.name === "QuotaExceededError"
      ? "Kin couldn't save because local browser storage is full. Free some space, then try again. Your saved information was not deleted."
      : "Kin could not safely access local household storage. Your saved information was not intentionally deleted.";
  const error = new EventStoreError(message, cause);
  return error;
}

function validateEventRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_EVENT_COUNT) {
    throw new EventStoreError(
      "Kin found an invalid local event history. The stored data was preserved.",
    );
  }
  let previousSequence = 0;
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !Number.isSafeInteger(row.local_sequence) ||
      row.local_sequence <= previousSequence
    ) {
      throw new EventStoreError(
        "Kin found an invalid local event order. The stored data was preserved.",
      );
    }
    validateEventRow(row);
    previousSequence = row.local_sequence;
  }
  return rows;
}

function validateEventRow(row) {
  const encoded = asBytes(row.encoded_event);
  if (encoded.length < 88 || row.event_version !== 1) {
    throw new EventStoreError(
      "Kin found an incomplete local event. The stored data was preserved.",
    );
  }
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  const kind = view.getUint16(2, true);
  const expectedKind =
    row.kind === "ITEM_ADDED" ? 1 : row.kind === "ITEM_COMPLETED" ? 2 : 0;
  if (
    !Number.isSafeInteger(row.timestamp) ||
    typeof row.logical_time !== "bigint" ||
    row.logical_time < 0n
  ) {
    throw new EventStoreError(
      "Kin found inconsistent local event data. The stored data was preserved.",
    );
  }
  const timestamp = view.getBigInt64(68, true);
  const logicalTime = view.getBigUint64(76, true);
  if (
    view.getUint16(0, true) !== row.event_version ||
    kind !== expectedKind ||
    !bytesEqual(encoded.subarray(4, 20), row.event_id) ||
    !bytesEqual(encoded.subarray(20, 36), row.household_id) ||
    !bytesEqual(encoded.subarray(36, 52), row.actor_id) ||
    !bytesEqual(encoded.subarray(52, 68), row.device_id) ||
    timestamp !== BigInt(row.timestamp) ||
    logicalTime !== BigInt(row.logical_time)
  ) {
    throw new EventStoreError(
      "Kin found inconsistent local event data. The stored data was preserved.",
    );
  }
}

function validateContext(context) {
  if (
    context?.key !== CONTEXT_KEY ||
    !isId(context.household_id) ||
    !isId(context.actor_id) ||
    !isId(context.device_id) ||
    typeof context.next_logical_time !== "bigint" ||
    context.next_logical_time < 1n ||
    context.next_logical_time > MAX_LOGICAL_TIME
  ) {
    throw new EventStoreError(
      "Kin found invalid local household identity data. The stored data was preserved.",
    );
  }
}

function isId(value) {
  try {
    return asBytes(value).length === 16;
  } catch {
    return false;
  }
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
  throw new EventStoreError(
    "Kin could not read a local event record. The stored data was preserved.",
  );
}

function bytesEqual(left, right) {
  try {
    const leftBytes = asBytes(left);
    const rightBytes = asBytes(right);
    if (leftBytes.length !== rightBytes.length) {
      return false;
    }
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  } catch {
    return false;
  }
}
