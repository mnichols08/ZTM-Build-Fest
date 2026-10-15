// Rendering the projection into the views.
// Moved verbatim from <kin-app>; state stays on the element (`this.app`).
import { routeHash, SEGMENTS } from "../../routes.js";
import { formatCivilDate } from "../../today-view.js";

export class RenderController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  renderState() {
    if (!this.app.vault || this.app.vault.locked || !this.app.state) return;
    // Rendering reconciles the whole unlocked workspace and is also used for
    // background sync. Suppress motion during that pass; navigation and
    // explicitly opened detail sheets keep their separate entrance effects.
    const renderToken = (this.app.quietRenderToken ?? 0) + 1;
    this.app.quietRenderToken = renderToken;
    this.app.setAttribute("data-quiet-render", "");
    try {
      this.renderStateContents();
    } finally {
      const clearQuietRender = () => {
        if (this.app.quietRenderToken === renderToken) this.app.removeAttribute("data-quiet-render");
      };
      if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(clearQuietRender);
      else setTimeout(clearQuietRender, 0);
    }
  }
  renderStateContents() {
    const mode = this.app.state.mode ?? "normal";
    this.app.modeSelect.value = mode;
    this.app.routines.householdMode = mode;
    const civilDate = this.app.currentCivilDate();
    const responsibilityContext = this.app.responsibilityContext();
    this.app.catchUp.summary = this.app.state.summary;
    this.app.catchUp.lastLookedAt = this.app.catchUpCursor?.lastLookedAt;
    this.app.todayDate.textContent = formatCivilDate(civilDate);
    const selected = this.app.selection?.itemId ?? null;
    for (const list of [this.app.needs, this.app.shopping, this.app.staples]) {
      list.update({
        today: civilDate,
        items: this.app.state.items,
        responsibilityContext,
        areas: this.app.state.areas ?? [],
        pins: this.app.state.pins ?? [],
        attachments: this.app.attachmentRows,
        selected,
      });
    }
    this.app.today.update({
      today: civilDate,
      items: this.app.state.items,
      responsibilityContext,
      areas: this.app.state.areas ?? [],
      pins: this.app.state.pins ?? [],
      attachments: this.app.attachmentRows,
      selected,
      routines: this.app.state.routines ?? [],
      handoffs: this.app.state.handoffs ?? [],
      mode,
    });
    const waiting = (this.app.state.handoffs ?? []).filter((record) => record.status === "unacknowledged").length;
    const updatesNav = this.app.segmentNavs?.get("updates");
    if (updatesNav) updatesNav.segments = SEGMENTS.updates.map((entry) => ({ id: entry.id, label: entry.label, hash: routeHash("updates", entry.id), count: entry.id === "handoffs" ? waiting : 0, countLabel: "waiting" }));
    if (updatesNav && this.app.route?.page === "updates") updatesNav.current = this.app.route.segment;
    const activePulse = this.app.state.pulses.find((pulse) => pulse.actorId === this.app.store?.actorId && pulse.status === "active");
    if (this.app.householdGlance) this.app.householdGlance.textContent = `Household mode: ${{ normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" }[mode] ?? mode}${mode !== "normal" ? " (routines paused)" : ""}. Your pulse: ${activePulse ? activePulse.value.replace("-", " ") : "not set"}.`;
    if (this.app.selection) {
      const current = this.app.state.items.find((item) => item.itemId === this.app.selection.itemId) ?? null;
      this.app.feedDetail(current);
    }
    this.app.ctx.records.renderReminders();
    this.app.handoffs.handoffs = this.app.state.handoffs;
    this.app.talks.talks = this.app.state.talks;
    this.app.search.household = {
      items: this.app.state.items,
      handoffs: this.app.state.handoffs,
      talks: this.app.state.talks,
      notes: this.app.state.notes ?? [],
      referenceRecords: this.app.state.referenceRecords ?? [],
      maintenanceEvents: this.app.state.maintenanceEvents ?? [],
      areas: this.app.state.areas ?? [],
    };
    this.app.pulse.pulse = this.app.state.pulses.find(
      (pulse) => pulse.actorId === this.app.store?.actorId,
    );
    this.app.routines.today = civilDate;
    this.app.routines.routines = this.app.state.routines ?? [];
    this.app.routines.responsibilityContext = responsibilityContext;
    this.app.routines.playbooks = this.app.state.playbooks ?? [];
    this.app.areas.areas = this.app.state.areas ?? [];
    this.app.notes.notes = this.app.state.notes ?? [];
    this.app.notes.references = this.app.state.referenceRecords ?? [];
    this.app.notes.maintenance = this.app.state.maintenanceEvents ?? [];
    this.app.notes.attachments = this.app.attachmentRows;
    this.app.notes.routines = this.app.state.routines ?? [];
    this.app.notes.areas = this.app.state.areas ?? [];
    this.updateCalendarExportButton();
    this.app.schedulePulseRefresh();
  }
  updateCalendarExportButton() {
    if (!this.app.calendarExportButton) return;
    this.app.calendarExportButton.disabled = this.app.busy || !this.app.state?.items?.some(
      (item) => item.status === "active" && item.planningDate != null,
    );
  }
}
