// Personal and household appearance and household identity.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { loadCachedHouseholdSettings } from "../../sync/sync-coordinator.js";
import { paletteCss, paletteForSeed } from "../../appearance/palette.js";
import { saveAppearance } from "../../appearance/store.js";
import { DEFAULT_HOUSEHOLD_NAME, resolveAppearance } from "../../appearance/household.js";

export class AppearanceController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  resolvedAppearanceMode(mode) {
    return mode === "system" ? (this.app.systemAppearance?.matches ? "dark" : "light") : mode;
  }
  applyAppearance(value) {
    if (!value || !this.app.vault || this.app.vault.locked) return;
    this.app.currentAppearance = structuredClone(value);
    const resolvedMode = this.resolvedAppearanceMode(value.mode);
    const tokens = paletteForSeed(value.seed, resolvedMode);
    if (!this.app.appearanceSheet && typeof CSSStyleSheet === "function") {
      this.app.appearanceSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.app.appearanceSheet];
    }
    const rules = value.mode === "system"
      ? `${paletteCss(paletteForSeed(value.seed, "light"))}@media (prefers-color-scheme:dark){${paletteCss(paletteForSeed(value.seed, "dark"))}}`
      : paletteCss(tokens);
    this.app.appearanceSheet?.replaceSync(rules);
    document.documentElement.dataset.kinAppearance = value.mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens["header-bg"]);
    const imageUnchanged = value.image && this.app.appearanceImageBytes && value.image.type === this.app.appearanceImageType &&
      value.image.bytes.length === this.app.appearanceImageBytes.length && value.image.bytes.every((byte, index) => byte === this.app.appearanceImageBytes[index]);
    if (!imageUnchanged && (value.image || this.app.appearanceImageBytes)) {
      if (this.app.appearanceObjectUrl) URL.revokeObjectURL(this.app.appearanceObjectUrl);
      this.app.appearanceObjectUrl = value.image ? URL.createObjectURL(new Blob([value.image.bytes], { type: value.image.type })) : null;
      this.app.appearanceImageBytes = value.image ? value.image.bytes.slice() : null;
      this.app.appearanceImageType = value.image?.type ?? null;
      this.app.appearanceBackground.src = this.app.appearanceObjectUrl ?? "";
      this.app.appearanceBackground.hidden = !this.app.appearanceObjectUrl;
      this.app.toggleAttribute("data-personal-background", Boolean(this.app.appearanceObjectUrl));
    }
  }
  async handleSaveAppearance(event) {
    const { value, complete } = event.detail;
    const session = this.ctx.session.captureSession();
    try {
      const saved = await saveAppearance(session.store, session.vault, value);
      this.ctx.session.assertCurrentSession(session);
      this.app.personalAppearance = structuredClone(saved);
      this.app.applyEffectiveAppearance();
      complete(saved, null);
    } catch (error) {
      if (this.ctx.session.isCurrentSession(session)) complete(null, new Error("Kin couldn't save your appearance. Your previous saved appearance is unchanged."));
    }
  }
  async handleUseHouseholdAppearance(event) {
    const session = this.ctx.session.captureSession();
    try {
      this.app.personalAppearance = await saveAppearance(session.store, session.vault, event.detail.value);
      this.ctx.session.assertCurrentSession(session);
      const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
      this.app.appearance.initialize(effective);
      this.app.applyAppearance(effective);
      this.app.setStatus("Now following the household appearance on this device.");
    } catch { if (this.ctx.session.isCurrentSession(session)) this.app.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }
  async handleInheritAppearanceProperty(event) {
    const session = this.ctx.session.captureSession();
    const next = { ...this.app.personalAppearance, version: 2 };
    if (event.detail.property === "mode") delete next.mode;
    if (event.detail.property === "color") { delete next.colorSource; delete next.seed; delete next.manual; }
    if (event.detail.property === "background") {
      delete next.image;
      if (next.colorSource === "background") { delete next.colorSource; delete next.seed; delete next.manual; }
    }
    try {
      this.app.personalAppearance = await saveAppearance(session.store, session.vault, next);
      this.ctx.session.assertCurrentSession(session);
      const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
      this.app.appearance.initialize(effective);
      this.app.applyAppearance(effective);
      this.app.setStatus(`Now following the household ${event.detail.property} on this device.`);
    } catch { if (this.ctx.session.isCurrentSession(session)) this.app.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }
  applyEffectiveAppearance() {
    const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
    this.app.applyAppearance(effective);
    this.setHouseholdIdentity(this.app.householdSettings?.name ?? DEFAULT_HOUSEHOLD_NAME);
  }
  setHouseholdIdentity(name) {
    this.app.householdName = name;
    if (this.app.brandTitle) this.app.brandTitle.textContent = name;
    if (this.app.vault && !this.app.vault.locked) document.title = `${name} — Kin`;
  }
  async refreshHouseholdDefaults() {
    if (!this.app.syncCoordinator || !this.app.vault || this.app.vault.locked) return;
    // The load spans the network and IndexedDB; a lock or re-open meanwhile
    // must not write the household name or a status into the next session.
    const session = this.ctx.session.captureSession();
    try {
      const result = await this.app.syncCoordinator.loadHouseholdSettings();
      this.ctx.session.assertCurrentSession(session);
      if (result.value && (this.app.householdSettings?.revision ?? -1) <= result.value.revision) this.app.householdSettings = result.value;
      this.app.householdDefaults.initialize({ ...result, value: this.app.householdSettings });
      this.app.applyEffectiveAppearance();
    } catch { if (this.ctx.session.isCurrentSession(session)) this.app.setStatus("Kin kept the last verified household appearance because the latest shared settings could not be loaded."); }
  }
  async restoreCachedHouseholdDefaults(identity, session = this.ctx.session.captureSession()) {
    if (!identity) return;
    try {
      const value = await loadCachedHouseholdSettings(identity);
      this.ctx.session.assertCurrentSession(session);
      if (value && (this.app.householdSettings?.revision ?? -1) <= value.revision) this.app.householdSettings = value;
      this.app.householdDefaults.initialize({ admin: false, adminRecorded: false, value: this.app.householdSettings });
      this.app.applyEffectiveAppearance();
    } catch {
      if (this.ctx.session.isCurrentSession(session)) this.app.setStatus("Kin couldn't restore the last shared appearance. Local household information is still available.");
    }
  }
  async handleSaveHouseholdDefaults(event) {
    const { value, complete } = event.detail;
    if (!this.app.syncCoordinator) { complete(null, new Error("Connect household sync before changing shared settings.")); return; }
    const session = this.ctx.session.captureSession();
    try {
      const saved = await this.app.syncCoordinator.saveHouseholdSettings(value);
      this.ctx.session.assertCurrentSession(session);
      this.app.householdSettings = saved;
      this.app.applyEffectiveAppearance();
      complete(saved, null);
    } catch (error) {
      // A save settling after lock or a household re-open (including the
      // stale-session assert above) reports nothing: a re-open keeps the same
      // editor for the new session. A committed server write is unaffected.
      if (this.ctx.session.isCurrentSession(session)) complete(null, error);
    }
  }
  clearAppliedAppearance() {
    this.app.currentAppearance = null;
    this.app.personalAppearance = null;
    this.app.householdSettings = null;
    this.app.householdName = null;
    if (this.app.brandTitle) this.app.brandTitle.textContent = "Kin";
    document.title = "Kin";
    delete document.documentElement.dataset.kinAppearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#684033");
    if (this.app.appearanceSheet) this.app.appearanceSheet.replaceSync("");
    if (this.app.appearanceObjectUrl) URL.revokeObjectURL(this.app.appearanceObjectUrl);
    this.app.appearanceObjectUrl = null;
    this.app.appearanceImageBytes = null;
    this.app.appearanceImageType = null;
    if (this.app.appearanceBackground) { this.app.appearanceBackground.removeAttribute("src"); this.app.appearanceBackground.hidden = true; }
    this.app.removeAttribute("data-personal-background");
    this.app.appearance?.clear();
  }
}
