// The live channel (#107): RFC 6455 handshake and framing written natively,
// and the /api/live endpoint's access rules, over real sockets.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import {
  acceptKey, CLOSE, closePayload, encodeFrame, encodeMessage, FrameParser, isClientKey, isValidCloseCode, OPCODE, parseMessage,
} from "./live/websocket.mjs";
import { LIVE_TYPE } from "./live/live-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

/** A client frame: masked, as browsers send them. */
function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true, rsv = 0, lengthOverride } = {}) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | rsv | opcode;
  if (extra === 0) header[1] = (mask ? 0x80 : 0) | (lengthOverride ?? length);
  else if (extra === 2) { header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(length, 2); }
  else { header[1] = (mask ? 0x80 : 0) | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(length, 6); }
  if (!mask) return Buffer.concat([header, payload]);
  const key = randomBytes(4);
  key.copy(header, 2 + extra);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) body[index] ^= key[index & 3];
  return Buffer.concat([header, body]);
}

// ---- Protocol -----------------------------------------------------------------

test("the handshake answers the RFC's own example key", () => {
  // RFC 6455 §1.3.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(isClientKey("dGhlIHNhbXBsZSBub25jZQ=="), true);
  for (const bad of ["", "short", "dGhlIHNhbXBsZSBub25jZQ", Buffer.alloc(15).toString("base64"), undefined])
    assert.equal(isClientKey(bad), false, String(bad));
});

test("the RFC's masked frame is read, but Kin takes binary only", () => {
  // RFC 6455 §5.7: a single-frame masked text message "Hello".
  const hello = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  // The parser owns what it is fed (it unmasks in place), so each gets a copy.
  const binary = Buffer.from(hello);
  binary[0] = 0x82;
  const [event] = new FrameParser().feed(Buffer.from(hello));
  assert.deepEqual(event, { type: "error", code: CLOSE.UNSUPPORTED_DATA, reason: "Kin uses binary messages only." });
  assert.equal(new FrameParser().feed(binary)[0].data.toString(), "Hello");
});

test("fragments reassemble, with control frames between them, across any chunking", () => {
  const frames = Buffer.concat([
    clientFrame(OPCODE.BINARY, Buffer.from("Hel"), { fin: false }),
    clientFrame(OPCODE.PING, Buffer.from("p")),
    clientFrame(OPCODE.CONTINUATION, Buffer.from("lo, "), { fin: false }),
    clientFrame(OPCODE.CONTINUATION, Buffer.from("Kin"), { fin: true }),
  ]);
  for (const size of [1, 2, 3, 7, frames.length]) {
    const parser = new FrameParser();
    const events = [];
    const copy = Buffer.from(frames);
    for (let at = 0; at < copy.length; at += size) events.push(...parser.feed(copy.subarray(at, at + size)));
    assert.deepEqual(events.map((event) => event.type), ["ping", "message"], `chunks of ${size}`);
    assert.equal(events[1].data.toString(), "Hello, Kin");
  }
});

test("16-bit and 64-bit lengths parse; a message past the cap is refused from its header", () => {
  const medium = randomBytes(300);
  assert.deepEqual(new FrameParser().feed(clientFrame(OPCODE.BINARY, medium))[0].data, medium);
  const large = randomBytes(70_000);
  assert.deepEqual(new FrameParser().feed(clientFrame(OPCODE.BINARY, large))[0].data, large);
  // Only the header of an oversized frame is needed to refuse it.
  const header = clientFrame(OPCODE.BINARY, Buffer.alloc(300_000)).subarray(0, 14);
  assert.equal(new FrameParser().feed(header)[0].code, CLOSE.TOO_BIG);
  // Fragments add up: the cap is for the whole message.
  const parser = new FrameParser({ maxMessage: 1000 });
  assert.deepEqual(parser.feed(clientFrame(OPCODE.BINARY, Buffer.alloc(600), { fin: false })), []);
  assert.equal(parser.feed(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(600)))[0].code, CLOSE.TOO_BIG);
});

