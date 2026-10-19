// "Who can chat" (#123): the household admin's choice for Limited members
// (children) and Temporary members (babysitters, guests). The policy is
// authorization metadata the service enforces, never chat content. Changing
// it needs the admin's passkey, like other admin changes. Only an admin sees
// this panel: the service sends the policy to admins alone.
import { authenticationOptions, credentialJson } from "./household/auth.js";

export const POLICY_CHOICES = Object.freeze([
  Object.freeze({ value: "write", label: "Read and post" }),
  Object.freeze({ value: "read", label: "Read only" }),
  Object.freeze({ value: "none", label: "No access" }),
]);
export const POLICY_NOTE = "Adults can always read and post. Everyone can post by default. Read only keeps the conversation visible but removes the message box. No access hides Chat for that group.";

const json = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message || "Kin couldn't reach the household service."), { code: value.error });
  return value;
};

class KinChatPolicy extends HTMLElement {
  constructor() {
    super();
    this.saved = null;
    this.busy = false;
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
    void this.load();
  }

  build() {
    this.hidden = true;
    this.className = "chat-policy";
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", "chat-policy-heading");
    const heading = document.createElement("h2");
    heading.id = "chat-policy-heading";
    heading.textContent = "Who can chat";
    const note = document.createElement("p");
    note.className = "section-hint";
    note.textContent = POLICY_NOTE;
    this.limited = this.field("chat-policy-limited", "Limited members (children)");
    this.temporary = this.field("chat-policy-temporary", "Temporary members (babysitters, guests)");
    this.save = document.createElement("button");
    this.save.type = "button";
    this.save.className = "primary-action";
    this.save.textContent = "Save chat access";
    this.save.addEventListener("click", () => void this.submit());
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.append(heading, note, this.limited.field, this.temporary.field, this.save, this.feedback);
  }

  field(id, text) {
    const field = document.createElement("div");
    field.className = "chat-policy-field";
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = text;
    const select = document.createElement("select");
    select.id = id;
    for (const choice of POLICY_CHOICES) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      select.append(option);
    }
    select.addEventListener("change", () => { this.feedback.textContent = ""; this.apply(); });
    field.append(label, select);
    return { field, select };
  }

  /** Reads the policy; the service sends it to admins only. */
  async load() {
    try {
      const status = await json("/api/sync/status");
      this.show(status.chat?.policy ?? null);
    } catch {
      this.show(null);
    }
  }

  show(policy) {
    this.saved = policy;
    this.hidden = !policy;
    if (!policy) return;
    this.limited.select.value = policy.limited;
    this.temporary.select.value = policy.temporary;
    this.apply();
  }

  apply() {
    const unchanged = this.saved && this.limited.select.value === this.saved.limited && this.temporary.select.value === this.saved.temporary;
    this.save.disabled = this.busy || unchanged;
    this.limited.select.disabled = this.temporary.select.disabled = this.busy;
  }

  async submit() {
    if (this.busy || !this.saved) return;
    const change = { limited: this.limited.select.value, temporary: this.temporary.select.value };
    const demoted = (from, to) => from !== "none" && to === "none";
    const warning = demoted(this.saved.limited, change.limited) || demoted(this.saved.temporary, change.temporary)
      ? " Members with no access can't read new messages. Anything already on their devices stays there."
      : "";
    if (!confirm(`Change who can chat?${warning}`)) return;
    this.busy = true;
    this.apply();
    this.feedback.textContent = "Confirm the change with your passkey.";
    try {
      const started = await json("/api/household/chat-policy/options", { method: "POST", body: JSON.stringify(change) });
      const credential = await navigator.credentials.get({ publicKey: authenticationOptions(started.publicKey) });
      await json("/api/household/chat-policy/finish", { method: "POST", body: JSON.stringify({ flow: started.flow, credential: credentialJson(credential) }) });
      this.saved = change;
      this.feedback.textContent = "Chat access saved. Members who are online see it now.";
    } catch (error) {
      this.feedback.textContent = error?.name === "NotAllowedError" ? "Canceled. Nothing changed." : (error?.message || "Kin couldn't save that.");
      await this.load();
    } finally {
      this.busy = false;
      this.apply();
    }
  }
}

if (!customElements.get("kin-chat-policy")) customElements.define("kin-chat-policy", KinChatPolicy);
