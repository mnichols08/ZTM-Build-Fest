// This week (#416): reads the week from Rust while the page is showing and
// hands it to <kin-week>. State stays on the element (`this.app`);
// app/context.js explains the controllers.
export class WeekController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
  }

  /** Reads and draws the week when the This week page is showing. Reads
   * coalesce: one in flight, at most one more after it. */
  async refresh() {
    if (this.app.route?.page !== "week" || !this.app.week || !this.app.store || !this.app.state) return;
    if (this.reading) { this.again = true; return this.reading; }
    const session = this.ctx.session.captureSession();
    this.reading = (async () => {
      try {
        const today = this.ctx.navigation.currentCivilDate();
        const days = await session.store.week(today);
        if (!this.ctx.session.isCurrentSession(session) || !this.app.week) return;
        this.app.week.update({ days, today, state: this.app.state, context: this.ctx.detail.responsibilityContext() });
      } catch {
        // The page keeps what it showed; the next render tries again.
      } finally {
        this.reading = null;
        if (this.again) { this.again = false; void this.refresh(); }
      }
    })();
    return this.reading;
  }
}
