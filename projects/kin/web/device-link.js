// Sign-in links (#98). A computer signing in with a phone shows a QR code for
// `/link#r=<request>&s=<secret>&f=<fingerprint>`. Everything rides in the
// fragment, which browsers never send to a server; the phone reads the link
// with Kin's own scanner and sends the secret only in request bodies.
//
// The secret is base64url and case-sensitive, so these helpers read the link
// as given and never through the router, which lower-cases fragments.

export const LINK_PATH = "/link";
/** The 6-digit code the phone shows and the computer types. */
export const LINK_CODE_LENGTH = 6;

const REQUEST_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

/** The sign-in link for a request on `origin`. */
export function signInLink(origin, { requestId, secret, fingerprint }) {
  return `${origin}${LINK_PATH}#r=${requestId}&s=${secret}&f=${fingerprint}`;
}

/** The request in a scanned sign-in link, or null unless the link is
 * exactly one on `origin` with a well-formed request ID, secret and
 * fingerprint and nothing else. */
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
  if (fields.size !== 3) return null;
  const requestId = fields.get("r");
  const secret = fields.get("s");
  const fingerprint = fields.get("f");
  if (!REQUEST_ID.test(requestId ?? "") || !SECRET.test(secret ?? "") || !FINGERPRINT.test(fingerprint ?? ""))
    return null;
  return { requestId, secret, fingerprint };
}

/** The digits of a typed code: spaces and dashes dropped, at most six. */
export function cleanLinkCode(raw) {
  return String(raw ?? "").replace(/[\s-]/g, "").slice(0, LINK_CODE_LENGTH);
}

/** Whether `code` is a whole 6-digit code. */
export function isLinkCode(code) {
  return /^[0-9]{6}$/.test(code);
}
