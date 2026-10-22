// A minimal in-process ACME server for the tests (#723). Not used by Kin at
// run time and never contacted by anything but the tests on loopback.
//
// It implements just enough of RFC 8555 to drive the client end to end, and
// checks what a real CA checks on the client's side of the wire:
//
//   - every POST is a flattened JWS: ES256, a nonce it issued (single use),
//     `url` equal to the request URL, exactly one of `jwk` (newAccount only)
//     and `kid` (a known account), and a valid signature;
//   - newAccount needs termsOfServiceAgreed, and answers 200 with the same
//     account for a key that already has one;
//   - each authorization offers one tls-alpn-01 challenge; answering it makes
//     the server connect to the home TLS server over loopback with SNI = the
//     name and ALPN ["acme-tls/1"], and check the negotiated protocol, the
//     certificate's single dNSName and its critical acmeIdentifier extension
//     against SHA-256(token.thumbprint) (RFC 8737 §3);
//   - finalize verifies the CSR's signature and that its names match the
//     order, then issues from a test CA after one "processing" poll.
//
// Knobs for failure tests: `failNext(endpoint, problem, { status, retryAfter })`,
// `badNonceOnce()`, `holdPolls` (authorization polls answered "pending" after
// validation, with Retry-After: 3), and `lifetimeMs` / `now` for validity.
import { X509Certificate, createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:tls";
import { boolean, decodeObjectIdentifier, readChildren, readTlv, sequence } from "./der.mjs";
import { jwkThumbprint } from "./keys.mjs";
import { OID, buildCertificate, extension, spkiDer, subjectAltNameExtension, toPem } from "./x509.mjs";

const b64 = (value) => Buffer.from(value).toString("base64url");
const token = () => b64(randomBytes(32));

/** The extensions of a DER certificate: [{ oid, critical, value }]. */
export function certificateExtensions(der) {
  const certificate = readTlv(der);
  const [tbs] = readChildren(certificate.value);
  const extensionsField = readChildren(tbs.value).find((item) => item.tag === 0xa3);
  if (!extensionsField) return [];
  const [list] = readChildren(extensionsField.value);
  return readChildren(list.value).map((item) => {
    const parts = readChildren(item.value);
    const critical = parts.length === 3 && parts[1].tag === 0x01 && parts[1].value[0] === 0xff;
    return { oid: decodeObjectIdentifier(parts[0].value), critical, value: parts[parts.length - 1].value };
  });
}

/** Parse a DER CSR: { info, publicKey, signature, names }. */
export function parseCsr(der) {
  const [info, , signatureField] = readChildren(readTlv(der).value);
  const [, , spki, attributes] = readChildren(info.value);
  const names = [];
  if (attributes?.tag === 0xa0) {
    for (const attribute of readChildren(attributes.value)) {
      const [oid, values] = readChildren(attribute.value);
      if (decodeObjectIdentifier(oid.value) !== OID.extensionRequest) continue;
      const [extensions] = readChildren(values.value);
      for (const item of readChildren(extensions.value)) {
        const parts = readChildren(item.value);
        if (decodeObjectIdentifier(parts[0].value) !== OID.subjectAltName) continue;
        const [san] = readChildren(parts[parts.length - 1].value);
        for (const general of readChildren(san.value)) if (general.tag === 0x82) names.push(general.value.toString("ascii"));
      }
    }
  }
  return { info: info.raw, publicKey: createPublicKey({ key: Buffer.from(spki.raw), format: "der", type: "spki" }), signature: signatureField.value.subarray(1), names };
}

/** Check a TLS-ALPN-01 answer by connecting to `host:port` (RFC 8737 §3). */
export function validateTlsAlpn({ host = "127.0.0.1", port, name, keyAuthorization, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: name, ALPNProtocols: ["acme-tls/1"], rejectUnauthorized: false });
    const finish = (result) => { clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, type: "connection", detail: "timed out" }), timeoutMs);
    socket.on("error", (error) => finish({ ok: false, type: "tls", detail: error.message }));
    socket.on("secureConnect", () => {
      if (socket.alpnProtocol !== "acme-tls/1") { finish({ ok: false, type: "tls", detail: "acme-tls/1 not negotiated" }); return; }
      const raw = socket.getPeerCertificate(false)?.raw;
      if (!raw) { finish({ ok: false, type: "tls", detail: "no certificate" }); return; }
      const certificate = new X509Certificate(raw);
      if (certificate.subjectAltName !== `DNS:${name}`) { finish({ ok: false, type: "incorrectResponse", detail: "SAN must be exactly the name" }); return; }
      const identifier = certificateExtensions(raw).filter((item) => item.oid === OID.acmeIdentifier);
      const expected = Buffer.concat([Buffer.from([0x04, 0x20]), createHash("sha256").update(keyAuthorization).digest()]);
      if (identifier.length !== 1 || !identifier[0].critical || !identifier[0].value.equals(expected)) {
        finish({ ok: false, type: "incorrectResponse", detail: "acmeIdentifier missing, not critical or wrong" });
        return;
      }
      finish({ ok: true });
    });
  });
}

