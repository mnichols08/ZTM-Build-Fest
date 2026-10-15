// Devices and members: the device and household views, temporary
// invitations, device replacement, recovery, removal and admin changes.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { authenticationOptions, credentialJson } from "./auth.js";

const MAX_ACTIVE_ADULTS = 4;
const MAX_ACTIVE_LIMITED = 8;
const localDateTimeValue = (timestamp) => {
  const date = new Date(timestamp);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

export class HouseholdMembership {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async showDevices() {
    await this.host.run(async () => {
      const { devices, canManageMembers } = await this.host.api("/api/devices");
      let directoryDevices = [];
      if (!this.host.syncKeyError) {
        await this.ctx.api.openSyncKeyStore();
        directoryDevices = (await this.host.api("/api/sync/devices")).devices;
      }
      this.host.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "Trusted devices";
      this.host.append(heading);
      const list = document.createElement("ul");
      list.className = "device-list";
      for (const device of devices) {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${device.label} — ${device.revokedAt ? "Revoked" : "Trusted"}`;
        item.append(text);
        const syncDevice = directoryDevices.find(
          (entry) => entry.deviceId === device.id,
        );
        if (syncDevice?.fingerprint) {
          if (
            device.id === this.host.identity.deviceId &&
            syncDevice.fingerprint !== this.host.localFingerprint
          ) {
            this.host.message(
              "This browser's saved device key does not match its trusted record. Device sync is paused.",
              true,
            );
            list.append(item);
            continue;
          }
          const displayedFingerprint =
            device.id === this.host.identity.deviceId
              ? this.host.localFingerprint
              : syncDevice.fingerprint;
          const keyCode = document.createElement("code");
          keyCode.className = "device-key-fingerprint";
          keyCode.textContent = displayedFingerprint.match(/.{1,4}/g).join(" ");
          keyCode.setAttribute(
            "aria-label",
            `Device sync code ${keyCode.textContent}`,
          );
          item.append(keyCode);
          const pinned =
            device.id === this.host.identity.deviceId ||
            (await this.host.syncKeyStore.getPinnedDevice(
              this.host.identity.householdId,
              device.id,
            ));
          if (!pinned && syncDevice.publicKeys) {
            const verify = this.host.makeButton("Verify device", () => {
              verify.hidden = true;
              const prompt = document.createElement("p");
              prompt.textContent =
                "Compare this code with the code shown on that device.";
              const label = document.createElement("label");
              const confirmation = document.createElement("input");
              confirmation.type = "checkbox";
              label.append(
                confirmation,
                document.createTextNode(" The codes match."),
              );
              const approve = this.host.makeButton("Trust this device", async () => {
                let trusted = false;
                await this.host.run(async () => {
                  if (!confirmation.checked)
                    throw new Error(
                      "Compare the codes on both devices before trusting this device.",
                    );
                  const current = (
                    await this.host.api("/api/sync/devices")
                  ).devices.find((entry) => entry.deviceId === device.id);
                  if (
                    !current ||
                    current.fingerprint !== displayedFingerprint
                  )
                    throw new Error(
                      "This device code changed. Compare the codes again before trusting this device.",
                    );
                  await this.host.syncKeyStore.pinTrustedDevice({
                    householdId: this.host.identity.householdId,
                    memberId: current.memberId,
                    deviceId: current.deviceId,
                    publicKeys: current.publicKeys,
                    fingerprint: current.fingerprint,
                  });
                  this.ctx.api.requestSync();
                  trusted = true;
                });
                if (trusted) await this.host.showDevices();
              });
              this.host.setControlDisabled(approve, true);
              confirmation.addEventListener("change", () => {
                this.host.setControlDisabled(approve, !confirmation.checked);
              });
              item.append(prompt, label, approve);
            });
            item.append(verify);
          }
        }
        if (!device.revokedAt && device.id !== this.host.identity.deviceId) {
          if (device.memberId === this.host.identity.memberId)
            item.append(
              this.host.makeButton(
                "Replace this device",
                () => this.createReplacement(device.id),
                "secondary",
              ),
            );
          // Fail closed: show another member's revoke control only when the
          // server explicitly grants management authority. It enforces this too.
          if (device.memberId === this.host.identity.memberId || canManageMembers === true) item.append(
            this.host.makeButton(
              `Revoke ${device.label}`,
              async () => {
                if (!confirm(`Revoke ${device.label}? That device will lose future household access. Copies already saved there cannot be erased.`)) return;
                let revoked = false;
                await this.host.run(async () => {
                  const started = await this.host.api(`/api/devices/${device.id}/revocation/options`, {
                    method: "POST", body: "{}",
                  });
                  this.host.message(`Confirm revoking ${device.label} with your passkey.`);
                  const credential = await navigator.credentials.get({
                    publicKey: authenticationOptions(started.publicKey),
                    signal: this.host.connectionAbort.signal,
                  });
                  await this.host.api("/api/devices/revocation/finish", {
                    method: "POST",
                    body: JSON.stringify({ flow: started.flow, credential: credentialJson(credential) }),
                  });
                  revoked = true;
                });
                // showDevices() runs its own busy guard, so refresh only after
                // the revocation operation has released it.
                if (revoked) await this.host.showDevices();
              },
              "danger",
            ),
          );
        }
        list.append(item);
      }
      this.host.append(
        list,
        this.host.makeButton("Back", () => this.host.render(), "secondary"),
      );
    });
  }

  async showHousehold() {
    await this.host.run(async () => {
      const household = await this.host.api("/api/household");
      this.host.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "Household access";
      this.host.append(heading);
      this.host.text(
        household.adminRecorded
          ? "Household admins manage who has access. Removing a member blocks future access, but cannot erase information already copied."
          : "Only adults can manage household access. Removing a member blocks future access, but cannot erase information already copied.",
      );
      const activeMembers = household.members.filter((value) => value.active);
      const me = household.members.find((value) => value.current);
      const canManage = household.canManageMembers === true;
      for (const kind of ["adult", "limited", "temporary"]) {
        const sectionMembers = household.members.filter((member) =>
          kind === "temporary" ? member.kind === kind : member.kind === kind && member.active,
        );
        if (!sectionMembers.length && kind === "temporary") continue;
        const section = document.createElement("section");
        const title = document.createElement("h3");
        title.textContent = kind === "adult" ? "Adults" : kind === "limited" ? "Children & Limited Members" : "Babysitters, Caregivers & Guests";
        section.append(title);
        const list = document.createElement("ul");
        for (const [index, member] of sectionMembers.entries()) {
        const item = document.createElement("li");
        const memberLabel = member.current ? "You" : `${kind === "adult" ? "Adult" : kind === "limited" ? "Limited member" : "Temporary member"} ${index + 1}`;
        const expiryText = kind === "temporary" && member.expiresAt ? ` — ends ${new Date(member.expiresAt).toLocaleString()}` : "";
        item.textContent = `${memberLabel}${member.admin ? " — Household admin" : ""}${expiryText}${member.active ? "" : " — access ended"}`;
        if (member.current && kind === "temporary") item.textContent = `Temporary household access — ends ${new Date(member.expiresAt).toLocaleString()}`;
        if (me?.admin && kind === "adult" && member.active && (!member.current || member.admin))
          item.append(
            this.host.makeButton(
              member.current
                ? "Stop being a household admin"
                : member.admin
                  ? `Remove household admin from ${memberLabel}`
                  : `Make ${memberLabel} a household admin`,
              () => this.host.setHouseholdAdmin(member.id, memberLabel, !member.admin),
              "secondary",
            ),
          );
        if (me?.kind === "adult" && !member.current && member.active) {
          // Recovering an admin issues admin authority, so the server
          // requires an admin approver for it.
          if (kind !== "temporary" && (!member.admin || me.admin)) item.append(
            this.host.makeButton(
              `Authorize recovery for ${memberLabel}`,
              () => this.authorizeRecovery(member.id),
              "secondary",
            ),
          );
          if (canManage) item.append(
            this.host.makeButton(
              kind === "temporary" ? `Revoke ${memberLabel}'s temporary access` : `Remove ${memberLabel} from household`,
              () => this.removeMember(member.id, memberLabel, kind),
              "danger",
            ),
          );
        }
        list.append(item);
        }
        section.append(list);
        this.host.append(section);
      }
      this.host.append(
        ...(canManage && activeMembers.length < 12
          ? [
              ...(activeMembers.filter((member) => member.kind === "adult").length < MAX_ACTIVE_ADULTS
                ? [this.host.makeButton("Add Adult", () => this.host.createPairing("adult"))]
                : []),
              ...(activeMembers.filter((member) => member.kind === "limited").length < MAX_ACTIVE_LIMITED
                ? [this.host.makeButton("Add Child or Limited Member", () => this.host.createPairing("limited"))]
                : []),
              ...(activeMembers.length < 12
                ? [this.temporaryInvitationForm()]
                : []),
            ]
          : []),
        ...(canManage ? [this.host.makeButton(
          "Delete household",
          () => this.ctx.lifecycle.deleteHousehold(),
          "danger",
        )] : []),
        this.host.makeButton("Leave household", () => this.host.leave(), "danger"),
        this.host.makeButton("Back", () => this.host.render(), "secondary"),
      );
    });
  }

  temporaryInvitationForm() {
    const form = document.createElement("form");
    form.className = "temporary-invitation-form";
    const label = document.createElement("label");
    label.textContent = "Babysitter, caregiver, or guest access ends";
    const expiry = document.createElement("input");
    expiry.type = "datetime-local";
    expiry.required = true;
    expiry.min = localDateTimeValue(Date.now() + 60_000);
    expiry.value = localDateTimeValue(Date.now() + 7 * 24 * 60 * 60_000);
    const help = document.createElement("small");
    help.textContent = "Uses your device's local time. Kin checks the expiry on every server request.";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add Babysitter or Guest";
    label.append(expiry);
    form.append(label, help, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const timestamp = Date.parse(expiry.value);
      if (!Number.isSafeInteger(timestamp) || timestamp <= Date.now()) {
        this.host.message("Choose a future expiry date and time.", true);
        return;
      }
      this.host.createPairing("temporary", timestamp);
    });
    return form;
  }

  async createReplacement(deviceId) {
    if (
      !confirm(
        "Replace this device? The selected device will no longer be trusted as soon as you approve the fresh device. Previously copied information cannot be erased.",
      )
    )
      return;
    await this.host.run(async () => {
      this.host.pairing = await this.host.api("/api/devices/replacements", {
        method: "POST",
        body: JSON.stringify({ deviceId }),
      });
      this.host.render();
    });
  }

  async authorizeRecovery(memberId) {
    if (
      !confirm(
        "Authorize recovery for this adult? They must create and activate a fresh passkey. Approval will revoke their old credentials, sessions, and devices.",
      )
    )
      return;
    await this.host.run(async () => {
      this.host.pairing = await this.host.api("/api/household/recovery", {
        method: "POST",
        body: JSON.stringify({ memberId }),
      });
      this.host.render();
    });
  }

  async removeMember(memberId, memberLabel = "member", kind = "adult") {
    if (
      !confirm(
        kind === "temporary"
          ? `Revoke ${memberLabel}'s temporary access? Kin will block future sync and rotate household access. Copies already decrypted on a device cannot be erased.`
          : `Remove ${memberLabel} and revoke their trusted devices? This blocks future access but cannot erase copies already decrypted on a device.`,
      )
    )
      return;
    await this.host.run(() => this.host.authenticateRemoval(memberId));
    await this.host.showHousehold();
  }

  async setHouseholdAdmin(memberId, memberLabel, admin) {
    if (
      !confirm(
        admin
          ? `Make ${memberLabel} a household admin? Admins can add and remove members, change shared household settings, and make other Adults admins.`
          : `Remove household admin from ${memberLabel}? They stay an Adult member, and invitations they started will be cancelled.`,
      )
    )
      return;
    await this.host.run(async () => {
      const started = await this.host.api("/api/household/admins/options", {
        method: "POST",
        body: JSON.stringify({ memberId, admin }),
      });
      this.host.message("Confirm the household admin change with your passkey.");
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.host.connectionAbort.signal,
      });
      await this.host.api("/api/household/admins/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
        }),
      });
    });
    await this.host.showHousehold();
  }

  async authenticateRemoval(memberId) {
    const started = await this.host.api("/api/household/membership/remove/options", {
      method: "POST",
      body: JSON.stringify({ memberId }),
    });
    const credential = await navigator.credentials.get({
      publicKey: authenticationOptions(started.publicKey),
      signal: this.host.connectionAbort.signal,
    });
    await this.host.api("/api/household/membership/remove/finish", {
      method: "POST",
      body: JSON.stringify({
        flow: started.flow,
        credential: credentialJson(credential),
      }),
    });
  }
}
