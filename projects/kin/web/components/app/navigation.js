// Routes, keyboard shortcuts and search-result navigation.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { projectionContext } from "../../browser-time.js";
import { listSegmentForClassification, resolveRoute, routeHash } from "../../routes.js";
import { isTypingContext, shortcutForKey } from "../../keyboard-commands.js";

export class NavigationController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  navigate(hash) {
    const route = resolveRoute({ hash, pathname: location.pathname });
    if (location.hash !== route.hash) history.pushState(null, "", route.hash);
    this.ctx.navigation.showPageFromLocation();
  }
  showPageFromLocation() {
    if (!this.app.pages || !this.app.navLinks) return;
    const route = resolveRoute({ hash: location.hash, pathname: location.pathname });
    const previous = this.app.route ?? null;
    const changed = previous?.canonical !== route.canonical;
    if (previous && changed) this.app.pageScroll.set(previous.canonical, window.scrollY);
    this.app.route = route;
    this.app.activePage = route.page;
    this.app.dataset.route = route.canonical;
    document.title = this.app.vault && !this.app.vault.locked && this.app.householdName ? `${this.app.householdName} — Kin` : `${route.title} — Kin`;
    if (changed && this.app.routeAnnouncement) this.app.routeAnnouncement.textContent = `${route.title} view`;
    for (const [id, section] of this.app.pages) section.hidden = id !== route.page;
    for (const [id, link] of this.app.navLinks) {
      if (id === route.destination) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const [pageId, nav] of this.app.segmentNavs) if (pageId === route.page) nav.current = route.segment;
    for (const [pageId, panels] of this.app.segmentPanels) {
      if (pageId !== route.page) continue;
      for (const [segment, panel] of panels) panel.hidden = segment !== route.segment;
    }
    if (route.page === "routines") this.app.routines.view = route.segment;
    // Details stay open only within the page that opened them.
    if (this.app.selection && this.app.selection.page !== route.page) this.ctx.detail.closeItemDetail({ restoreFocus: false });
    this.ctx.detail.mountDetail();
    if (changed && previous) {
      const remembered = this.app.pageScroll.get(route.canonical) ?? 0;
      requestAnimationFrame(() => window.scrollTo({ top: remembered, behavior: "auto" }));
      if (route.page === "search") this.app.search.focusInput?.();
    }
  }
  // Shortcuts and palette commands act only on an unlocked, rendered
  // workspace; the security screen and its fields never see them.
  workspaceReady() {
    return Boolean(this.app.vault && !this.app.vault.locked && this.app.store && this.app.main && !this.app.main.hidden &&
      this.app.siteTools && !this.app.siteTools.hidden && this.app.commandPalette?.isConnected);
  }
  handleShortcutKeydown(event) {
    if (event.defaultPrevented || !this.ctx.navigation.workspaceReady()) return;
    const shortcut = shortcutForKey(event, { mac: this.app.macShortcuts });
    if (!shortcut) return;
    const openDialogs = [...this.app.querySelectorAll("dialog[open]")];
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const opener = active && active !== document.body && active !== document.documentElement ? active : null;
    if (shortcut === "palette") {
      // Another app dialog (Quick add, item details, the photo viewer) keeps
      // its keyboard; the browser keeps Ctrl/Cmd+K there too.
      if (openDialogs.some((dialog) => !this.app.commandPalette.contains(dialog))) return;
      event.preventDefault();
      if (!this.app.commandPalette.isOpen) this.app.commandGeneration = this.app.securityGeneration;
      this.app.commandPalette.openPalette({ opener });
      return;
    }
    if (openDialogs.length || isTypingContext(event, active)) return;
    event.preventDefault();
    this.ctx.append.runWorkspaceCommand(shortcut, { opener });
  }
  layoutMode() {
    if (this.app.phoneQuery?.matches) return "sheet";
    if (this.app.wideQuery?.matches) return "side";
    return "inline";
  }
  // Search results open the real record by canonical id.
  /** A chat message picked on the Search page (#124): open Chat and show it. */
  handleOpenChatMessage(detail) {
    if (!this.app.state || !this.app.chat?.room) return;
    this.ctx.navigation.navigate(routeHash("updates", "chat"));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void this.app.chat.showSearchResult(detail);
    }));
  }

  handleOpenSearchResult(detail) {
    if (!this.app.state) return;
    const unavailable = () => this.ctx.status.setStatus("That record is no longer available. It may have been archived or removed.");
    const reveal = (hash, selector) => {
      this.ctx.navigation.navigate(hash);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = this.app.main.querySelector(selector);
        if (!target) { unavailable(); return; }
        target.scrollIntoView({ block: "center" });
        target.classList.add("record-highlight");
        setTimeout(() => target.classList.remove("record-highlight"), 2_500);
        (target.matches("button, input, select, textarea, [tabindex]") ? target : target.querySelector("button, [tabindex]") ?? target).focus();
      }));
    };
    switch (detail.kind) {
      case "item":
      case "step": {
        const itemId = detail.kind === "step" ? detail.itemId : detail.id;
        const item = this.app.state.items.find((record) => record.itemId === itemId && record.status !== "archived");
        if (!item) { unavailable(); return; }
        this.ctx.navigation.navigate(routeHash("lists", listSegmentForClassification(item.classification)));
        this.ctx.detail.openItemDetail(itemId, { opener: detail.opener, stepId: detail.kind === "step" ? detail.stepId : null, origin: "search" });
        this.app.selection.originId = detail.id;
        return;
      }
      case "handoff":
        if (!this.app.state.handoffs.some((record) => record.handoffId === detail.id && record.status !== "archived")) { unavailable(); return; }
        reveal(routeHash("updates", "handoffs"), `[data-handoff-id="${detail.id}"]`);
        return;
      case "talk":
        if (!this.app.state.talks.some((record) => record.talkId === detail.id && record.status !== "archived")) { unavailable(); return; }
        reveal(routeHash("updates", "talk"), `[data-talk-id="${detail.id}"]`);
        return;
      case "note":
        if (!(this.app.state.notes ?? []).some((record) => record.noteId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-note-id="${detail.id}"]`);
        return;
      case "reference-record":
        if (!(this.app.state.referenceRecords ?? []).some((record) => record.recordId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-record-id="${detail.id}"]`);
        return;
      case "maintenance":
        if (!(this.app.state.maintenanceEvents ?? []).some((record) => record.maintenanceId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-maintenance-id="${detail.id}"]`);
        return;
      default:
        unavailable();
    }
  }
  currentCivilDate() { return projectionContext().civilDate; }
}