export async function startAcmeTestServer({ validationPort, validationHost = "127.0.0.1", lifetimeMs = 90 * 24 * 60 * 60 * 1000, now = Date.now, holdPolls = 1 } = {}) {
  const ca = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const caDer = buildCertificate({
    subjectPublicKeyInfo: spkiDer(ca), subject: "Kin Test ACME CA", notBefore: now() - 86_400_000, notAfter: now() + 3650 * 86_400_000,
    extensions: [extension(OID.basicConstraints, sequence(boolean(true)), true)], signingKey: ca,
  });
  const state = {
    nonces: new Set(), accounts: new Map(), orders: new Map(), authorizations: new Map(), challenges: new Map(), certificates: new Map(),
    log: [], failures: [], badNonce: false, validationPort, validationHost, lifetimeMs, now, holdPolls, issued: [],
  };
  let base = "";
  const nonce = () => { const value = b64(randomBytes(16)); state.nonces.add(value); return value; };

  function send(response, status, body, headers = {}) {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, { "replay-nonce": nonce(), "cache-control": "no-store", ...(typeof body === "object" ? { "content-type": headers["content-type"] ?? "application/json" } : {}), ...headers });
    response.end(text);
  }
  const problem = (response, status, type, detail, headers) => send(response, status, { type: `urn:ietf:params:acme:error:${type}`, detail }, { "content-type": "application/problem+json", ...headers });

  function authenticate(request, raw) {
    let jws; let header; let payload;
    try {
      jws = JSON.parse(raw);
      header = JSON.parse(Buffer.from(jws.protected, "base64url").toString("utf8"));
      payload = jws.payload === "" ? undefined : JSON.parse(Buffer.from(jws.payload, "base64url").toString("utf8"));
    } catch { return { error: ["malformed", "not a flattened JWS"] }; }
    if (request.headers["content-type"] !== "application/jose+json") return { error: ["malformed", "content type must be application/jose+json"] };
    if (header.alg !== "ES256") return { error: ["badSignatureAlgorithm", "ES256 only"] };
    if (header.url !== `${base}${request.url}`) return { error: ["unauthorized", "url mismatch"] };
    if (!state.nonces.delete(header.nonce)) return { error: ["badNonce", "unknown nonce"] };
    if (state.badNonce) { state.badNonce = false; return { error: ["badNonce", "injected"] }; }
    if (Boolean(header.jwk) === Boolean(header.kid)) return { error: ["malformed", "exactly one of jwk and kid"] };
    let key; let account = null;
    if (header.jwk) {
      if (request.url !== "/new-account") return { error: ["malformed", "jwk is only for newAccount"] };
      key = createPublicKey({ key: header.jwk, format: "jwk" });
    } else {
      account = state.accounts.get(header.kid);
      if (!account) return { error: ["accountDoesNotExist", "no such account"] };
      key = account.key;
    }
    const ok = verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url"));
    if (!ok) return { error: ["unauthorized", "bad signature"] };
    state.log.push({ url: request.url, header, payload });
    return { header, payload, key, account };
  }

  const orderView = (order) => {
    if (order.status === "pending") {
      const statuses = order.authorizations.map((id) => state.authorizations.get(id).status);
      if (statuses.includes("invalid")) order.status = "invalid";
      else if (statuses.every((value) => value === "valid")) order.status = "ready";
    } else if (order.status === "processing" && order.pollsUntilValid-- <= 0) {
      order.status = "valid";
    }
    return {
      status: order.status, identifiers: order.identifiers, finalize: `${base}/finalize/${order.id}`,
      authorizations: order.authorizations.map((id) => `${base}/authz/${id}`),
      ...(order.certificate ? { certificate: `${base}/cert/${order.certificate}` } : {}),
      ...(order.error ? { error: order.error } : {}),
    };
  };

  async function handle(request, response, raw) {
    const [, kind, id] = request.url.split("/");
    if (request.method === "GET" && request.url === "/directory") {
      send(response, 200, { newNonce: `${base}/new-nonce`, newAccount: `${base}/new-account`, newOrder: `${base}/new-order`, meta: { termsOfService: `${base}/terms` } });
      return;
    }
    if ((request.method === "HEAD" || request.method === "GET") && request.url === "/new-nonce") { send(response, 200); return; }
    if (request.method !== "POST") { problem(response, 405, "malformed", "POST only"); return; }
    const auth = authenticate(request, raw);
    if (auth.error) { problem(response, 400, ...auth.error); return; }
    const injected = state.failures.findIndex((item) => item.endpoint === kind);
    if (injected >= 0) {
      const [failure] = state.failures.splice(injected, 1);
      problem(response, failure.status, failure.type, failure.detail ?? "injected", failure.retryAfter !== undefined ? { "retry-after": String(failure.retryAfter) } : {});
      return;
    }
    switch (kind) {
      case "new-account": {
        const thumbprint = jwkThumbprint(auth.key);
        const existing = [...state.accounts.entries()].find(([, account]) => account.thumbprint === thumbprint);
        if (existing) { send(response, 200, { status: "valid" }, { location: existing[0] }); return; }
        if (auth.payload?.termsOfServiceAgreed !== true) { problem(response, 403, "userActionRequired", "agree to the terms"); return; }
        const url = `${base}/account/${token().slice(0, 12)}`;
        state.accounts.set(url, { key: auth.key, thumbprint });
        send(response, 201, { status: "valid" }, { location: url });
        return;
      }
      case "new-order": {
        const orderId = token().slice(0, 12);
        const identifiers = auth.payload?.identifiers ?? [];
        const authorizations = identifiers.map((identifier) => {
          const authorizationId = token().slice(0, 12);
          const challengeId = token().slice(0, 12);
          state.challenges.set(challengeId, { type: "tls-alpn-01", status: "pending", token: token(), authorization: authorizationId, account: auth.header.kid });
          state.authorizations.set(authorizationId, { status: "pending", identifier, challenge: challengeId, polls: 0, hold: state.holdPolls });
          return authorizationId;
        });
        const order = { id: orderId, status: "pending", identifiers, authorizations, pollsUntilValid: 0 };
        state.orders.set(orderId, order);
        send(response, 201, orderView(order), { location: `${base}/order/${orderId}` });
        return;
      }
      case "authz": {
        const authorization = state.authorizations.get(id);
        const challenge = state.challenges.get(authorization.challenge);
        authorization.polls += 1;
        // Report "pending" for `holdPolls` polls after validation, as a CA
        // that validates asynchronously would, so the client must honour
        // Retry-After.
        let status = authorization.status;
        if (status !== "pending" && authorization.hold > 0) { authorization.hold -= 1; status = "pending"; }
        const body = {
          status, identifier: authorization.identifier,
          challenges: [{ type: "tls-alpn-01", url: `${base}/chall/${authorization.challenge}`, token: challenge.token, status: challenge.status, ...(challenge.error ? { error: challenge.error } : {}) }],
        };
        send(response, 200, body, status === "pending" ? { "retry-after": "3" } : {});
        return;
      }
      case "chall": {
        const challenge = state.challenges.get(id);
        const authorization = state.authorizations.get(challenge.authorization);
        if (challenge.status === "pending") {
          challenge.status = "processing";
          const keyAuthorization = `${challenge.token}.${state.accounts.get(challenge.account).thumbprint}`;
          // Validate before answering, so the client's first poll sees the
          // result; real CAs validate asynchronously, which the Retry-After
          // poll covers when `pending` is seen.
          const result = await validateTlsAlpn({ host: state.validationHost, port: state.validationPort, name: authorization.identifier.value, keyAuthorization });
          state.validations = (state.validations ?? 0) + 1;
          challenge.status = result.ok ? "valid" : "invalid";
          authorization.status = challenge.status;
          if (!result.ok) challenge.error = { type: `urn:ietf:params:acme:error:${result.type}`, detail: result.detail };
        }
        send(response, 200, { type: "tls-alpn-01", status: challenge.status, token: challenge.token, url: `${base}/chall/${id}` });
        return;
      }
      case "order": {
        send(response, 200, orderView(state.orders.get(id)), { "retry-after": "1" });
        return;
      }
      case "finalize": {
        const order = state.orders.get(id);
        orderView(order);
        if (order.status !== "ready") { problem(response, 403, "orderNotReady", `order is ${order.status}`); return; }
        let csr;
        try { csr = parseCsr(Buffer.from(auth.payload.csr, "base64url")); } catch { problem(response, 400, "badCSR", "unparseable CSR"); return; }
        const wanted = order.identifiers.map((item) => item.value).sort();
        if (!verify("sha256", csr.info, csr.publicKey, csr.signature)) { problem(response, 400, "badCSR", "CSR signature does not verify"); return; }
        if (JSON.stringify([...csr.names].sort()) !== JSON.stringify(wanted)) { problem(response, 400, "badCSR", "CSR names do not match the order"); return; }
        const issuedAt = state.now();
        const leafDer = buildCertificate({
          subjectPublicKeyInfo: csr.publicKey.export({ type: "spki", format: "der" }), subject: wanted[0], issuer: "Kin Test ACME CA",
          notBefore: issuedAt, notAfter: issuedAt + state.lifetimeMs, extensions: [subjectAltNameExtension(wanted)], signingKey: ca,
        });
        const certificateId = token().slice(0, 12);
        state.certificates.set(certificateId, `${toPem(leafDer, "CERTIFICATE")}${toPem(caDer, "CERTIFICATE")}`);
        state.issued.push(leafDer);
        order.certificate = certificateId;
        order.status = "processing";
        order.pollsUntilValid = 2; // this answer and the first poll say "processing"
        send(response, 200, orderView(order), { "retry-after": "1" });
        return;
      }
      case "cert": {
        send(response, 200, state.certificates.get(id), { "content-type": "application/pem-certificate-chain" });
        return;
      }
      default:
        problem(response, 404, "malformed", "no such resource");
    }
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      handle(request, response, Buffer.concat(chunks).toString("utf8")).catch((error) => problem(response, 500, "serverInternal", error.message));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    directoryUrl: `${base}/directory`,
    caPublicKey: createPublicKey(ca),
    caPem: toPem(caDer, "CERTIFICATE"),
    failNext(endpoint, type, { status = 400, retryAfter, detail } = {}) { state.failures.push({ endpoint, type, status, retryAfter, detail }); },
    badNonceOnce() { state.badNonce = true; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
