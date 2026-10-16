// Which client a request comes from, for per-client limits (pairing-code
// guessing; bootstrap limits reuse it).
//
// Kin listens on loopback, so a hosted deployment sits behind a TLS proxy and
// every request arrives from the proxy's address. Without configuration that
// is all Kin can see, and every client shares one limit. An operator who runs
// a proxy that appends the real client address to X-Forwarded-For lists that
// proxy's address in KIN_TRUSTED_PROXIES. Only then is the header read, and
// only from those addresses.
import { isIP } from "node:net";

/** Parses KIN_TRUSTED_PROXIES: comma-separated IP addresses. Empty means off. */
export function parseTrustedProxies(value) {
  if (value === undefined || value === null || value === "") return new Set();
  const entries = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries)
    if (!isIP(normalizeAddress(entry)))
      throw new Error(`KIN_TRUSTED_PROXIES must list IP addresses; "${entry}" is not one.`);
  return new Set(entries.map(normalizeAddress));
}

/** IPv4-mapped IPv6 ("::ffff:203.0.113.5") compares equal to its IPv4 form. */
export function normalizeAddress(address) {
  const value = String(address ?? "").trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return (mapped ? mapped[1] : value).toLowerCase();
}

/**
 * The rate-limit key for `request`. With no trusted proxies, or when the
 * connection is not from one, it is the socket's address and any
 * X-Forwarded-For header is ignored. From a trusted proxy it is the
 * right-most forwarded hop that is not itself a trusted proxy: hops to its
 * left were written by the client and can be spoofed. A malformed hop falls
 * back to the proxy's own address, which never loosens the limit.
 */
export function clientKey(request, trustedProxies) {
  const peer = normalizeAddress(request.socket?.remoteAddress) || "unknown";
  if (!trustedProxies?.size || !trustedProxies.has(peer)) return peer;
  const header = request.headers?.["x-forwarded-for"];
  if (typeof header !== "string" || header.length > 4096) return peer;
  const hops = header.split(",").map(normalizeAddress);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index];
    if (!isIP(hop)) return peer;
    if (!trustedProxies.has(hop)) return hop;
  }
  return peer;
}
