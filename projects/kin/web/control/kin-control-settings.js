// The control panel's settings (ADR 0025 §9, §11; #718). Every change
// needs a fresh confirmation: on this computer a code Kin prints in its
// window and log, through the household's address the admin's passkey or
// password (control-api.js). For now it holds the new-household limit;
// backups (#721) and updates (#722) add their settings as more entries in
// SETTINGS, each a { kind, title, render(status), change(form) }.
import { el } from "./dom.js";
import { explain } from "./explain.js";
import { countOf } from "./format.js";

export const SETTINGS = [
  {
    kind: "households-limit",
    title: "New households",
    describe: (status) => `People can create up to ${countOf(status.limits?.maxHouseholds ?? 1, "household", "households")} on this home server. Raise it to give, say, grandparents a household of their own here. Invitations into existing households work either way.`,
    available: (status) => !status.limits?.fromEnvironment,
    unavailable: () => explain("control-limit-from-environment"),
    field: (status) => {
      const select = el("select", { id: "control-setting-households-limit", name: "maxHouseholds" });
      const highest = status.limits?.highest ?? 10;
      for (let value = 1; value <= highest; value += 1)
        select.append(el("option", { value: String(value), selected: value === status.limits?.maxHouseholds, text: countOf(value, "household", "households") }));
      return { label: "Households allowed", control: select };
    },
    change: (control) => ({ kind: "households-limit", maxHouseholds: Number(control.value) }),
  },
];

export class KinControlSettings extends HTMLElement {
  #status = null;

  constructor() {
    super();
    this.api = null;
    this.busy = false;
    this.pending = null;
  }

  get status() { return this.#status; }
  set status(value) {
    const before = this.#status;
    this.#status = value;
    // Redraw only when a setting's value changed, and never under a change
    // someone is confirming.
    if (before === null || (!this.busy && !this.pending && JSON.stringify(before.limits) !== JSON.stringify(value?.limits))) this.render();
  }

  render() {
    const status = this.#status;
    if (!status) { this.replaceChildren(); return; }
    this.message = el("p", { className: "control-message", role: "status" });
    this.replaceChildren(
      el("h2", { id: "control-settings-title", text: "Settings" }),
      el("p", { className: "control-muted", text: this.api?.loopback
        ? "Each change asks for a confirmation code that Kin prints in its window and log on this computer."
        : "Each change asks you to confirm with your passkey or password." }),
      ...SETTINGS.map((setting) => this.#setting(setting, status)),
      this.message,
    );
  }

  #setting(setting, status) {
    const section = el("section", { className: "control-card", "data-setting": setting.kind, "aria-labelledby": `setting-${setting.kind}` },
      el("h3", { id: `setting-${setting.kind}`, text: setting.title }),
      el("p", { text: setting.describe(status) }));
    if (!setting.available(status)) {
      section.append(el("p", { className: "control-muted", text: setting.unavailable(status) }));
      return section;
    }
    const { label, control } = setting.field(status);
    const save = el("button", { type: "submit", className: "primary-action", text: "Save" });
    const form = el("form", { className: "control-form", onsubmit: (event) => { event.preventDefault(); this.save(setting.change(control), save, form); } },
      el("label", { for: control.id, text: label }), control,
      el("div", { className: "control-actions" }, save));
    section.append(form);
    return section;
  }

  #say(text, alert = false) {
    this.message.setAttribute("role", alert ? "alert" : "status");
    this.message.textContent = text;
  }

  /** Saves `change` after a fresh confirmation. On this computer that is
   * a printed code, asked for in a small form under the setting. */
  async save(change, button, form) {
    if (this.busy) return;
    if (this.api.loopback) { await this.#askForCode(change, form); return; }
    this.busy = true;
    button.disabled = true;
    this.#say("Confirm the change when Kin asks.");
    try {
      await this.api.change(change);
      this.#say("Saved.");
      this.dispatchEvent(new CustomEvent("changed", { bubbles: true }));
    } catch (error) {
      this.#say(error?.name === "NotAllowedError" ? "Cancelled. Nothing changed." : explain(error.code), true);
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }

  async #askForCode(change, form) {
    try {
      await this.api.post("confirm-code");
    } catch (error) {
      if (error.code !== "control-code-too-soon") { this.#say(explain(error.code), true); return; }
    }
    this.pending = change;
    form.parentNode?.querySelector?.(".control-confirm")?.remove();
    const input = el("input", { id: `control-confirm-${change.kind}`, type: "text", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: false, required: true, maxLength: 11 });
    const confirm = el("button", { type: "submit", className: "primary-action", text: "Confirm" });
    const cancel = el("button", { type: "button", className: "secondary", text: "Cancel", onclick: () => { this.pending = null; box.remove(); this.#say("Cancelled. Nothing changed."); } });
    const box = el("form", { className: "control-form control-confirm", onsubmit: async (event) => {
      event.preventDefault();
      if (this.busy) return;
      this.busy = true;
      confirm.disabled = true;
      try {
        await this.api.change(this.pending, { code: input.value });
        this.pending = null;
        box.remove();
        this.#say("Saved.");
        this.dispatchEvent(new CustomEvent("changed", { bubbles: true }));
      } catch (error) {
        this.#say(`${explain(error.code)}${Number.isInteger(error.attemptsLeft) ? ` ${error.attemptsLeft} more ${error.attemptsLeft === 1 ? "try" : "tries"}.` : ""}`, true);
        input.focus();
      } finally {
        this.busy = false;
        confirm.disabled = false;
      }
    } },
      el("label", { for: input.id, text: "Confirmation code" }),
      el("p", { className: "control-hint", text: "Kin printed it in its window and log on this computer just now." }),
      input,
      el("div", { className: "control-actions" }, confirm, cancel));
    if (typeof form.after === "function") form.after(box);
    else form.parentNode?.append(box);
    input.focus();
  }
}

if (!customElements.get("kin-control-settings")) customElements.define("kin-control-settings", KinControlSettings);