test("thousands of tiny fragments in one chunk end in a refusal, never a crash", () => {
  const flood = [clientFrame(OPCODE.BINARY, Buffer.alloc(0), { fin: false })];
  for (let index = 0; index < 20_000; index += 1) flood.push(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(0), { fin: false }));
  const events = new FrameParser().feed(Buffer.concat(flood));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, CLOSE.TOO_BIG, "past 128 fragments the message is refused");
  // Up to the cap, fragments reassemble.
  const fine = [clientFrame(OPCODE.BINARY, Buffer.from("a"), { fin: false })];
  for (let index = 0; index < 126; index += 1) fine.push(clientFrame(OPCODE.CONTINUATION, Buffer.from("b"), { fin: false }));
  fine.push(clientFrame(OPCODE.CONTINUATION, Buffer.from("c")));
  const [message] = new FrameParser().feed(Buffer.concat(fine));
  assert.equal(message.data.length, 128);
});

test("protocol violations close with the right code", () => {
  const cases = [
    [clientFrame(OPCODE.BINARY, Buffer.from("x"), { mask: false }), CLOSE.PROTOCOL_ERROR, "unmasked"],
    [clientFrame(OPCODE.BINARY, Buffer.from("x"), { rsv: 0x40 }), CLOSE.PROTOCOL_ERROR, "compressed (RSV1)"],
    [clientFrame(0x3, Buffer.from("x")), CLOSE.PROTOCOL_ERROR, "reserved opcode"],
    [clientFrame(OPCODE.PING, Buffer.alloc(126)), CLOSE.PROTOCOL_ERROR, "oversized control frame"],
    [clientFrame(OPCODE.PING, Buffer.alloc(1), { fin: false }), CLOSE.PROTOCOL_ERROR, "fragmented control frame"],
    [clientFrame(OPCODE.CONTINUATION, Buffer.from("x")), CLOSE.PROTOCOL_ERROR, "continuation with no message"],
    [Buffer.concat([clientFrame(OPCODE.BINARY, Buffer.from("a"), { fin: false }), clientFrame(OPCODE.BINARY, Buffer.from("b"))]), CLOSE.PROTOCOL_ERROR, "new message mid-message"],
    [clientFrame(OPCODE.CLOSE, Buffer.from([0x03])), CLOSE.PROTOCOL_ERROR, "one-byte close"],
    [clientFrame(OPCODE.CLOSE, closePayload(1005)), CLOSE.PROTOCOL_ERROR, "reserved close code"],
    [clientFrame(OPCODE.CLOSE, Buffer.concat([closePayload(1000), Buffer.from([0xff])])), CLOSE.INVALID_DATA, "invalid UTF-8 reason"],
  ];
  for (const [bytes, code, name] of cases) {
    const events = new FrameParser().feed(bytes);
    assert.equal(events.at(-1).type, "error", name);
    assert.equal(events.at(-1).code, code, name);
  }
  // A 16-bit length that should have been 7-bit isn't minimal.
  const notMinimal = Buffer.from([0x82, 0xfe, 0x00, 0x05, 1, 2, 3, 4, 0, 0, 0, 0, 0]);
  assert.equal(new FrameParser().feed(notMinimal)[0].code, CLOSE.PROTOCOL_ERROR);
  // A parser that failed stays failed.
  const parser = new FrameParser();
  parser.feed(clientFrame(OPCODE.TEXT, Buffer.from("x")));
  assert.deepEqual(parser.feed(clientFrame(OPCODE.BINARY, Buffer.from("x"))), []);
});

test("close frames carry a code and reason; codes are checked", () => {
  const [close] = new FrameParser().feed(clientFrame(OPCODE.CLOSE, closePayload(4000, "bye")));
  assert.deepEqual(close, { type: "close", code: 4000, reason: "bye" });
  assert.deepEqual(new FrameParser().feed(clientFrame(OPCODE.CLOSE))[0], { type: "close", code: 1005, reason: "" });
  for (const code of [1000, 1001, 1011, 3000, 4999]) assert.equal(isValidCloseCode(code), true, code);
  for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000]) assert.equal(isValidCloseCode(code), false, code);
});

