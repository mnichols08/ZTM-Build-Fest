// Invitation links (#97). The pairing code travels in the URL fragment
// (`/pair#code=F7KM-Q2DX`), which browsers never send to a server, so it can't
// reach a request URL, a server log or a Referer header.
//
// Kin's router also reads the fragment, so the code is taken out once, as the
// app loads and before any route is resolved, and the address bar is reset
// to `/pair` at once. The code then waits in memory until the join screen
// fills it in (consumeInvitationCode). A code in the query (links made before
// #97) is not used, because it has already travelled to the server; it is
// only removed from the address bar.

export const PAIR_PATH = "/pair";
const CODE_LENGTH = 9;

/** The invitation link for `code` on `origin`. */
export function invitationLink(origin, code) {
  return `${origin}${PAIR_PATH}#code=${encodeURIComponent(code)}`;
}

/** A pairing code as typed or read: trimmed and cut to the field's length.
 * The service compares codes ignoring case and punctuation. */
export function cleanCode(raw) {
  return String(raw ?? "").trim().slice(0, CODE_LENGTH);
}

/** The code in a scanned invitation link, or "" when it has none. */
export function invitationCode(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return "";
  }
  if (url.pathname !== PAIR_PATH) return "";
  return cleanCode(codeParameter(url.hash.replace(/^#/, "")) ?? "");
}

/** Reads the code from the current /pair address and resets the address to
 * `/pair`. Returns "" when the address carries no code. */
export function takeInvitationCode(where = globalThis.location, past = globalThis.history) {
  if (!where || where.pathname !== PAIR_PATH) return "";
  const fromFragment = codeParameter(String(where.hash ?? "").replace(/^#/, ""));
  const fromQuery = codeParameter(String(where.search ?? "").replace(/^\?/, ""));
  if (fromFragment === null && fromQuery === null) return "";
  past?.replaceState(null, "", PAIR_PATH);
  return fromFragment === null ? "" : cleanCode(fromFragment);
}

/** The value of a `code` parameter, in any letter case, or null. The router
 * lower-cases fragments, so `#CODE=` reaches /pair as well. */
function codeParameter(text) {
  for (const [name, value] of new URLSearchParams(text)) if (name.toLowerCase() === "code") return value;
  return null;
}

let captured = "";

/** Takes the code from the address as the app loads (kin-app.js). */
export function captureInvitationCode(where, past) {
  const code = takeInvitationCode(where, past);
  if (code) captured = code;
  return code;
}

/** The captured code, once: the join screen fills its field with it. */
export function consumeInvitationCode() {
  const code = captured;
  captured = "";
  return code;
}
