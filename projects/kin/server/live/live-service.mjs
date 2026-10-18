// The live channel (#107): one WebSocket per trusted device at /api/live, so
// the service can tell a device "there is something new" at once instead of
// waiting for its next poll. It carries notices and, later, chat signals;
// encrypted household data still moves over the HTTP sync routes, which stay
// the fallback whenever the socket isn't there.
//
// Rules:
// - The upgrade is refused unless the Origin is exactly Kin's own origin
//   (cross-site WebSocket hijacking), the session cookie names an active
//   member on a trusted device, and the household isn't being deleted.
// - One socket per device: a new one replaces the old (close 4409).
// - Losing access closes the socket at once: a signed-out or expired session
//   with 4401, a revoked device, removed member or deleted household with
//   4403. Anything that changes access calls revalidate(); each ping also
//   re-checks the session, which catches expiry.
// - Pings every 25 s; two unanswered pings close the socket.
// - Backpressure: while the socket can't take more, messages queue; past
//   1 MiB queued, the socket closes (4429) and the client falls back to HTTP.
// - Each connection keeps its socket and timers in a DisposableStack, so
//   every way it ends releases the same resources exactly once.
import {
  acceptKey, CLOSE, closePayload, encodeFrame, encodeMessage, FrameParser, isClientKey, MAX_MESSAGE_BYTES, OPCODE, parseMessage,
} from "./websocket.mjs";

export const LIVE_PATH = "/api/live";
export const PING_INTERVAL_MS = 25_000;
export const MAX_MISSED_PONGS = 2;
export const MAX_QUEUED_BYTES = 1024 * 1024;
export const MAX_CONNECTIONS = 4096;
/** How long a closing socket may take to finish its closing handshake. */
const CLOSE_GRACE_MS = 5_000;

/** Kin record types on the live channel (server → client unless noted). */
export const LIVE_TYPE = Object.freeze({
  /** Sent once when the socket opens. Empty payload. */
  HELLO: 0x01,
  /** New household events were accepted: pull from the HTTP sync routes.
   * Empty payload; it says nothing about what changed or who changed it. */
  SYNC_HINT: 0x02,
});

const ACCESS_CODES = new Map([
  ["authentication_required", CLOSE.SESSION_ENDED],
  ["device_not_trusted", CLOSE.ACCESS_LOST],
  ["membership_removed", CLOSE.ACCESS_LOST],
  ["household_deletion_pending", CLOSE.ACCESS_LOST],
  ["household_deleted", CLOSE.ACCESS_LOST],
]);