test("server frames are unmasked and minimally sized", () => {
  assert.deepEqual([...encodeFrame(OPCODE.PONG)], [0x8a, 0x00]);
  assert.deepEqual([...encodeFrame(OPCODE.BINARY, Buffer.alloc(200)).subarray(0, 4)], [0x82, 126, 0, 200]);
  const big = encodeFrame(OPCODE.BINARY, Buffer.alloc(70_000));
  assert.deepEqual([...big.subarray(0, 2)], [0x82, 127]);
  assert.equal(big.readUInt32BE(6), 70_000);
});

test("Kin records: an 8-byte little-endian header and an exact length", () => {
  const record = encodeMessage(0x02, Buffer.from([9, 8, 7]), 0x01);
  assert.deepEqual([...record], [0x02, 0x01, 0, 0, 3, 0, 0, 0, 9, 8, 7]);
  const parsed = parseMessage(record);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.flags, 1);
  assert.deepEqual([...parsed.payload], [9, 8, 7]);
  assert.equal(parsed.payload.buffer, record.buffer, "the payload is a view, not a copy");
  assert.equal(parseMessage(record.subarray(0, 7)), null, "short header");
  assert.equal(parseMessage(Buffer.concat([record, Buffer.from([0])])), null, "length mismatch");
  const reserved = Buffer.from(record);
  reserved[2] = 1;
  assert.equal(parseMessage(reserved), null, "reserved bits set");
});

// ---- The endpoint -------------------------------------------------------------

/** A server with one household: two of the Adult's devices. */
async function rig(live = {}) {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("phone"), deviceLabel: "Phone" });
  const application = createKinServer({ store: new DurableStore(":memory:"), service, origin: "http://localhost", live });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const port = application.server.address().port;
  // A second trusted device for the same member.
  const pairing = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({ code: pairing.code, credential: credential("laptop"), deviceLabel: "Laptop" });
  service.approvePairing(adult.sessionToken, pairing.pairingId, claim.version);
  const laptop = service.activateClaim(claim.claimToken);
  return {
    application, service, port, adult, laptop,
    close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => application.store.close()),
  };
}

