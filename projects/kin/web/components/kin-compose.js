const MAX_ITEM_TEXT_BYTES = 4096;
const textEncoder = new TextEncoder();

export const CLASSIFICATION_LABELS = {
  today: "Today",
  need: "Needs",
  shopping: "Shopping",
  staple: "Staples",
};

// Presentation only. Canonical values are the Rust classification names.
export const CLASSIFICATIONS = Object.keys(CLASSIFICATION_LABELS);

class KinCompose extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = false;
    this.initialized = false;
    // "scope" keeps control ids unique when several capture forms are mounted.
    this.scope = "";
    // A fixed destination (list capture) hides the selector; the page default
    // only seeds the selector and never overrides a destination the person chose.
    this.fixedClassification = null;
    this.defaultClassification = "today";
    this.labelText = "What should we remember?";
  }

  static get observedAttributes() {
    return ["scope", "fixed-classification", "default-classification", "label"];
  }

  attributeChangedCallback(name, _old, value) {
    if (name === "scope") this.scope = value ?? "";
    else if (name === "fixed-classification") this.fixedClassification = CLASSIFICATIONS.includes(value) ? value : null;
    else if (name === "default-classification") this.defaultClassification = CLASSIFICATIONS.includes(value) ? value : "today";
    else if (name === "label" && value) this.labelText = value;
  }

  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const suffix = this.scope ? `-${this.scope}` : "";
    this.form = document.createElement("form");
    this.form.className = this.fixedClassification ? "compose-form compose-form-compact" : "compose-form";
    this.label = document.createElement("label");
    this.label.htmlFor = `item-text${suffix}`;
    this.label.textContent = this.labelText;
    this.input = document.createElement("input");
    this.input.id = `item-text${suffix}`;
    this.input.name = "item";
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.maxLength = MAX_ITEM_TEXT_BYTES;
    this.input.required = true;
    this.input.setAttribute("aria-describedby", `compose-message${suffix}`);
    this.classificationLabel = document.createElement("label");
    this.classificationLabel.htmlFor = `item-classification${suffix}`;
    this.classificationLabel.textContent = "Add to";
    this.classification = document.createElement("select");
    this.classification.id = `item-classification${suffix}`;
    this.classification.name = "classification";
    for (const [value, text] of Object.entries(CLASSIFICATION_LABELS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.classification.append(option);
    }
    this.classificationField = document.createElement("div");
    this.classificationField.className = "classification-field";
    this.classificationField.append(
      this.classificationLabel,
      this.classification,
    );
    this.button = document.createElement("button");
    this.button.className = "add-button";
    this.button.type = "submit";
    this.button.textContent = "Add";
    this.message = document.createElement("p");
    this.message.id = `compose-message${suffix}`;
    this.message.className = "compose-message";
    this.message.setAttribute("aria-live", "polite");
    this.restoreDraft();
    this.input.addEventListener("input", () => this.saveDraft());
    this.form.append(this.label, this.input);
    if (this.fixedClassification) {
      this.classification.value = this.fixedClassification;
      this.classification.hidden = true;
      this.classificationField.hidden = true;
      this.input.placeholder = `Add to ${CLASSIFICATION_LABELS[this.fixedClassification]}`;
      this.input.setAttribute("aria-label", `Add to ${CLASSIFICATION_LABELS[this.fixedClassification]}`);
      this.label.className = "visually-hidden";
    } else {
      this.form.append(this.classificationField);
    }
    this.form.append(this.button, this.message);
    this.replaceChildren(this.form);
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.classification.addEventListener("change", () => this.saveDraft());
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    if (!this.input) return;
    this.input.disabled = this.isDisabled;
    this.classification.disabled = this.isDisabled;
    this.button.disabled = this.isDisabled;
  }

  get currentClassification() {
    return this.fixedClassification ?? this.classification.value;
  }

  clearIfMatches(submittedDraft) {
    // Completion belongs to the submitted draft, not a newer edit. The chosen
    // destination stays selected so a second item lands where the person expects.
    if (
      this.input.value !== submittedDraft.text ||
      this.currentClassification !== submittedDraft.classification
    ) {
      return;
    }
    this.input.value = "";
    this.message.textContent = "";
  }

  focusInput() {
    this.input.focus();
  }

  restoreDraft() {
    this.input.value = "";
    this.classification.value = this.fixedClassification ?? this.defaultClassification;
  }

  saveDraft() {
    // Drafts remain in the unlocked input only; lock replaces the component.
  }

  submit(event) {
    event.preventDefault();
    if (this.isDisabled) {
      return;
    }
    const text = this.input.value;
    const classification = this.currentClassification;
    const textLength = textEncoder.encode(text).length;
    if (!text.trim()) {
      this.message.textContent = "Add a few words first.";
      this.input.focus();
      return;
    }
    if (textLength > MAX_ITEM_TEXT_BYTES) {
      this.message.textContent = "Keep the item under 4096 UTF-8 bytes.";
      this.input.focus();
      return;
    }
    this.message.textContent = "";
    this.dispatchEvent(
      new CustomEvent("kin:add-item", {
        detail: { text, classification, composer: this },
        bubbles: true,
        composed: true,
        cancelable: false,
      }),
    );
  }
}

customElements.define("kin-compose", KinCompose);
