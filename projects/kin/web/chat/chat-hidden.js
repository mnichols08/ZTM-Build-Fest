// "Delete for me" (#119): the chat messages a member hid, on all of their
// devices and nobody else's.
//
// Hiding can't be a household event: every member's devices hold the
// household keys. So each member has one record on the service, sealed to
// that member's own trusted devices and replaced compare-and-set
// (server/chat-relay-service.mjs). Format 1:
//
//   { version: 1, householdId, memberId, revision, senderDeviceId,
//     nonce, ciphertext,            the hidden message IDs, AES-256-GCM
//     recipients: [{ deviceId, fingerprint, ephemeralPublicKey, salt,
//                    nonce, wrappedKey }],   the content key for each of
//                                            the member's devices
//     signature }                   the sending device's ECDSA signature
//
// The content key is new for every revision. Each recipient's copy is
// wrapped with ECDH P-256 (a fresh ephemeral key) and HKDF-SHA-256 to that
// device's agreement key, so only the member's own devices can open the
// record: no member-wide key has to be provisioned, and a device the member
// adds can read the record once another of their devices writes it again.
// The additional data binds household, member, revision and sender; the
// signature covers every field, so the service can neither forge a record
// nor move one to another member or revision (it can still serve an older
// one, which only shows fewer hidden messages until a device writes again).
import { importDevicePublicKeys } from "../sync/crypto.js";

const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Most IDs one record holds (the service's 256 KiB bound, with room). */
export const MAX_HIDDEN_MESSAGES = 10_000;

export class ChatHiddenError extends Error {
  constructor(message, code = "chat_hidden_invalid") {
    super(message);
    this.name = "ChatHiddenError";
    this.code = code;
  }
}

const invalid = () => new ChatHiddenError("Kin couldn't read this member's hidden messages.");
const isId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

function toBase64Url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw invalid();
  const text = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** Length-prefixed fields, so no two field lists share an encoding. */
function fields(values) {
  const parts = values.map((value) => (typeof value === "string" ? encoder.encode(value) : value));
  const bytes = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

/** Keys sorted at every level, so the signed bytes are one string. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const contentAad = ({ householdId, memberId, revision, senderDeviceId }) =>
  fields(["kin.chat.hidden.content.v1", householdId, memberId, String(revision), senderDeviceId]);

async function wrappingKey(sharedSecret, salt, info, usage) {
  const material = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

/**
 * Seals the hidden message IDs for the member's devices. `recipients` are
 * the member's trusted devices from the verified directory ({ deviceId,
 * fingerprint, publicKeys }), the sender among them.
 */
export async function sealHiddenRecord({ ids, householdId, memberId, revision, senderDeviceId, signingKey, recipients }) {
  const list = [...new Set(ids)].sort();
  if (!list.every(isId) || list.length > MAX_HIDDEN_MESSAGES) throw new ChatHiddenError("Too many hidden messages to keep.", "chat_hidden_full");
  if (!recipients.length || recipients.length > 64 || !recipients.some((entry) => entry.deviceId === senderDeviceId)) throw invalid();
  const header = { householdId, memberId, revision, senderDeviceId };
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const contentKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: contentAad(header) }, contentKey, encoder.encode(JSON.stringify({ ids: list }))));
    const wrapped = [];
    for (const recipient of recipients) {
      const keys = await importDevicePublicKeys(recipient.publicKeys);
      const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const ephemeralPublicKey = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: keys.agreement }, ephemeral.privateKey, 256));
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const keyNonce = crypto.getRandomValues(new Uint8Array(12));
      const info = fields(["kin.chat.hidden.key.v1", contentAad(header), recipient.deviceId, recipient.fingerprint ?? ""]);
      try {
        const wrapKey = await wrappingKey(shared, salt, info, "encrypt");
        const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: keyNonce, additionalData: info }, wrapKey, rawKey));
        wrapped.push({ deviceId: recipient.deviceId, fingerprint: recipient.fingerprint ?? "", ephemeralPublicKey, salt: toBase64Url(salt), nonce: toBase64Url(keyNonce), wrappedKey: toBase64Url(wrappedKey) });
      } finally {
        shared.fill(0);
      }
    }
    const record = { version: VERSION, ...header, nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext), recipients: wrapped };
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey,
      fields(["kin.chat.hidden.signature.v1", canonical(record)])));
    return { ...record, signature: toBase64Url(signature) };
  } finally {
    rawKey.fill(0);
  }
}

/**
 * Opens a record for this device and returns its message IDs. `senders` are
 * the member's trusted devices from the verified directory: the record must
 * be signed by one of them (any key in its verified history), and name this
 * household, member and the revision the service gave. A record not sealed
 * to this device (written before it joined) throws `chat_hidden_not_for_me`.
 */
export async function openHiddenRecord({ record, householdId, memberId, revision, deviceId, agreementPrivateKey, senders }) {
  if (!record || record.version !== VERSION || record.householdId !== householdId || record.memberId !== memberId ||
      record.revision !== revision || !Array.isArray(record.recipients)) throw invalid();
  const sender = senders.find((device) => device.deviceId === record.senderDeviceId);
  if (!sender || sender.memberId !== memberId || sender.revokedAt) throw invalid();
  const { signature, ...signed } = record;
  const signatureBytes = fromBase64Url(signature);
  const message = fields(["kin.chat.hidden.signature.v1", canonical(signed)]);
  let verified = false;
  for (const entry of sender.verifiedKeyHistory ?? [{ publicKeys: sender.publicKeys }]) {
    const keys = await importDevicePublicKeys(entry.publicKeys);
    if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.signing, signatureBytes, message)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw invalid();
  const mine = record.recipients.find((entry) => entry.deviceId === deviceId);
  if (!mine) throw new ChatHiddenError("This device was added after the hidden messages were saved.", "chat_hidden_not_for_me");
  const header = { householdId, memberId, revision, senderDeviceId: record.senderDeviceId };
  try {
    const ephemeral = await crypto.subtle.importKey("jwk", mine.ephemeralPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, agreementPrivateKey, 256));
    const info = fields(["kin.chat.hidden.key.v1", contentAad(header), mine.deviceId, mine.fingerprint ?? ""]);
    let rawKey;
    try {
      const unwrapKey = await wrappingKey(shared, fromBase64Url(mine.salt), info, "decrypt");
      rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(mine.nonce), additionalData: info }, unwrapKey, fromBase64Url(mine.wrappedKey)));
    } finally {
      shared.fill(0);
    }
    try {
      const contentKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(record.nonce), additionalData: contentAad(header) }, contentKey, fromBase64Url(record.ciphertext));
      const { ids } = JSON.parse(decoder.decode(plain));
      if (!Array.isArray(ids) || ids.length > MAX_HIDDEN_MESSAGES || !ids.every(isId)) throw invalid();
      return ids;
    } finally {
      rawKey.fill(0);
    }
  } catch (error) {
    if (error instanceof ChatHiddenError) throw error;
    throw invalid();
  }
}