/** A raw client: performs the handshake and reads server frames. */
async function open(port, { session, origin = "http://localhost", key = randomBytes(16).toString("base64"), extraHeaders = "", path = "/api/live" } = {}) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n` +
    (origin ? `Origin: ${origin}\r\n` : "") + (session ? `Cookie: kin_session=${session}\r\n` : "") + extraHeaders + "\r\n",
  );
  let buffer = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  let status = null;
  let headers = "";
  let ended = false;
  const parse = () => {
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = buffer.readUInt32BE(6); offset = 10; }
      if (buffer.length < offset + length) return;
      frames.push({ opcode: buffer[0] & 0x0f, data: buffer.subarray(offset, offset + length) });
      buffer = buffer.subarray(offset + length);
    }
  };
  const notify = () => { for (const waiter of waiters.splice(0)) waiter(); };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (status === null) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      headers = buffer.subarray(0, end).toString();
      status = Number(headers.split(" ")[1]);
      buffer = buffer.subarray(end + 4);
    }
    parse();
    notify();
  });
  socket.on("close", () => { ended = true; notify(); });
  socket.on("error", () => {});
  const until = async (predicate, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  await until(() => status !== null || ended);
  const records = () => frames.filter((frame) => frame.opcode === OPCODE.BINARY).map((frame) => parseMessage(frame.data));
  const closeFrame = () => {
    const frame = frames.find((entry) => entry.opcode === OPCODE.CLOSE);
    return frame && { code: frame.data.readUInt16BE(0), reason: frame.data.subarray(2).toString() };
  };
  return {
    socket, frames, records, closeFrame, until,
    get status() { return status; },
    get headers() { return headers; },
    get ended() { return ended; },
    send: (bytes) => socket.write(bytes),
  };
}

test("a trusted device opens the live channel and is greeted", async () => {
  const r = await rig();
  try {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const client = await open(r.port, { session: r.adult.sessionToken, key });
    assert.equal(client.status, 101);
    assert.match(client.headers, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.doesNotMatch(client.headers, /Sec-WebSocket-Extensions|Sec-WebSocket-Protocol/i, "no extension or subprotocol is accepted");
    await client.until(() => client.records().length);
    assert.equal(client.records()[0].type, LIVE_TYPE.HELLO);
    // Ping → pong with the same payload.
    client.send(clientFrame(OPCODE.PING, Buffer.from("hi")));
    await client.until(() => client.frames.some((frame) => frame.opcode === OPCODE.PONG));
    assert.equal(client.frames.find((frame) => frame.opcode === OPCODE.PONG).data.toString(), "hi");
    // A clean close is echoed.
    client.send(clientFrame(OPCODE.CLOSE, closePayload(1000)));
    await client.until(() => client.ended);
    assert.equal(client.closeFrame().code, 1000);
    assert.equal(r.application.liveService.connections.size, 0);
  } finally {
    await r.close();
  }
});

test("the upgrade is refused without the right origin, a session, or a proper handshake", async () => {
  const r = await rig();
  try {
    const session = r.adult.sessionToken;
    assert.equal((await open(r.port, { session, origin: "https://evil.example" })).status, 403, "cross-site origin");
    assert.equal((await open(r.port, { session, origin: null })).status, 403, "no origin at all");
    assert.equal((await open(r.port, {})).status, 401, "no session");
    assert.equal((await open(r.port, { session: "forged" })).status, 401, "unknown session");
    assert.equal((await open(r.port, { session, key: "bad" })).status, 400, "bad key");
    assert.equal((await open(r.port, { session, extraHeaders: "Sec-WebSocket-Protocol: chat\r\n" })).status, 400, "subprotocol");
    assert.equal((await open(r.port, { session, path: "/api/other" })).status, 404, "other path");
    assert.equal(r.application.liveService.connections.size, 0);
  } finally {
    await r.close();
  }
});

test("a text message, an unmasked frame or an unknown record type closes the socket", async () => {
  const r = await rig();
  try {
    for (const [bytes, code] of [
      [clientFrame(OPCODE.TEXT, Buffer.from("hi")), CLOSE.UNSUPPORTED_DATA],
      [clientFrame(OPCODE.BINARY, Buffer.from("hi"), { mask: false }), CLOSE.PROTOCOL_ERROR],
      [clientFrame(OPCODE.BINARY, encodeMessage(0x7f)), CLOSE.UNSUPPORTED_DATA],
      [clientFrame(OPCODE.BINARY, Buffer.from([1, 2, 3])), CLOSE.INVALID_DATA],
    ]) {
      const client = await open(r.port, { session: r.adult.sessionToken });
      client.send(bytes);
      await client.until(() => client.ended);
      assert.equal(client.closeFrame()?.code, code);
    }
  } finally {
    await r.close();
  }
});

test("one socket per device: a new one replaces the old", async () => {
  const r = await rig();
  try {
    const first = await open(r.port, { session: r.adult.sessionToken });
    const second = await open(r.port, { session: r.adult.sessionToken });
    await first.until(() => first.ended);
    assert.equal(first.closeFrame().code, CLOSE.REPLACED);
    assert.equal(second.ended, false);
    assert.equal(r.application.liveService.connections.size, 1);
  } finally {
    await r.close();
  }
});

test("revoking the device closes its socket at once; signing out closes with 4401", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    // Revoke the laptop as the revocation route does (after its passkey check).
    r.service.revokeDevice(r.adult.sessionToken, r.laptop.deviceId, r.adult.memberId);
    r.application.syncService.onAccessChange(r.adult.householdId, [r.laptop.deviceId]);
    await laptop.until(() => laptop.ended);
    assert.equal(laptop.closeFrame().code, CLOSE.ACCESS_LOST);
    assert.equal(phone.ended, false, "the household's other device stays connected");
    // Signing out ends the phone's session.
    await fetch(`http://127.0.0.1:${r.port}/api/logout`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: `kin_session=${r.adult.sessionToken}` }, body: "{}",
    });
    await phone.until(() => phone.ended);
    assert.equal(phone.closeFrame().code, CLOSE.SESSION_ENDED);
  } finally {
    await r.close();
  }
});

