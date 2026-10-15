// The single command append path and its retry, focus and error handling.
// Moved verbatim from <kin-app>; state stays on the element (`this.app`).
import { routeHash } from "../../../routes.js";

export class AppendCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async appendCommand(command) {
    const session = this.app.ctx.session.captureSession();
    this.app.ctx.session.assertCurrentSession(session);
    const result = await session.store.append(command, session.engine);
    this.app.ctx.session.assertCurrentSession(session);
    this.app.state = result.state;
    this.app.snapshotBoundary = result.snapshotBoundary;
    void this.app.syncCoordinator?.syncNow();
  }
  // The allowlisted command ids map onto the same methods the visible
  // navigation, Search link, and Quick add button use.
  runWorkspaceCommand(id, { opener = null } = {}) {
    if (!this.app.workspaceReady()) return;
    switch (id) {
      case "today":
        this.app.navigate("#today");
        this.app.pages.get("today")?.querySelector("h1")?.focus();
        return;
      case "todo":
      case "shopping":
        this.app.navigate(routeHash("lists", id));
        this.app.segmentNavs.get("lists")?.focusCurrent();
        return;
      case "search":
        this.app.navigate("#search");
        this.app.search.focusInput?.();
        return;
      case "quick-add":
        if (this.app.quickAdd.isDisabled) {
          this.app.setStatus("Quick add is available again once Kin finishes saving.");
          this.restoreCommandFocus(opener);
          return;
        }
        this.app.quickAdd.open({ opener, fallback: () => this.app.main.querySelector(".app-view:not([hidden]) h1") });
        return;
      case "shortcuts":
        this.app.commandGeneration = this.app.securityGeneration;
        this.app.commandPalette.openHelp({ opener });
        return;
    }
  }
  restoreCommandFocus(opener) {
    if (!this.app.workspaceReady()) return;
    if (opener?.isConnected && !opener.closest("[hidden], [inert]") && opener.getClientRects().length) opener.focus();
    else this.app.main.querySelector(".app-view:not([hidden]) h1")?.focus();
  }
  showDetailActionError(itemId, message, retry, intent = null) {
    if (!this.app.detail) { this.app.ctx.status.showAlert(message, retry, intent); return; }
    this.app.detail.setFeedback(itemId, { itemId, message, retry, intent });
    if (this.app.selection) this.app.feedDetail();
  }
}