function refuse(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function headerList(value) {
  return String(value ?? "").toLowerCase().split(",").map((part) => part.trim());
}

class LiveConnection {
  constructor(live, socket, { sessionToken, deviceId, householdId, memberId }) {
    this.live = live;
    this.socket = socket;
    this.sessionToken = sessionToken;
    this.deviceId = deviceId;
    this.householdId = householdId;
    this.memberId = memberId;
    this.parser = new FrameParser({ maxMessage: live.maxMessage });
    this.queue = [];
    this.queuedBytes = 0;
    this.blocked = false;
    this.missedPongs = 0;
    this.closing = false;
    this.disposed = false;
    this.resources = new DisposableStack();
    const onData = (chunk) => this.receive(chunk);
    const onDrain = () => this.flush();
    const onEnd = () => this.dispose();
    socket.on("data", onData);
    socket.on("drain", onDrain);
    socket.on("close", onEnd);
    socket.on("error", onEnd);
    socket.setNoDelay?.(true);
    this.resources.defer(() => {
      socket.off("data", onData);
      socket.off("drain", onDrain);
      socket.destroy();
    });
    const ping = setInterval(() => this.tick(), live.pingInterval);
    ping.unref?.();
    this.resources.defer(() => clearInterval(ping));
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.live.forget(this);
    this.resources.dispose();
  }

  /** Every ping interval: give up on a silent peer, re-check the session. */
  tick() {
    if (this.closing) return;
    if (this.missedPongs >= this.live.maxMissedPongs) return this.close(CLOSE.GOING_AWAY, "No pong");
    if (!this.live.stillAllowed(this)) return;
    this.missedPongs += 1;
    this.write(encodeFrame(OPCODE.PING));
  }

  receive(chunk) {
    if (this.disposed) return;
    for (const event of this.parser.feed(chunk)) {
      if (event.type === "error") return this.close(event.code, event.reason);
      if (event.type === "ping") this.write(encodeFrame(OPCODE.PONG, event.data));
      else if (event.type === "pong") this.missedPongs = 0;
      else if (event.type === "close") {
        // Echo the peer's close and finish.
        const code = event.code === 1005 ? CLOSE.NORMAL : event.code;
        this.close(code, "", { echo: true });
        return;
      } else if (event.type === "message") {
        if (this.closing) continue;
        const record = parseMessage(event.data);
        if (!record) return this.close(CLOSE.INVALID_DATA, "Malformed message");
        const handler = this.live.handlers.get(record.type);
        if (!handler) return this.close(CLOSE.UNSUPPORTED_DATA, "Unknown message type");
        try {
          handler(this, record);
        } catch {
          return this.close(CLOSE.SERVER_ERROR, "");
        }
      }
    }
  }

  /** Sends one Kin record. */
  send(type, payload, flags) {
    if (this.closing || this.disposed) return false;
    return this.write(encodeFrame(OPCODE.BINARY, encodeMessage(type, payload, flags)));
  }

  write(frame) {
    if (this.disposed) return false;
    if (this.blocked) {
      this.queue.push(frame);
      this.queuedBytes += frame.length;
      if (this.queuedBytes > this.live.maxQueued) {
        // The client isn't reading; it can catch up over HTTP.
        this.dispose();
        return false;
      }
      return true;
    }
    this.blocked = !this.socket.write(frame);
    return true;
  }

  flush() {
    this.blocked = false;
    while (this.queue.length && !this.blocked) {
      const frame = this.queue.shift();
      this.queuedBytes -= frame.length;
      this.blocked = !this.socket.write(frame);
    }
  }

  /** Starts the closing handshake; the socket ends once the close frame is
   * written (and at the latest after a grace period). */
  close(code, reason = "", { echo = false } = {}) {
    if (this.closing || this.disposed) {
      if (echo) this.dispose();
      return;
    }
    this.closing = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.blocked = false;
    this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)));
    this.live.forget(this);
    if (echo) {
      this.socket.end();
      this.dispose();
      return;
    }
    this.socket.end();
    const grace = setTimeout(() => this.dispose(), CLOSE_GRACE_MS);
    grace.unref?.();
    this.resources.defer(() => clearTimeout(grace));
  }
}

export class LiveService {
  constructor({
    service, origin, readSession, store = null,
    pingInterval = PING_INTERVAL_MS, maxMissedPongs = MAX_MISSED_PONGS, maxQueued = MAX_QUEUED_BYTES,
    maxMessage = MAX_MESSAGE_BYTES, maxConnections = MAX_CONNECTIONS,
  }) {
    this.service = service;
    this.origin = origin;
    this.readSession = readSession;
    this.store = store;
    this.pingInterval = pingInterval;
    this.maxMissedPongs = maxMissedPongs;
    this.maxQueued = maxQueued;
    this.maxMessage = maxMessage;
    this.maxConnections = maxConnections;
    /** deviceId → connection */
    this.connections = new Map();
    /** householdId → Set of connections */
    this.households = new Map();
    /** Kin record type → handler(connection, record), for client messages. */
    this.handlers = new Map();
  }

