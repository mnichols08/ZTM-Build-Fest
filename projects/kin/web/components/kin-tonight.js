// Tonight on Today (#333): one quiet line saying what's for dinner and who is
// cooking, with a link to Meals. With nothing planned it says so and offers
// "Plan dinner"; it never nags or counts. The meals controller calls
// update({ text, href }) after each refresh; text is null when nothing is
// planned for tonight.
class KinTonight extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    const section = document.createElement("section");
    section.className = "today-section tonight-section";
    section.dataset.section = "tonight";
    section.setAttribute("aria-labelledby", "tonight-heading");
    const heading = document.createElement("h2");
    heading.id = "tonight-heading";
    heading.textContent = "Tonight";
    this.line = document.createElement("p");
    this.line.className = "tonight-line";
    this.link = document.createElement("a");
    this.link.className = "tonight-link";
    section.append(heading, this.line, this.link);
    this.append(section);
    this.render();
  }

  update({ text = null, href = "#lists/meals" } = {}) {
    this.text = text;
    this.href = href;
    this.render();
  }

  render() {
    if (!this.line) return;
    this.line.textContent = this.text ?? "Nothing planned for tonight.";
    this.line.classList.toggle("tonight-empty", !this.text);
    this.link.href = this.href ?? "#lists/meals";
    this.link.textContent = this.text ? "Open Meals" : "Plan dinner";
  }
}

customElements.define("kin-tonight", KinTonight);