test("a deleted household's sockets close", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    r.service.requestHouseholdDeletion(r.adult.sessionToken, r.adult.memberId);
    r.application.liveService.revalidate(r.adult.householdId);
    await phone.until(() => phone.ended);
    assert.equal(phone.closeFrame().code, CLOSE.ACCESS_LOST);
  } finally {
    await r.close();
  }
});

test("accepted events nudge the household's other devices, never the author", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    r.application.liveService.eventsAccepted(r.adult.householdId, r.adult.deviceId);
    await laptop.until(() => laptop.records().length === 2);
    assert.equal(laptop.records()[1].type, LIVE_TYPE.SYNC_HINT);
    assert.equal(laptop.records()[1].payload.length, 0, "the hint says nothing about what changed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(phone.records().length, 1, "the author isn't nudged");
  } finally {
    await r.close();
  }
});

test("two unanswered pings close the socket; answering keeps it open and re-checks the session", async () => {
  const r = await rig({ pingInterval: 60 });
  try {
    const silent = await open(r.port, { session: r.adult.sessionToken });
    await silent.until(() => silent.ended, 2000);
    assert.equal(silent.closeFrame().code, CLOSE.GOING_AWAY);
    assert.ok(silent.frames.filter((frame) => frame.opcode === OPCODE.PING).length >= 2);

    const lively = await open(r.port, { session: r.laptop.sessionToken });
    lively.socket.on("data", () => {
      for (const frame of lively.frames.splice(0)) if (frame.opcode === OPCODE.PING) lively.send(clientFrame(OPCODE.PONG, frame.data));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(lively.ended, false, "a peer that answers stays connected");
    // The session ends behind its back: the next ping notices.
    r.service.logout(r.laptop.sessionToken);
    await lively.until(() => lively.ended, 2000);
  } finally {
    await r.close();
  }
});

test("a client that stops reading is dropped once its queue passes the limit", async () => {
  const r = await rig({ maxQueued: 64 * 1024 });
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    client.socket.pause();
    const connection = r.application.liveService.connections.get(r.adult.deviceId);
    const big = Buffer.alloc(32 * 1024);
    for (let index = 0; index < 400 && !connection.closing; index += 1) connection.send(0x03, big);
    assert.equal(connection.closing, true, "the slow consumer is closed (4429)");
    assert.equal(connection.queuedBytes, 0, "and its queue dropped");
    assert.equal(r.application.liveService.connections.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(connection.disposed, true, "its socket goes after a short grace");
    assert.equal(r.application.liveService.sockets.size, 0);
  } finally {
    await r.close();
  }
});

test("a flood of fragments over the socket closes it with 1009 and the service lives on", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    const flood = [clientFrame(OPCODE.BINARY, Buffer.alloc(0), { fin: false })];
    for (let index = 0; index < 5_000; index += 1) flood.push(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(0), { fin: false }));
    client.send(Buffer.concat(flood));
    await client.until(() => client.ended);
    assert.equal(client.closeFrame()?.code, CLOSE.TOO_BIG);
    const again = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(again.status, 101, "the service still answers");
  } finally {
    await r.close();
  }
});

test("a client that half-closes is let go at once", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    await client.until(() => client.records().length);
    client.socket.end();
    const live = r.application.liveService;
    const deadline = Date.now() + 1000;
    while (live.sockets.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(live.connections.size, 0);
    assert.equal(live.sockets.size, 0);
  } finally {
    await r.close();
  }
});

