// Sign-in links (#98). A computer signing in with a phone shows a QR code for
// `/link#r=<request>&s=<secret>&f=<fingerprint>&c=<nonce>`. Everything rides
// in the fragment, which browsers never send to a server. The phone reads the
// link with Kin's own scanner and sends the request ID, the secret and the
// fingerprint to the service in request bodies. The nonce never leaves the
// two devices: it travels only through the camera.
//
// The 6-digit code. The phone derives it from the nonce, the request, its own
// key fingerprint and the computer's (signInCode), and tells the service only
// so it can check what the computer types. The service tells the computer
// which device approved and that device's fingerprint; the computer derives
// the same code from them. A service that named a different approver (to get
// its own key pinned) would need a code it can't compute without the nonce,
// so what the person types wouldn't match, and the computer stops.
//
// The secret and nonce are base64url and case-sensitive, so these helpers read
// the link as given and never through the router, which lower-cases
// fragments.

export const LINK_PATH = "/link";
/** The 6-digit code the phone shows and the computer types. */
export const LINK_CODE_LENGTH = 6;

const REQUEST_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_LINK = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** A fresh nonce for one request: 16 random bytes. */
export function linkNonce(random = globalThis.crypto) {
  return base64url(random.getRandomValues(new Uint8Array(16)));
}

/** The sign-in link for a request on `origin`. The fingerprint (64 hex) is
 * carried as base64url to keep the QR code small. */
export function signInLink(origin, { requestId, secret, fingerprint, nonce }) {
  const bytes = Uint8Array.from(fingerprint.match(/../g), (pair) => parseInt(pair, 16));
  return `${origin}${LINK_PATH}#r=${requestId}&s=${secret}&f=${base64url(bytes)}&c=${nonce}`;
}

/** The request in a scanned sign-in link, or null unless the link is exactly
 * one on `origin` with a well-formed request ID, secret, fingerprint and
 * nonce, and nothing else. The fingerprint comes back as 64 hex. */
export function signInRequest(link, origin) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (typeof origin !== "string" || url.origin !== origin || url.pathname !== LINK_PATH) return null;
  if (url.search || url.username || url.password) return null;
  const fields = new Map();
  for (const part of url.hash.replace(/^#/, "").split("&")) {
    const at = part.indexOf("=");
    if (at < 1) return null;
    const name = part.slice(0, at);
    if (fields.has(name)) return null;
    fields.set(name, part.slice(at + 1));
  }
  if (fields.size !== 4) return null;
  const requestId = fields.get("r") ?? "";
  const secret = fields.get("s") ?? "";
  const packed = fields.get("f") ?? "";
  const nonce = fields.get("c") ?? "";
  if (!REQUEST_ID.test(requestId) || !SECRET.test(secret) || !FINGERPRINT_LINK.test(packed) || !NONCE.test(nonce))
    return null;
  const bytes = fromBase64url(packed);
  if (bytes.length !== 32) return null;
  const fingerprint = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { requestId, secret, fingerprint, nonce };
}

/** The 6-digit code for a request: SHA-256 over a label, the request ID, the
 * nonce, the approving device's fingerprint and the computer's, read as a
 * 32-bit number and reduced to six digits (the bias is below one in 4000). */
export async function signInCode({ requestId, nonce, approverFingerprint, computerFingerprint }) {
  if (!REQUEST_ID.test(requestId ?? "") || !NONCE.test(nonce ?? "") ||
      !FINGERPRINT.test(approverFingerprint ?? "") || !FINGERPRINT.test(computerFingerprint ?? ""))
    throw new Error("Kin could not derive the sign-in code.");
  const input = new TextEncoder().encode(`kin-link-code-v1|${requestId}|${nonce}|${approverFingerprint}|${computerFingerprint}`);
  const hash = new DataView(await globalThis.crypto.subtle.digest("SHA-256", input));
  return String(hash.getUint32(0) % 1_000_000).padStart(LINK_CODE_LENGTH, "0");
}

let openedLink = false;

/** A sign-in link opened in a browser, say by a phone's camera app, rather
 * than read by Kin's scanner: drop it from the address (and so from the
 * page's history entry) before any route is resolved, and remember that it
 * happened so People & devices can say where to scan it (kin-app.js). */
export function takeSignInLink(where = globalThis.location, past = globalThis.history) {
  if (!where || where.pathname !== LINK_PATH) return false;
  past?.replaceState(null, "", "/");
  openedLink = true;
  return true;
}

/** Whether a sign-in link was opened, once. */
export function consumeOpenedSignInLink() {
  const opened = openedLink;
  openedLink = false;
  return opened;
}

/** The digits of a typed code: spaces and dashes dropped, at most six. */
export function cleanLinkCode(raw) {
  return String(raw ?? "").replace(/[\s-]/g, "").slice(0, LINK_CODE_LENGTH);
}

/** Whether `code` is a whole 6-digit code. */
export function isLinkCode(code) {
  return /^[0-9]{6}$/.test(code);
}
