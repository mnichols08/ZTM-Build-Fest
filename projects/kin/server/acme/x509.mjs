// X.509 building blocks on the DER writer (#725, #726): names, extensions,
// ECDSA P-256 / SHA-256 signing, and a certificate builder used for the
// TLS-ALPN-01 challenge certificate (and by the tests' ACME server to issue).
//
// Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature BIT STRING }
// TBSCertificate ::= SEQUENCE {
//   [0] EXPLICIT version (2 = v3), serialNumber INTEGER, signature AlgorithmIdentifier,
//   issuer Name, validity SEQUENCE { notBefore, notAfter }, subject Name,
//   subjectPublicKeyInfo, [3] EXPLICIT extensions SEQUENCE OF Extension }
// (RFC 5280 §4.1)
import { createPublicKey, randomBytes, sign } from "node:crypto";
import {
  bitString, boolean, ecdsaRawToDer, explicit, ia5String, implicitPrimitive, integer,
  objectIdentifier, octetString, sequence, set, time, utf8String,
} from "./der.mjs";

export const OID = Object.freeze({
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  extensionRequest: "1.2.840.113549.1.9.14",
  acmeIdentifier: "1.3.6.1.5.5.7.1.31",
});

/** A DNS name Kin will put in a certificate: lowercase LDH labels of 1–63
 * characters, 1–253 in all, no trailing dot, at least two labels, no
 * wildcard. Returns the lowercased name or throws. */
export function assertDnsName(value) {
  const name = String(value ?? "").toLowerCase();
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  if (name.length < 1 || name.length > 253 || !name.includes(".") || !name.split(".").every((part) => label.test(part))) {
    throw new TypeError("not a valid DNS name for a certificate");
  }
  return name;
}

/** AlgorithmIdentifier for ecdsa-with-SHA256: the OID alone, parameters
 * absent (RFC 5758 §3.2). */
export const ecdsaSha256Algorithm = () => sequence(objectIdentifier(OID.ecdsaWithSha256));

/** A Name with at most one RDN, CN=<commonName> as UTF8String; an empty
 * SEQUENCE when `commonName` is empty. A CN is limited to 64 characters
 * (RFC 5280 ub-common-name), so longer names leave the subject empty and rely
 * on subjectAltName, as RFC 5280 §4.2.1.6 allows. */
export function distinguishedName(commonName = "") {
  if (!commonName || commonName.length > 64) return sequence();
  return sequence(set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))));
}

/** Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue
 * OCTET STRING }; DER omits `critical` when false. */
export function extension(oid, valueDer, critical = false) {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(valueDer))
    : sequence(objectIdentifier(oid), octetString(valueDer));
}

/** subjectAltName with one dNSName ([2] IMPLICIT IA5String) per name. */
export function subjectAltNameExtension(names) {
  return extension(OID.subjectAltName, sequence(...names.map((name) => implicitPrimitive(2, Buffer.from(assertDnsName(name), "ascii")))));
}

/** SHA-256 ECDSA over `data` with a P-256 private key, DER-encoded. Node
 * signs in P1363 form here and the DER is written by `ecdsaRawToDer`, so the
 * encoding on the wire is Kin's own. */
export function signEcdsaSha256(privateKey, data) {
  return ecdsaRawToDer(sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" }));
}

/** The DER SubjectPublicKeyInfo of a key object (public or private). */
export function spkiDer(key) {
  return (key?.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
}

/** A positive serial number of 16 random bytes (RFC 5280 allows up to 20). */
export function randomSerial() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

/**
 * A DER X.509 v3 certificate.
 *
 * @param {object} options
 * @param {Buffer} options.subjectPublicKeyInfo DER SPKI of the certified key
 * @param {string} [options.subject] subject common name ("" for empty)
 * @param {string} [options.issuer] issuer common name (defaults to subject)
 * @param {Buffer} [options.serial] serial number bytes
 * @param {Date|number} options.notBefore
 * @param {Date|number} options.notAfter
 * @param {Buffer[]} [options.extensions] complete Extension TLVs
 * @param {import("node:crypto").KeyObject} options.signingKey P-256 private key
 */
export function buildCertificate({ subjectPublicKeyInfo, subject = "", issuer = subject, serial = randomSerial(), notBefore, notAfter, extensions = [], signingKey }) {
  const algorithm = ecdsaSha256Algorithm();
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    distinguishedName(issuer),
    sequence(time(notBefore), time(notAfter)),
    distinguishedName(subject),
    Buffer.from(subjectPublicKeyInfo),
    ...(extensions.length ? [explicit(3, sequence(...extensions))] : []),
  );
  return sequence(tbs, algorithm, bitString(signEcdsaSha256(signingKey, tbs)));
}

/** DER to PEM with 64-character lines. */
export function toPem(der, label) {
  const body = Buffer.from(der).toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

/** Every PEM block with `label` in `text`, as DER buffers. */
export function fromPemAll(text, label = "CERTIFICATE") {
  const pattern = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+?)-----END ${label}-----`, "g");
  return [...String(text).matchAll(pattern)].map((match) => Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
}
