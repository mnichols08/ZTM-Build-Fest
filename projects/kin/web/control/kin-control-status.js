// The status page (ADR 0025 §11, #720): is the home server reachable, is
// its certificate good, and how big is it. Everything here is a count, a
// date, a state or an error code put in plain words (explain.js); the
// server sends no household content (server/home/control-panel.mjs).
//
// Each section is a <section data-section="…">. "backups" (#721) and
// "updates" (#722) show "not built yet" until those tasks provide them;
// they render whatever the server's section holds through
// `KinControlStatus.sections`, so adding one needs no change here.
import { el, details } from "./dom.js";
import { explain, explainCertificateState, explainTransparency, explainTunnelState } from "./explain.js";
import { countOf, formatBytes, formatDate, formatDateTime } from "./format.js";

const tone = (good) => (good ? "good" : "attention");

function headline(status) {
  const relay = status.relay;
  const certificate = status.certificate;
  if (!relay || !certificate) return { tone: "attention", text: "This home server isn't set up yet." };
  if (certificate.transparency?.state === "alert") return { tone: "alert", text: "Check the certificate log: a certificate this server didn't make was found." };
  if (!relay.connected || !relay.routed) return { tone: "attention", text: "Phones can't reach this home server right now." };
  if (!certificate.notAfter || certificate.state === "expired") return { tone: "attention", text: "This home server has no valid certificate." };
  if (certificate.expiringSoon) return { tone: "attention", text: "The certificate runs out soon." };
  return { tone: "good", text: "Everything is working." };
}

function relaySection(status) {
  const relay = status.relay;
  const section = el("section", { className: "control-card", "data-section": "relay", "aria-labelledby": "status-relay" }, el("h2", { id: "status-relay", text: "Connection" }));
  if (!relay) {
    section.append(el("p", { text: "Not connected: setup hasn't chosen a name yet." }));
    return section;
  }
  const good = relay.connected && relay.routed;
  section.dataset.tone = tone(good);
  section.append(el("p", { className: "control-state", text: explainTunnelState(relay.state) }));
  const pairs = [
    ["Relay", relay.relay],
    [relay.connected ? "Connected since" : "Last change", formatDateTime(relay.since)],
  ];
  if (!relay.connected && relay.nextAttemptAt) pairs.push(["Next try", formatDateTime(relay.nextAttemptAt)]);
  section.append(details(pairs));
  for (const problem of [relay.nameError, relay.lastError].filter(Boolean))
    section.append(el("p", { className: "control-problem", "data-code": problem.code, text: explain(problem.code) }));
  return section;
}

function nameSection(status) {
  const section = el("section", { className: "control-card", "data-section": "name", "aria-labelledby": "status-name" }, el("h2", { id: "status-name", text: "Name" }));
  if (!status.name) {
    section.append(el("p", { text: "No name chosen yet." }));
    return section;
  }
  section.append(details([
    ["Address", el("a", { href: status.origin, text: status.origin })],
    ["Kind", status.freeName ? "A free name from the relay" : "Your own domain"],
    ["Routed by the relay", status.relay?.routed ? "Yes" : "Not right now"],
  ]));
  return section;
}

function certificateSection(status) {
  const certificate = status.certificate;
  const section = el("section", { className: "control-card", "data-section": "certificate", "aria-labelledby": "status-certificate" }, el("h2", { id: "status-certificate", text: "Certificate" }));
  if (!certificate) {
    section.append(el("p", { text: "No certificate yet." }));
    return section;
  }
  section.dataset.tone = tone(Boolean(certificate.notAfter) && !certificate.expiringSoon && certificate.state !== "expired" && certificate.transparency?.state !== "alert");
  section.append(el("p", { className: "control-state", text: explainCertificateState(certificate.state) }));
  section.append(details([
    ["Valid until", certificate.notAfter ? `${formatDate(certificate.notAfter)}${Number.isInteger(certificate.daysLeft) ? ` (${countOf(certificate.daysLeft, "day", "days")} left)` : ""}` : "No certificate yet"],
    ["Next renewal", certificate.renewAt ? formatDate(certificate.renewAt) : certificate.nextAttemptAt ? formatDateTime(certificate.nextAttemptAt) : null],
    ["Issued by", certificate.issuer],
    ["Certificate log check", explainTransparency(certificate.transparency?.state)],
  ]));
  if (certificate.lastError) section.append(el("p", { className: "control-problem", "data-code": certificate.lastError.code, text: explain(certificate.lastError.code) }));
  if (certificate.transparency?.state === "alert") section.dataset.tone = "alert";
  return section;
}

