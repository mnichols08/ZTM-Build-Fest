import { MAX_SEARCH_RESULTS, searchHouseholdRecords } from "../search.js";

class KinSearch extends HTMLElement {
  constructor() {
    super();
    this.records = { items: [], handoffs: [], talks: [], notes: [], referenceRecords: [], maintenanceEvents: [], areas: [] };
    this.isDisabled = false;
  }

  connectedCallback() {
    if (this.queryInput) return;

    const section = document.createElement("section");
    section.className = "today-section search-section";
    const heading = document.createElement("h2");
    heading.textContent = "Search household";
    const hint = document.createElement("p");
    hint.className = "search-hint";
    hint.textContent =
      "Searches run on this device across Items, checklist Steps, Handoffs, Talks, Notes, household references, and maintenance history.";

    this.form = document.createElement("form");
    this.form.className = "search-form";
    this.form.autocomplete = "off";
    this.form.addEventListener("submit", (event) => event.preventDefault());
    const queryLabel = document.createElement("label");
    queryLabel.htmlFor = "household-search-query";
    queryLabel.textContent = "Search household text";
    this.queryInput = document.createElement("input");
    this.queryInput.id = "household-search-query";
    this.queryInput.type = "search";
    this.queryInput.autocomplete = "off";
    this.queryInput.spellcheck = false;
    this.queryInput.placeholder = "Try a word or phrase";
    this.queryInput.addEventListener("input", () => this.renderResults());

    const filters = document.createElement("fieldset");
    filters.className = "search-filters";
    const filtersHeading = document.createElement("legend");
    filtersHeading.textContent = "Filter Item results";
    filters.append(filtersHeading);
    this.classificationSelect = this.createFilter(
      filters,
      "Classification",
      [
        ["", "All classifications"],
        ["today", "Today"],
        ["need", "Needs"],
        ["shopping", "Shopping"],
        ["staple", "Staples"],
      ],
    );
    this.statusSelect = this.createFilter(filters, "Status", [
      ["", "Active or completed"],
      ["active", "Active"],
      ["completed", "Completed"],
    ]);
    this.areaSelect = this.createFilter(filters, "Area", [["", "Any area"]]);

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "search-clear-button";
    this.clearButton.textContent = "Clear search and filters";
    this.clearButton.addEventListener("click", () => {
      this.queryInput.value = "";
      this.classificationSelect.value = "";
      this.statusSelect.value = "";
      this.areaSelect.value = "";
      this.renderResults();
      this.queryInput.focus();
    });

    this.resultStatus = document.createElement("p");
    this.resultStatus.className = "search-result-status";
    this.resultStatus.setAttribute("role", "status");
    this.resultStatus.setAttribute("aria-live", "polite");
    this.resultStatus.setAttribute("aria-atomic", "true");
    this.resultsList = document.createElement("ol");
    this.resultsList.className = "search-results";
    this.form.append(queryLabel, this.queryInput, filters, this.clearButton);
    section.append(heading, hint, this.form, this.resultStatus, this.resultsList);
    this.replaceChildren(section);

    this.updateAreaOptions();
    this.renderResults();
    this.disabled = this.isDisabled;
  }

  set household(value) {
    this.records = {
      items: Array.isArray(value?.items) ? value.items : [],
      handoffs: Array.isArray(value?.handoffs) ? value.handoffs : [],
      talks: Array.isArray(value?.talks) ? value.talks : [],
      notes: Array.isArray(value?.notes) ? value.notes : [],
      referenceRecords: Array.isArray(value?.referenceRecords) ? value.referenceRecords : [],
      maintenanceEvents: Array.isArray(value?.maintenanceEvents) ? value.maintenanceEvents : [],
      areas: Array.isArray(value?.areas) ? value.areas : [],
    };
    this.updateAreaOptions();
    this.renderResults();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, select, button")) {
      control.disabled = this.isDisabled;
    }
  }

  createFilter(fieldset, labelText, options) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const select = document.createElement("select");
    for (const [value, text] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.addEventListener("change", () => this.renderResults());
    label.append(select);
    fieldset.append(label);
    return select;
  }

  updateAreaOptions() {
    if (!this.areaSelect) return;
    const signature = this.records.areas
      .map((area) => `${area.areaId}\0${area.name}\0${area.archived}`)
      .join("\u0001");
    if (signature === this.areaSignature) return;
    const selected = this.areaSelect.value;
    const focused = document.activeElement === this.areaSelect;
    this.areaSelect.replaceChildren();
    const anyArea = document.createElement("option");
    anyArea.value = "";
    anyArea.textContent = "Any area";
    this.areaSelect.append(anyArea);
    const unassigned = document.createElement("option");
    unassigned.value = "unassigned";
    unassigned.textContent = "No area";
    this.areaSelect.append(unassigned);
    for (const area of this.records.areas) {
      const option = document.createElement("option");
      option.value = area.areaId;
      option.textContent = `${area.name}${area.archived ? " (archived)" : ""}`;
      this.areaSelect.append(option);
    }
    this.areaSelect.value = [...this.areaSelect.options].some((option) => option.value === selected)
      ? selected
      : "";
    this.areaSignature = signature;
    if (focused) this.areaSelect.focus();
  }

  renderResults() {
    if (!this.resultStatus) return;
    const query = this.queryInput.value;
    const { results, totalCount } = searchHouseholdRecords({
      ...this.records,
      query,
      classification: this.classificationSelect.value,
      status: this.statusSelect.value,
      areaId: this.areaSelect.value,
    });
    this.resultsList.replaceChildren();
    if (!query.trim()) {
      this.resultStatus.textContent = "Enter text above to search.";
      return;
    }
    if (totalCount === 0) {
      this.resultStatus.textContent = "No matching unarchived household text.";
      return;
    }
    this.resultStatus.textContent = totalCount > MAX_SEARCH_RESULTS
      ? `Showing the first ${MAX_SEARCH_RESULTS} of ${totalCount} matches. Refine your search to narrow the results.`
      : `${totalCount} ${totalCount === 1 ? "match" : "matches"}.`;
    for (const result of results) {
      const entry = document.createElement("li");
      entry.className = "search-result";
      const kind = document.createElement("strong");
      kind.textContent = result.kind;
      const text = document.createElement("p");
      text.className = "search-result-text";
      text.textContent = result.text;
      entry.append(kind, text);
      if (result.detail) {
        const detail = document.createElement("p");
        detail.className = "search-result-detail";
        detail.textContent = result.detail;
        entry.append(detail);
      }
      if (result.context) {
        const context = document.createElement("small");
        context.className = "search-result-context";
        context.textContent = result.context;
        entry.append(context);
      }
      this.resultsList.append(entry);
    }
  }
}

customElements.define("kin-search", KinSearch);
