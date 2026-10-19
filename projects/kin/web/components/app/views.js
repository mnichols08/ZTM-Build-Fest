// Building the destination pages and their components.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { setAppBadge } from "../../chat/chat-badge.js";
import { routeHash, SEGMENTS } from "../../routes.js";
import { DESTINATION_DESCRIPTIONS } from "./constants.js";
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
    const today = page("today", "Today", "See what needs doing, or add something for your household to remember.");
    this.app.todayDate = document.createElement("p");
    this.app.todayDate.className = "page-lead today-date";
    // A gentle way to the family fridge (#317), beside the date.
    const fridgeLink = document.createElement("a");
    fridgeLink.className = "today-fridge-link";
    fridgeLink.href = routeHash("household", "fridge");
    fridgeLink.textContent = "Draw on the fridge";
    today.querySelector(".page-intro").append(this.app.todayDate, fridgeLink);
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
    const lists = page("lists", "Lists", DESTINATION_DESCRIPTIONS.lists);
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

    const routines = page("routines", "Routines", DESTINATION_DESCRIPTIONS.routines);
    const routinesNav = segmentNav("routines", "Routines");
    this.app.segmentNavs.set("routines", routinesNav);
    routines.append(routinesNav, this.app.routines);

    const updates = page("updates", "Updates", DESTINATION_DESCRIPTIONS.updates);
    // Kept so the line can drop Chat when the chat policy removes it.
    this.app.updatesLead = updates.querySelector(".page-lead");
    const updatesNav = segmentNav("updates", "Updates");
    this.app.segmentNavs.set("updates", updatesNav);
    const handoffPanel = document.createElement("section");
    handoffPanel.id = "handoffs-panel";
    handoffPanel.setAttribute("aria-label", "Handoffs");
    const talkPanel = document.createElement("section");
    talkPanel.id = "talk-panel";
    talkPanel.setAttribute("aria-label", "Talk");
    const chatPanel = document.createElement("section");
    chatPanel.id = "chat-panel";
    chatPanel.setAttribute("aria-label", "Chat");
    handoffPanel.append(this.app.handoffs);
    talkPanel.append(this.app.talks);
    chatPanel.append(this.app.chat);
    // The unread count (#133) from the chat view: on the Chat link and, where
    // the browser supports it, on the installed app's icon. Both are set from
    // what this device decrypted; no count is sent anywhere. A locked
    // household has no chat room, so the count and the icon badge clear
    // when Kin locks (docs/UX.md).
    this.app.chat.addEventListener("kin:chat-unread", (event) => {
      this.app.chatUnread = event.detail;
      this.ctx.render.renderUpdatesNav();
      setAppBadge(event.detail.count);
    });
    // The admin's chat policy (#123): with no access, Chat leaves Updates.
    this.app.chat.addEventListener("kin:chat-access", (event) => {
      this.app.chatAccess = event.detail.access;
      this.ctx.render.renderState();
      if (event.detail.access === "none" && this.app.route?.page === "updates" && this.app.route.segment === "chat")
        this.ctx.navigation.navigate(routeHash("updates", "handoffs"));
    });
    updates.append(updatesNav, handoffPanel, talkPanel, chatPanel);
    this.app.segmentPanels.set("updates", new Map([["handoffs", handoffPanel], ["talk", talkPanel], ["chat", chatPanel]]));

    // Household: an overview plus secondary destinations. Appearance remains
    // personal while the five primary destinations stay unchanged.
    const household = page("household", "Household", DESTINATION_DESCRIPTIONS.household);
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
      ["fridge", "A shared board to draw on together."],
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

    // The family fridge (#317): its board room arrives from the sync
    // coordinator once this device's keys are ready.
    const fridgePage = document.createElement("section");
    fridgePage.className = "household-subpage fridge-page";
    fridgePage.setAttribute("aria-label", "Fridge");
    this.app.fridge = document.createElement("kin-fridge");
    fridgePage.append(this.app.fridge);

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
    // People & devices reads and sets device names through the app, which
    // owns the household history and its engine (#71).
    this.app.household.deviceNames = {
      load: () => this.ctx.sync.deviceNames(),
      rename: (deviceId, nickname) => this.ctx.sync.renameDevice(deviceId, nickname),
    };
    // Preferred member names (#224, #225) arrive through the seam People &
    // devices already reads: [{ memberId, preferredName }]. A member can only
    // set their own.
    this.app.household.memberNames = {
      load: async () => (await this.ctx.sync.memberNames())
        .map(({ memberId, name }) => ({ memberId, preferredName: name })),
      rename: (name) => this.ctx.sync.setMyName(name),
    };
    this.app.peoplePage = peoplePage;
    // Per-device notification settings (#85), shown once this browser is a
    // trusted household device.
    this.app.notifications = document.createElement("kin-notifications");
    // Read receipts and typing (#120): per member, so shown with the room.
    this.app.chatSettings = document.createElement("kin-chat-settings");
    this.app.chatSettings.hidden = true;

    const privacyPage = document.createElement("section");
    privacyPage.className = "household-subpage";
    privacyPage.setAttribute("aria-label", "Privacy & recovery");
    const privacyLead = document.createElement("p");
    privacyLead.className = "section-hint";
    privacyLead.textContent = "Your household is encrypted on this device. Lock Kin whenever you step away; closing the tab always locks it.";
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
    this.app.chatPolicy = document.createElement("kin-chat-policy");
    // Who can use the fridge (#323), beside who can chat.
    this.app.boardPolicy = document.createElement("kin-board-policy");
    appearancePage.append(this.app.householdDefaults, this.app.chatPolicy, this.app.boardPolicy, this.app.appearance);

    household.append(hub, fridgePage, notesPage, areasPage, peoplePage, privacyPage, appearancePage);
    this.app.segmentPanels.set("household", new Map([["hub", hub], ["fridge", fridgePage], ["notes", notesPage], ["areas", areasPage], ["people", peoplePage], ["privacy", privacyPage], ["appearance", appearancePage]]));

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