/** A section a later task provides (#721, #722): until then it says so. */
function seamSection(id, title, value, describe, lead = []) {
  const section = el("section", { className: "control-card", "data-section": id, "aria-labelledby": `status-${id}` }, el("h2", { id: `status-${id}`, text: title }), ...lead);
  if (!value || value.state === "not-built") section.append(el("p", { className: "control-muted", text: describe.notBuilt }));
  else if (value.state === "error") section.append(el("p", { className: "control-problem", text: describe.error }));
  else section.append(...describe.render(value));
  return section;
}

/** How each later section renders once it is provided. Replaceable by
 * #721 and #722 without touching the rest of the page. */
export const SECTIONS = {
  backups: {
    title: "Backups",
    notBuilt: "Scheduled backups aren't part of this version yet. Until then, back up with “kin admin backup”, as the home server guide shows.",
    error: "Kin couldn't read the backup status.",
    render: (value) => [details([["Last backup", value.lastBackupAt ? formatDateTime(value.lastBackupAt) : "None yet"]])],
  },
  updates: {
    title: "Version and updates",
    notBuilt: "Kin doesn't check for updates by itself yet.",
    error: "Kin couldn't read the update status.",
    render: (value) => [details([["Available", value.available ?? "Up to date"]])],
  },
};

function storageSection(status) {
  const { databaseBytes, freeBytes } = status.storage ?? {};
  return el("section", { className: "control-card", "data-section": "storage", "aria-labelledby": "status-storage" },
    el("h2", { id: "status-storage", text: "Storage" }),
    details([
      ["Kin's database", formatBytes(databaseBytes)],
      ["Free on this disk", formatBytes(freeBytes)],
    ]));
}

function countsSection(status) {
  const { households = 0, devices = 0 } = status.counts ?? {};
  const limits = status.limits ?? {};
  return el("section", { className: "control-card", "data-section": "counts", "aria-labelledby": "status-counts" },
    el("h2", { id: "status-counts", text: "Households and devices" }),
    el("p", { className: "control-muted", text: "Counts only. The control panel never shows what households keep in Kin." }),
    details([
      ["Households", countOf(households, "household", "households")],
      ["Trusted devices", countOf(devices, "device", "devices")],
      ["New households", limits.allowNew === false ? "Closed" : Number.isInteger(limits.maxHouseholds) ? `Up to ${countOf(limits.maxHouseholds, "household", "households")} on this server` : "No limit"],
    ]));
}

function versionSection(status) {
  return seamSection("updates", SECTIONS.updates.title, status.updates, SECTIONS.updates, [details([["Kin version", status.version]])]);
}

export class KinControlStatus extends HTMLElement {
  #status = null;

  get status() { return this.#status; }
  set status(value) {
    const same = this.#status && value && JSON.stringify({ ...this.#status, checkedAt: null }) === JSON.stringify({ ...value, checkedAt: null });
    this.#status = value;
    // Polling: only the "checked" time changed, so focus stays put.
    if (same) { const checked = this.querySelector(".control-checked"); if (checked) { checked.textContent = `Checked ${formatDateTime(value.checkedAt)}.`; return; } }
    this.render();
  }

  render() {
    const status = this.#status;
    if (!status) { this.replaceChildren(); return; }
    const summary = headline(status);
    this.replaceChildren(
      el("p", { className: "control-headline", "data-tone": summary.tone, text: summary.text }),
      el("div", { className: "control-grid" },
        relaySection(status),
        nameSection(status),
        certificateSection(status),
        seamSection("backups", SECTIONS.backups.title, status.backups, SECTIONS.backups),
        storageSection(status),
        countsSection(status),
        versionSection(status)),
      el("p", { className: "control-muted control-checked", text: `Checked ${formatDateTime(status.checkedAt)}.` }),
    );
  }
}

if (!customElements.get("kin-control-status")) customElements.define("kin-control-status", KinControlStatus);
