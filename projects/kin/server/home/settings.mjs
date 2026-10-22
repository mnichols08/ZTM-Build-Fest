// Home settings (ADR 0025 §9–§10, #733): which connection relay the home
// server dials, the relay's zone, the server's one name, and the ACME
// directory and terms agreement for its certificate. They live in the data
// directory, in `home/settings.json` (mode 0600, written by the control panel,
// #718), and each can be overridden by an environment variable for a
// technical household or a container:
//
//   field            variable                     default
//   relay            KIN_HOME_RELAY               relay.kin.journeytocode.io (port 443; "host:port" for another)
//   zone             KIN_HOME_ZONE                home.kin.journeytocode.io
//   name             KIN_HOME_NAME                none: without it the tunnel doesn't start
//   acmeDirectory    KIN_HOME_ACME_DIRECTORY      Let's Encrypt production
//   acmeTermsAgreed  KIN_HOME_ACME_TERMS_AGREED   false ("true" agrees)
//
// The file's format is `{ "format": 1, ...fields }`. A name directly under
// the zone (one more label) is a free name, claimed from the relay; any
// other name is the household's own domain (ADR 0025 §3).
//
// This module imports nothing from the relay, so hosted Kin can load
// server.mjs without the tunnel's code.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_RELAY = "relay.kin.journeytocode.io";
export const DEFAULT_ZONE = "home.kin.journeytocode.io";
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const SETTINGS_FORMAT = 1;
const FIELDS = Object.freeze({
  relay: "KIN_HOME_RELAY",
  zone: "KIN_HOME_ZONE",
  name: "KIN_HOME_NAME",
  acmeDirectory: "KIN_HOME_ACME_DIRECTORY",
  acmeTermsAgreed: "KIN_HOME_ACME_TERMS_AGREED",
});

export class HomeSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "HomeSettingsError";
    this.code = "home_settings_invalid";
  }
}

const fail = (message) => { throw new HomeSettingsError(message); };
const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/** A lowercase LDH host name of 1 to 253 bytes with no trailing dot (the
 * same rule as KTUN's names, relay/ktun.mjs). */
export function isHostName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export const homeDirectory = (dataDirectory) => join(dataDirectory, "home");
export const homeSettingsPath = (dataDirectory) => join(homeDirectory(dataDirectory), "settings.json");

/** True when `name` is a free name: exactly one label under `zone`. */
export function isFreeName(name, zone) {
  if (!name.endsWith(`.${zone}`)) return false;
  return !name.slice(0, -zone.length - 1).includes(".");
}

function parseRelay(value) {
  const text = String(value).trim().toLowerCase();
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match || !isHostName(match[1])) fail(`The relay "${value}" must be a host name, optionally with ":port".`);
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`The relay port in "${value}" must be 1 to 65535.`);
  return { host: match[1], port };
}

function parseName(value, what) {
  const name = String(value).trim().toLowerCase();
  if (!isHostName(name)) fail(`The ${what} "${value}" must be a lowercase host name such as fern.home.kin.journeytocode.io.`);
  return name;
}

function parseDirectory(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { fail(`The ACME directory "${value}" is not a URL.`); }
  if (url.protocol !== "https:") fail("The ACME directory must be an https:// URL.");
  return url.href;
}

function parseBoolean(value, what) {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return fail(`${what} must be true or false.`);
}

/**
 * The effective home settings from `file` (the parsed settings.json, or
 * null) and `env`. `configured` is true when a name is set: only then does
 * home mode start the tunnel and the certificate manager.
 */
export function resolveHomeSettings(file, env = process.env) {
  if (file !== null && (typeof file !== "object" || Array.isArray(file))) fail("home/settings.json must hold a JSON object.");
  if (file && file.format !== SETTINGS_FORMAT) fail(`home/settings.json has format ${JSON.stringify(file.format)}; this Kin reads format ${SETTINGS_FORMAT}.`);
  const raw = {};
  for (const [field, variable] of Object.entries(FIELDS)) raw[field] = isSet(env[variable]) ? env[variable] : file?.[field];
  const relay = parseRelay(isSet(raw.relay) ? raw.relay : DEFAULT_RELAY);
  const zone = parseName(isSet(raw.zone) ? raw.zone : DEFAULT_ZONE, "zone");
  const name = isSet(raw.name) ? parseName(raw.name, "name") : null;
  if (name && (name === relay.host || name === zone)) fail(`The name ${name} is the relay's own; choose a name under ${zone} or your own domain.`);
  return Object.freeze({
    relay: Object.freeze(relay),
    zone,
    name,
    freeName: name ? isFreeName(name, zone) : null,
    acmeDirectory: isSet(raw.acmeDirectory) ? parseDirectory(raw.acmeDirectory) : LETS_ENCRYPT_DIRECTORY,
    acmeTermsAgreed: raw.acmeTermsAgreed === undefined || raw.acmeTermsAgreed === null || raw.acmeTermsAgreed === "" ? false : parseBoolean(raw.acmeTermsAgreed, "acmeTermsAgreed"),
    configured: name !== null,
  });
}

/** Reads `<dataDirectory>/home/settings.json` (absent is fine) and applies
 * the environment. Throws HomeSettingsError for a bad file or value. */
export async function loadHomeSettings(dataDirectory, env = process.env) {
  let file = null;
  try {
    file = JSON.parse(await readFile(homeSettingsPath(dataDirectory), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) fail("home/settings.json is not valid JSON.");
      throw error;
    }
  }
  return resolveHomeSettings(file, env);
}

/** The origin a configured home server serves: https://<name>. An explicit
 * KIN_ORIGIN must be that same origin (one origin per home server, §3). */
export function homeOrigin(settings, explicitOrigin) {
  const origin = `https://${settings.name}`;
  if (isSet(explicitOrigin) && String(explicitOrigin).replace(/\/$/, "") !== origin)
    fail(`KIN_ORIGIN is ${explicitOrigin}, but this home server's name is ${settings.name}. Remove KIN_ORIGIN or set it to ${origin}.`);
  return origin;
}
