// A small in-memory IndexedDB for Node tests of chat storage (not shipped).
// It models only what chat-blob-store.js uses: open with an upgrade, object
// stores with a key path, get/put/delete, transactions that stay active
// while microtasks run and commit once no request is pending, and
// deleteDatabase. Values are structured-cloned as a browser would.
class Request {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  succeed(result) { this.result = result; queueMicrotask(() => this.onsuccess?.({ target: this })); }
}

class Transaction {
  constructor(db, names, mode) {
    this.db = db; this.names = names; this.mode = mode; this.pending = 0; this.finished = false;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    this.schedule();
  }
  schedule() {
    setImmediate(() => {
      if (this.finished || this.pending) return;
      this.finished = true;
      this.oncomplete?.();
    });
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`NotFoundError: ${name} is not in this transaction`);
    const rows = this.db.stores.get(name);
    const keyPath = this.db.keyPaths.get(name);
    const request = (work) => {
      if (this.finished) throw new Error("TransactionInactiveError");
      const result = new Request();
      this.pending += 1;
      const value = work();
      queueMicrotask(() => { this.pending -= 1; result.succeed(value); queueMicrotask(() => this.schedule()); });
      return result;
    };
    const write = (work) => {
      if (this.mode !== "readwrite") throw new Error("ReadOnlyError");
      return request(work);
    };
    return {
      get: (key) => request(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
      put: (value) => write(() => { rows.set(value[keyPath], structuredClone(value)); return value[keyPath]; }),
      delete: (key) => write(() => { rows.delete(key); }),
    };
  }
}

class Database {
  constructor(name) { this.name = name; this.stores = new Map(); this.keyPaths = new Map(); this.closed = false; this.version = 0; }
  get objectStoreNames() { return { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name, { keyPath }) { this.stores.set(name, new Map()); this.keyPaths.set(name, keyPath); }
  transaction(names, mode = "readonly") {
    if (this.closed) throw new Error("InvalidStateError");
    return new Transaction(this, [names].flat(), mode);
  }
  close() { this.closed = true; }
}

export function fakeIndexedDB() {
  const databases = new Map();
  return {
    databases,
    open(name, version) {
      const request = new Request();
      request.onupgradeneeded = null;
      setImmediate(() => {
        let db = databases.get(name);
        if (!db) { db = new Database(name); databases.set(name, db); }
        db.closed = false;
        request.result = db;
        if (db.version < version) { db.version = version; request.onupgradeneeded?.({ target: request }); }
        request.succeed(db);
      });
      return request;
    },
    deleteDatabase(name) {
      const request = new Request();
      setImmediate(() => { databases.delete(name); request.succeed(undefined); });
      return request;
    },
  };
}
