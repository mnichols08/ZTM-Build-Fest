// Building the destination pages and their components.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { routeHash, SEGMENTS } from "../../routes.js";
import { currentPlatform, installHelp } from "../../platform.js";
import { installHelpCard } from "../shared/dom.js";

export class ViewBuilder {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  buildViews(main) {
    const page = (id, title, description = null) => {
      const section = document.createElement("section");
      section.className = "app-view";
      section.id = id;
      section.dataset.page = id;
      section.setAttribute("aria-labelledby", `${id}-title`);
      const intro = document.createElement("header");
      intro.className = "page-intro";
      const heading = document.createElement("h1");
      heading.id = `${id}-title`;
      heading.tabIndex = -1;
      heading.textContent = title;
      intro.append(heading);
      if (description) {
        const supporting = document.createElement("p");
        supporting.className = "page-lead";
        supporting.textContent = description;
        intro.append(supporting);
      }
      section.append(intro);
      return section;
    };
    const segmentNav = (pageId, label) => {
      const nav = document.createElement("kin-segment-nav");
      nav.setAttribute("label", label);
      nav.segments = SEGMENTS[pageId].map((entry) => ({ id: entry.id, label: entry.id === "hub" ? "Overview" : entry.label, hash: routeHash(pageId, entry.id) }));
      return nav;
    };
    this.app.pages = new Map();
    this.app.segmentNavs = new Map();
    this.app.segmentPanels = new Map();

    // Today: a practical heading (the date), the capture field, catch-up, the
    // onboarding card while it applies, and the composition.
    const today = page("today", "Today");
    this.app.todayDate = document.createElement("p");
    this.app.todayDate.className = "page-lead today-date";
    today.querySelector(".page-intro").append(this.app.todayDate);
    this.app.compose.setAttribute("mode", "today");
    this.app.compose.setAttribute("scope", "today");
    this.app.catchUp.setAttribute("aria-label", "Catch up since you last looked");
    this.app.today.display = "today";
    this.app.today.previews = this.app.previewProvider;
    this.app.onboarding = document.createElement("section");
    this.app.onboarding.className = "today-section onboarding-card";
    this.app.onboarding.hidden = true;
    today.append(this.app.compose, this.app.catchUp, this.app.onboarding, this.app.today);

    // Lists: one list at a time, each with its own quick-add; export lives in
    // the list actions with its warning at the point of use.
    const lists = page("lists", "Lists");
    const listsNav = segmentNav("lists", "Lists");
    this.app.segmentNavs.set("lists", listsNav);
    lists.append(listsNav);
    const listActions = document.createElement("details");
    listActions.className = "list-actions";
    const listActionsSummary = document.createElement("summary");
    listActionsSummary.textContent = "List actions";
    this.app.calendarExportButton = document.createElement("button");
    this.app.calendarExportButton.type = "button";
    this.app.calendarExportButton.className = "calendar-export-button";
    this.app.calendarExportButton.textContent = "Download calendar (.ics)";
    this.app.calendarExportButton.setAttribute("aria-label", "Download active planned Items as an all-day calendar");
    this.app.calendarExportButton.disabled = true;
    this.app.calendarExportButton.addEventListener("click", () => this.ctx.records.downloadCalendar());
    const calendarExportNote = document.createElement("p");
    calendarExportNote.className = "section-hint";
    calendarExportNote.textContent = "Exports every open item that has a planned date, from all lists. The downloaded .ics file is not encrypted and contains the item text.";
    listActions.append(listActionsSummary, this.app.calendarExportButton, calendarExportNote);
    lists.append(listActions);
    this.app.needs.display = "need";
    this.app.shopping.display = "shopping";
    this.app.staples.display = "staple";
    const listPanels = new Map([["todo", this.app.needs], ["shopping", this.app.shopping], ["staples", this.app.staples]]);
    for (const [segment, list] of listPanels) {
      list.previews = this.app.previewProvider;
      list.dataset.segment = segment;
      lists.append(list);
    }
    this.app.segmentPanels.set("lists", listPanels);

    const search = page("search", "Search");
    search.append(this.app.search);

    const routines = page("routines", "Routines");
    const routinesNav = segmentNav("routines", "Routines");
    this.app.segmentNavs.set("routines", routinesNav);
    routines.append(routinesNav, this.app.routines);

    const updates = page("updates", "Updates", "Handoffs pass context to someone; Talk keeps topics for a calm moment.");
    const updatesNav = segmentNav("updates", "Updates");
    this.app.segmentNavs.set("updates", updatesNav);
    const handoffPanel = document.createElement("section");
    handoffPanel.id = "handoffs-panel";
    handoffPanel.setAttribute("aria-label", "Handoffs");
    const talkPanel = document.createElement("section");
    talkPanel.id = "talk-panel";
    talkPanel.setAttribute("aria-label", "Talk");
    handoffPanel.append(this.app.handoffs);
    talkPanel.append(this.app.talks);
    updates.append(updatesNav, handoffPanel, talkPanel);
    this.app.segmentPanels.set("updates", new Map([["handoffs", handoffPanel], ["talk", talkPanel]]));