  /** node:http's "upgrade" event. */
  handleUpgrade(request, socket, head) {
    socket.on("error", () => socket.destroy());
    let url;
    try {
      url = new URL(request.url, this.origin);
    } catch {
      return refuse(socket, 400, "Bad Request");
    }
    if (url.pathname !== LIVE_PATH || request.method !== "GET") return refuse(socket, 404, "Not Found");
    const key = request.headers["sec-websocket-key"];
    if (!headerList(request.headers.upgrade).includes("websocket") ||
        !headerList(request.headers.connection).includes("upgrade") ||
        request.headers["sec-websocket-version"] !== "13" || !isClientKey(key))
      return refuse(socket, 400, "Bad Request");
    // Cross-site WebSocket hijacking: the browser always sends Origin.
    if (request.headers.origin !== this.origin) return refuse(socket, 403, "Forbidden");
    // Kin speaks no subprotocol; extensions are declined by not echoing them.
    if (request.headers["sec-websocket-protocol"] !== undefined) return refuse(socket, 400, "Bad Request");
    let auth;
    const sessionToken = this.readSession(request);
    try {
      this.store?.assertAvailable();
      auth = this.service.authorize(sessionToken);
    } catch (error) {
      return refuse(socket, ACCESS_CODES.get(error?.code) === CLOSE.SESSION_ENDED ? 401 : 403, "Forbidden");
    }
    const replacing = this.connections.get(auth.device.id);
    if (!replacing && this.connections.size >= this.maxConnections) return refuse(socket, 503, "Service Unavailable");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    replacing?.close(CLOSE.REPLACED, "Replaced by a newer connection");
    const connection = new LiveConnection(this, socket, {
      sessionToken, deviceId: auth.device.id, householdId: auth.household.id, memberId: auth.member.id,
    });
    this.connections.set(connection.deviceId, connection);
    let group = this.households.get(connection.householdId);
    if (!group) this.households.set(connection.householdId, (group = new Set()));
    group.add(connection);
    connection.send(LIVE_TYPE.HELLO);
    if (head?.length) connection.receive(head);
  }

  forget(connection) {
    if (this.connections.get(connection.deviceId) === connection) this.connections.delete(connection.deviceId);
    const group = this.households.get(connection.householdId);
    group?.delete(connection);
    if (group?.size === 0) this.households.delete(connection.householdId);
  }

  /** Whether the connection's session still grants access; closes it if not. */
  stillAllowed(connection) {
    try {
      const auth = this.service.authorize(connection.sessionToken);
      if (auth.device.id === connection.deviceId && auth.household.id === connection.householdId) return true;
      connection.close(CLOSE.ACCESS_LOST, "Access changed");
    } catch (error) {
      connection.close(this.lostAccess(connection) ? CLOSE.ACCESS_LOST : ACCESS_CODES.get(error?.code) ?? CLOSE.ACCESS_LOST, "Access changed");
    }
    return false;
  }

  /** Whether the device itself lost access (revoked, member removed,
   * household being deleted), as opposed to only its session ending.
   * Revoking a device also ends its sessions, so this is asked first. */
  lostAccess(connection) {
    const device = this.service.devices.get(connection.deviceId);
    const member = device && this.service.members.get(device.memberId);
    const household = member && this.service.households.get(member.householdId);
    return !device || Boolean(device.revokedAt) || !member?.active ||
      ["deletion_pending", "deleted"].includes(household?.lifecycleState);
  }

  /** Re-checks every connection of a household (or all), closing those that
   * lost access. Called whenever access may have changed. */
  revalidate(householdId) {
    const targets = householdId ? [...(this.households.get(householdId) ?? [])] : [...this.connections.values()];
    for (const connection of targets) this.stillAllowed(connection);
  }

  /** New events were accepted: tell the household's other devices. */
  eventsAccepted(householdId, authorDeviceId) {
    for (const connection of this.households.get(householdId) ?? [])
      if (connection.deviceId !== authorDeviceId) connection.send(LIVE_TYPE.SYNC_HINT);
  }

  /** Closes every connection (service shutdown). */
  closeAll(code = CLOSE.GOING_AWAY) {
    for (const connection of [...this.connections.values()]) connection.close(code, "Service stopping");
  }
}