test("bytes sent with the upgrade request are read after it is accepted", async () => {
  const r = await rig();
  try {
    const socket = connect(r.port, "127.0.0.1");
    await once(socket, "connect");
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.write(Buffer.concat([
      Buffer.from(`GET /api/live HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nOrigin: http://localhost\r\n` +
        `Cookie: kin_session=${r.adult.sessionToken}\r\n\r\n`),
      clientFrame(OPCODE.PING, Buffer.from("early")),
    ]));
    const deadline = Date.now() + 2000;
    while (!Buffer.concat(chunks).includes(Buffer.from("early")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(Buffer.concat(chunks).includes(Buffer.from([0x8a, 5, ...Buffer.from("early")])), "the early ping is answered");
    socket.destroy();
  } finally {
    await r.close();
  }
});

test("the socket closes when the session expires, without waiting for a ping", async () => {
  const r = await rig();
  try {
    const auth = r.service.authorize(r.adult.sessionToken);
    auth.session.expiresAt = r.service.now() + 150;
    const client = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(client.status, 101);
    await client.until(() => client.ended, 2000);
    assert.equal(client.closeFrame()?.code, CLOSE.SESSION_ENDED);
  } finally {
    await r.close();
  }
});

test("a Temporary member's socket closes when the membership ends", async () => {
  const r = await rig();
  try {
    const member = r.service.members.get(r.adult.memberId);
    member.kind = "temporary";
    member.expiresAt = r.service.now() + 150;
    const client = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(client.status, 101);
    await client.until(() => client.ended, 2000);
    assert.equal(client.closeFrame()?.code, CLOSE.ACCESS_LOST);
  } finally {
    await r.close();
  }
});

test("a storage failure is a server error, not lost access", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    const authorize = r.service.authorize;
    r.service.authorize = () => { throw new Error("disk gone"); };
    r.application.liveService.revalidate(r.adult.householdId);
    await client.until(() => client.ended);
    assert.equal(client.closeFrame()?.code, CLOSE.SERVER_ERROR);
    assert.equal((await open(r.port, { session: r.adult.sessionToken })).status, 503, "and the upgrade says unavailable");
    r.service.authorize = authorize;
  } finally {
    await r.close();
  }
});

test("the connection limit counts every socket; a wrong version gets 426", async () => {
  const r = await rig({ maxConnections: 1 });
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(phone.status, 101);
    assert.equal((await open(r.port, { session: r.laptop.sessionToken })).status, 503, "a second device past the limit");
    assert.equal((await open(r.port, { session: r.adult.sessionToken })).status, 101, "the same device still replaces its own");
    const old = await open(r.port, { session: r.adult.sessionToken, extraHeaders: "" });
    assert.equal(old.status, 101);
    const versioned = connect(r.port, "127.0.0.1");
    await once(versioned, "connect");
    versioned.write(`GET /api/live HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nOrigin: http://localhost\r\n\r\n`);
    const [answer] = await once(versioned, "data");
    assert.match(answer.toString(), /^HTTP\/1.1 426 Upgrade Required/);
    assert.match(answer.toString(), /Sec-WebSocket-Version: 13/);
    versioned.destroy();
  } finally {
    await r.close();
  }
});

test("sync hints waiting behind a full socket are queued once", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    client.socket.pause();
    const connection = r.application.liveService.connections.get(r.adult.deviceId);
    connection.blocked = true; // as if the socket refused more
    for (let index = 0; index < 1000; index += 1) r.application.liveService.eventsAccepted(r.adult.householdId, r.laptop.deviceId);
    assert.equal(connection.queue.length, 1, "one hint says it all");
    connection.flush();
    assert.equal(connection.queuedHint, false);
  } finally {
    await r.close();
  }
});

test("stopping the service doesn't wait on a peer that ignores the close", async () => {
  const r = await rig();
  const client = await open(r.port, { session: r.adult.sessionToken });
  client.socket.pause(); // never reads the close frame, never answers
  const started = Date.now();
  await r.close();
  assert.ok(Date.now() - started < 1500, `stopped in ${Date.now() - started} ms`);
});

test("closing the service closes live sockets", async () => {
  const r = await rig();
  const client = await open(r.port, { session: r.adult.sessionToken });
  await r.close();
  await client.until(() => client.ended);
  assert.equal(client.closeFrame()?.code, CLOSE.GOING_AWAY);
});
