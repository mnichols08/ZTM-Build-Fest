// Building the destination pages and their components.
// State stays on the element (`this.app`); app/context.js explains the controllers.
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
    // This week (#416): the next seven days in one list.
    const weekLink = document.createElement("a");
    weekLink.className = "today-week-link";
    weekLink.href = "#week";
    weekLink.textContent = "This week";
    today.querySelector(".page-intro").append(this.app.todayDate, weekLink, fridgeLink);
    this.app.compose.setAttribute("mode", "today");
    this.app.compose.setAttribute("scope", "today");
    this.app.catchUp.setAttribute("aria-label", "Catch up since you last looked");
    this.app.today.display = "today";
    this.app.today.previews = this.app.previewProvider;
    this.app.onboarding = document.createElement("section");
    this.app.onboarding.className = "today-section onboarding-card";
    this.app.onboarding.hidden = true;
    today.append(this.app.compose, this.app.tonight, this.app.catchUp, this.app.onboarding, this.app.today);

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
    // Bring a list into Kin (#452): paste a list or choose a CSV/text file.
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "import-list-button";
    importButton.textContent = "Import a list…";
    importButton.addEventListener("click", () => this.ctx.importList.open({ opener: importButton }));
    const importNote = document.createElement("p");
    importNote.className = "section-hint";
    importNote.textContent = "Paste a list or choose a CSV or text file from another app. It is read on this device; you choose what to add.";
    listActions.append(listActionsSummary, this.app.calendarExportButton, calendarExportNote, importButton, importNote);
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
    this.app.meals.dataset.segment = "meals";
    lists.append(this.app.meals);
    listPanels.set("meals", this.app.meals);
    // Just for me (#510): built with the views, so a lock drops it and
    // everything it showed.
    this.app.justForMe = document.createElement("kin-just-for-me");
    this.app.justForMe.dataset.segment = "mine";
    this.app.justForMe.controller = this.ctx.privateItems;
    lists.append(this.app.justForMe);
    listPanels.set("mine", this.app.justForMe);
    this.ctx.privateItems.refresh();
    this.app.segmentPanels.set("lists", listPanels);

    const search = page("search", "Search");
    search.append(this.app.search);
    const week = page("week", "This week", "The next seven days: planned items, routines, dinners and maintenance due. Move an item to another day from here.");
    this.app.week = document.createElement("kin-week");
    week.append(this.app.week);

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
    const chatPanel = document.createElement("section");
    chatPanel.id = "chat-panel";
    chatPanel.setAttribute("aria-label", "Chat");
    handoffPanel.append(this.app.handoffs);
    // To talk about (#312, ADR 0014): the older Talk topics live in Chat's
    // list; without chat access, in their own section under Handoffs.
    this.app.talksStandalone = document.createElement("section");
    this.app.talksStandalone.id = "talk-standalone";
    this.app.talksStandalone.className = "talk-standalone";
    this.app.talksStandalone.hidden = true;
    handoffPanel.append(this.app.talksStandalone);
    chatPanel.append(this.app.chat);
    this.ctx.views.placeTalks();
    // The unread count (#133) from the chat view: on the Chat link and, if
    // the member chose it (#476), on the installed app's icon. Both are set
    // from what this device decrypted; no count is sent anywhere.
    this.app.chat.addEventListener("kin:chat-unread", (event) => {
      this.app.chatUnread = event.detail;
      this.ctx.render.renderUpdatesNav();
      this.ctx.badge.update();
    });
    // The admin's chat policy (#123): with no access, Chat leaves Updates.
    this.app.chat.addEventListener("kin:chat-access", (event) => {
      this.app.chatAccess = event.detail.access;
      this.ctx.views.placeTalks();
      this.ctx.render.renderState();
      if (event.detail.access === "none" && this.app.route?.page === "updates" && this.app.route.segment === "chat")
        this.ctx.navigation.navigate(routeHash("updates", "handoffs"));
    });
    updates.append(updatesNav, handoffPanel, chatPanel);
    this.app.segmentPanels.set("updates", new Map([["handoffs", handoffPanel], ["chat", chatPanel]]));

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
      ["privacy", "Lock, passkeys, backup key, export, and restore."],
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
    // Just for you (#497, ADR 0019): private pages, apart from the
    // household's. The journal is a page of its own, not a destination.
    const personalHeading = document.createElement("h2");
    personalHeading.className = "hub-personal-heading";
    personalHeading.id = "hub-personal-heading";
    personalHeading.textContent = "Just for you";
    const personalLinks = document.createElement("ul");
    personalLinks.className = "hub-links hub-personal";
    personalLinks.setAttribute("aria-labelledby", personalHeading.id);
    {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "hub-link journal-hub-link";
      link.href = "#journal";
      const name = document.createElement("span");
      name.className = "hub-link-name";
      name.textContent = "Journal";
      const text = document.createElement("span");
      text.className = "hub-link-text";
      text.textContent = "Your own dated entries and photos. Only you can see them.";
      link.append(name, text);
      item.append(link);
      personalLinks.append(item);
    }
    hub.append(this.app.householdGlance, hubLinks, personalHeading, personalLinks);
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
    // The count on the app icon (#476): this device's choice, under it.
    this.app.appBadge = document.createElement("kin-app-badge");
    // Read receipts and typing (#120): per member, so shown with the room.
    this.app.chatSettings = document.createElement("kin-chat-settings");
    this.app.chatSettings.hidden = true;

    const privacyPage = document.createElement("section");
    privacyPage.className = "household-subpage";
    privacyPage.setAttribute("aria-label", "Privacy & recovery");
    const privacyLead = document.createElement("p");
    privacyLead.className = "section-hint";
    privacyLead.textContent = "Your household is encrypted on this device. Lock Kin whenever you step away; closing the tab always locks it.";
    // The public privacy policy (#541), in a new tab so this one stays
    // unlocked; the service worker keeps it for offline reading.
    const policy = document.createElement("p");
    policy.className = "section-hint privacy-policy-link";
    const policyLink = Object.assign(document.createElement("a"), {
      href: "/privacy.html", target: "_blank", rel: "noopener", textContent: "Read Kin's privacy policy",
    });
    policy.append(policyLink, " — what stays on your devices, what Kin's service stores and sees, and how to delete it.");
    privacyPage.append(privacyLead, policy);
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
    // Text size, motion and reminder alerts, and where they live (#524).
    this.app.personalSettings = document.createElement("kin-personal-settings");
    this.app.personalSettings.update(this.ctx.privatePrefs.settingsView());
    appearancePage.append(this.app.householdDefaults, this.app.chatPolicy, this.app.boardPolicy, this.app.appearance, this.app.personalSettings);

    // For the sitter (#441, ADR 0017).
    const sitterPage = document.createElement("section");
    sitterPage.className = "household-subpage sitter-page";
    sitterPage.setAttribute("aria-label", "For the sitter");
    this.app.sitterEditor = document.createElement("kin-sitter-editor");
    sitterPage.append(this.app.sitterEditor);
    household.append(hub, fridgePage, notesPage, sitterPage, areasPage, peoplePage, privacyPage, appearancePage);
    this.app.segmentPanels.set("household", new Map([["hub", hub], ["fridge", fridgePage], ["notes", notesPage], ["sitter", sitterPage], ["areas", areasPage], ["people", peoplePage], ["privacy", privacyPage], ["appearance", appearancePage]]));

    // For you (#441): the page a Temporary member lands on.
    const foryou = page("foryou", "For you", "What the family left for you.");
    this.app.sitterView = document.createElement("kin-sitter-page");
    foryou.append(this.app.sitterView);
    // A member's journal (#497): private, reached from Household.
    const journal = page("journal", "Journal", "Your own record of your days, on your own devices.");
    this.app.journal = document.createElement("kin-journal");
    journal.append(this.app.journal);
    for (const section of [today, week, foryou, lists, search, routines, updates, household, journal]) {
      this.app.pages.set(section.id, section);
      main.append(section);
    }
    // The conditional side/inline column for item details.
    this.app.detailPanel = document.createElement("aside");
    this.app.detailPanel.className = "detail-panel";
    this.app.detailPanel.setAttribute("aria-label", "Item details");
    this.app.detailPanel.hidden = true;
    main.append(this.app.detailPanel);
    this.ctx.journal?.render();
    this.ctx.navigation.showPageFromLocation();
  }

  /** Where the older Talk topics show: in Chat's To talk about list, or,
   * without chat access, in a section of their own under Handoffs. */
  placeTalks() {
    const talks = this.app.talks;
    const host = this.app.talksStandalone;
    if (!talks || !host) return;
    const standalone = this.app.chatAccess === "none";
    if (standalone) {
      talks.setAttribute("heading", "To talk about");
      if (talks.parentElement !== host) host.append(talks);
      this.app.chat.legacyTopics = null;
    } else {
      talks.setAttribute("heading", "Other topics");
      this.app.chat.legacyTopics = talks;
      if (talks.parentElement === host) talks.remove();
      if (this.app.chat.legacyHost && talks.parentElement !== this.app.chat.legacyHost) this.app.chat.legacyHost.append(talks);
    }
    host.hidden = !standalone;
  }
}
