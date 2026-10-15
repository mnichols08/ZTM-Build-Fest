// Encrypted household archives: downloading one and restoring from one.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { getActiveVault } from "../../security/local-vault.js";
import { discardValidatedHouseholdArchive, exportHouseholdArchive, restoreValidatedHouseholdArchive, validateHouseholdArchive } from "../../security/archive.js";
import { portableMembershipFromDirectory } from "../../sync/sync-coordinator.js";

export class SecurityArchive {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async downloadArchive() {
    const operation = this.host.operation;
    const app = this.host.closest("kin-app");
    let portableMembership;
    if (app.syncCoordinator) portableMembership = await app.syncCoordinator.portableMembershipSnapshot();
    else if (app.household?.identity) {
      const response = await fetch("/api/sync/devices", { cache: "no-store" });
      if (!response.ok) throw new Error("Connect to your household before exporting its membership history.");
      portableMembership = portableMembershipFromDirectory((await response.json()).members);
    }
    this.host.assertCurrentOperation(operation);
    this.host.message.textContent = "Preparing your Kin export…";
    const progress = this.progress("Export progress");
    let bytes;
    try {
      bytes = await exportHouseholdArchive({ store: app.store, engine: app.engine, vault: getActiveVault(), portableMembership, onProgress: progress.update });
    } finally { progress.remove(); }
    this.host.assertCurrentOperation(operation);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "kin-household.kin";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.host.message.textContent = "Kin export prepared. Keep it and its recovery key safe.";
  }

  // A progress bar after the status message while an archive operation runs.
  // The archive functions report `{ done, total }` events about every 256.
  progress(label) {
    const bar = document.createElement("progress");
    bar.className = "archive-progress";
    bar.max = 1;
    bar.value = 0;
    bar.setAttribute("aria-label", label);
    this.host.message.after(bar);
    return {
      update: ({ done, total }) => { bar.max = Math.max(total, 1); bar.value = done; },
      remove: () => bar.remove(),
    };
  }

  showRestore() {
    if (this.host.busy) return;
    this.host.render();
    this.host.heading.textContent = "Restore household";
    const form = document.createElement("form");
    const file = document.createElement("input");
    file.id = "archive-file"; file.type = "file"; file.accept = ".kin"; file.required = true;
    file.setAttribute("aria-describedby", "security-alert");
    const fileLabel = document.createElement("label"); fileLabel.htmlFor = file.id; fileLabel.textContent = "Kin export";
    const recovery = document.createElement("input");
    recovery.id = "archive-recovery"; recovery.type = "password"; recovery.autocomplete = "off"; recovery.required = true;
    recovery.setAttribute("aria-describedby", "security-alert");
    const recoveryLabel = document.createElement("label"); recoveryLabel.htmlFor = recovery.id; recoveryLabel.textContent = "Export recovery key";
    const button = document.createElement("button"); button.type = "submit"; button.textContent = "Check export";
    form.append(fileLabel, file, recoveryLabel, recovery, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files[0]; const secret = recovery.value; recovery.value = "";
      void this.host.run(async (operation) => {
        if (!selected || selected.size > 160 * 1024 * 1024) throw new Error("Choose a Kin archive no larger than 160 MiB.");
        const app = this.host.closest("kin-app");
        const engine = app.engine, vault = getActiveVault();
        this.host.message.textContent = "Checking your Kin export…";
        const bytes = new Uint8Array(await selected.arrayBuffer());
        this.host.assertCurrentOperation(operation);
        const checking = this.progress("Export check progress");
        let staged;
        try {
          staged = await validateHouseholdArchive({ bytes, recoverySecret: secret, engine, vault, onProgress: checking.update });
        } finally { checking.remove(); }
        this.host.assertCurrentOperation(operation);
        this.host.restoreStage = staged.stage;
        form.remove();
        const summary = document.createElement("p");
        summary.textContent = `This export is ready to restore (${staged.eventCount} household changes, ${staged.attachmentCount} attachments). Restore works on an empty installation or as a no-duplicate check when this same household already contains the export. Device approval and sync access are not included.`;
        const confirm = document.createElement("button");
        confirm.id = "restore-confirm";
        confirm.type = "button";
        confirm.textContent = "Restore household";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        confirm.addEventListener("click", () => void this.host.run(async (confirmOperation) => {
          this.host.message.textContent = "Restoring your household… Keep this tab open.";
          const restoring = this.progress("Restore progress");
          let restored;
          try {
            restored = await restoreValidatedHouseholdArchive({ stage: staged.stage, engine, vault, store: app.store, onProgress: restoring.update });
          } finally { restoring.remove(); }
          this.host.restoreStage = null;
          this.host.assertCurrentOperation(confirmOperation);
          await this.host.services.refreshFromEvents();
          this.host.assertCurrentOperation(confirmOperation);
          // Restored history replaces what reminders pointed at; end them.
          this.host.services.clearReminders();
          this.host.services.broadcastEventChange();
          this.host.render();
          this.host.message.textContent = restored.alreadyPresent
            ? "This household already contains the export's history and attachments. Nothing was duplicated."
            : "Your household is restored on this device. This device still needs household approval before sync can resume.";
        }));
        cancel.addEventListener("click", () => {
          discardValidatedHouseholdArchive(staged.stage);
          this.host.restoreStage = null;
          summary.remove(); confirm.remove(); cancel.remove();
          this.host.showRestore();
        });
        this.host.append(summary, confirm, cancel);
        confirm.focus();
        this.host.message.textContent = "This export is ready to restore.";
      });
    });
    this.host.append(form);
    this.host.button("Cancel", () => this.host.render());
    file.focus();
  }
}