    // Household: an overview plus secondary destinations. Appearance remains
    // personal while the five primary destinations stay unchanged.
    const household = page("household", "Household");
    const householdNav = segmentNav("household", "Household");
    this.app.segmentNavs.set("household", householdNav);
    household.append(householdNav);
    const hub = document.createElement("section");
    hub.className = "household-hub";
    hub.setAttribute("aria-label", "Household overview");
    this.app.householdGlance = document.createElement("p");
    this.app.householdGlance.className = "household-glance";
    const hubLinks = document.createElement("ul");
    hubLinks.className = "hub-links";
    for (const [segment, description] of [
      ["notes", "Notes, reference details, and maintenance history."],
      ["areas", "Areas, household mode, and Pulse."],
      ["people", "Members, pairing, trusted devices, and access."],
      ["privacy", "Lock, passkeys, recovery key, export, and restore."],
      ["appearance", "Your colors and optional background on this device."],
    ]) {
      const entry = SEGMENTS.household.find((candidate) => candidate.id === segment);
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "hub-link";
      link.href = routeHash("household", segment);
      const name = document.createElement("span");
      name.className = "hub-link-name";
      name.textContent = entry.label;
      const text = document.createElement("span");
      text.className = "hub-link-text";
      text.textContent = description;
      link.append(name, text);
      item.append(link);
      hubLinks.append(item);
    }
    hub.append(this.app.householdGlance, hubLinks);
    const hubTools = document.createElement("div");
    hubTools.className = "hub-tools";
    this.app.installButton = document.createElement("button");
    this.app.installButton.type = "button";
    this.app.installButton.textContent = "Install Kin";
    this.app.installButton.hidden = true;
    this.app.installButton.addEventListener("click", async () => {
      const prompt = this.app.deferredInstallPrompt;
      if (!prompt) return;
      this.app.deferredInstallPrompt = null;
      this.app.installButton.hidden = true;
      await prompt.prompt();
      await prompt.userChoice;
    });
    if (this.app.deferredInstallPrompt) this.app.installButton.hidden = false;
    const searchLink = document.createElement("a");
    searchLink.className = "more-search-link";
    searchLink.href = "#search";
    searchLink.textContent = "Search household";
    hubTools.append(searchLink, this.app.installButton);
    // iPhone and iPad browsers have no install prompt; show the steps instead.
    const iosInstall = installHelp(currentPlatform());
    if (iosInstall) {
      const disclosure = document.createElement("details");
      disclosure.className = "install-disclosure";
      const summary = document.createElement("summary");
      summary.textContent = "Install Kin";
      disclosure.append(summary);
      installHelpCard(iosInstall, { parent: disclosure });
      hubTools.append(disclosure);
    }
    hub.append(hubTools);

    const notesPage = document.createElement("section");
    notesPage.className = "household-subpage";
    notesPage.setAttribute("aria-label", "Notes & reference");
    this.app.notes = document.createElement("kin-notes");
    this.app.notes.previews = this.app.previewProvider;
    notesPage.append(this.app.notes);

    const areasPage = document.createElement("section");
    areasPage.className = "household-subpage";
    areasPage.setAttribute("aria-label", "Areas & status");
    const modeSection = document.createElement("section");
    modeSection.className = "today-section household-mode";
    const modeHeading = document.createElement("h2");
    modeHeading.textContent = "Household mode";
    const modeLabel = document.createElement("label");
    modeLabel.htmlFor = "household-mode";
    modeLabel.textContent = "Current mode";
    this.app.modeSelect = document.createElement("select");
    this.app.modeSelect.id = "household-mode";
    for (const [value, label] of [
      ["normal", "Normal"],
      ["vacation", "Vacation"],
      ["guests", "Guests"],
      ["rest", "Rest"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.app.modeSelect.append(option);
    }
    this.app.modeSelect.addEventListener("change", this.app.onModeChange);
    const modeHint = document.createElement("p");
    modeHint.className = "section-hint";
    modeHint.textContent = "Routines pause while the household is in Vacation, Guests, or Rest; their definitions stay as they are. Nothing else changes: lists, handoffs, and access are unaffected, and Guests does not add a member.";
    modeSection.append(modeHeading, modeLabel, this.app.modeSelect, modeHint);
    areasPage.append(this.app.areas, modeSection, this.app.pulse);

    const peoplePage = document.createElement("section");
    peoplePage.className = "household-subpage";
    peoplePage.setAttribute("aria-label", "People & devices");
    this.app.household = document.createElement("kin-household");
    this.app.peoplePage = peoplePage;

    const privacyPage = document.createElement("section");
    privacyPage.className = "household-subpage";
    privacyPage.setAttribute("aria-label", "Privacy & recovery");
    const privacyLead = document.createElement("p");
    privacyLead.className = "section-hint";
    privacyLead.textContent = "Your household is encrypted on this device. Lock Kin whenever you step away; closing or reloading always locks it.";
    privacyPage.append(privacyLead);
    this.app.privacyPage = privacyPage;
    // Kept for callers that still address the former More security block.
    this.app.moreSecurity = privacyPage;

    const appearancePage = document.createElement("section");
    appearancePage.className = "household-subpage appearance-page";
    appearancePage.setAttribute("aria-label", "Personal appearance");
    this.app.appearance = document.createElement("kin-appearance");
    this.app.householdDefaults = document.createElement("kin-household-defaults");
    this.app.householdDefaults.hidden = true;
    appearancePage.append(this.app.householdDefaults, this.app.appearance);

    household.append(hub, notesPage, areasPage, peoplePage, privacyPage, appearancePage);
    this.app.segmentPanels.set("household", new Map([["hub", hub], ["notes", notesPage], ["areas", areasPage], ["people", peoplePage], ["privacy", privacyPage], ["appearance", appearancePage]]));

    for (const section of [today, lists, search, routines, updates, household]) {
      this.app.pages.set(section.id, section);
      main.append(section);
    }
    // The conditional side/inline column for item details.
    this.app.detailPanel = document.createElement("aside");
    this.app.detailPanel.className = "detail-panel";
    this.app.detailPanel.setAttribute("aria-label", "Item details");
    this.app.detailPanel.hidden = true;
    main.append(this.app.detailPanel);
    this.ctx.navigation.showPageFromLocation();
  }
}
