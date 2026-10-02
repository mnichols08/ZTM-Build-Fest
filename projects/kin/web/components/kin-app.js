import { loadKinEngine } from "../wasm/kin-engine.js";
import { EventStore } from "../storage/event-store.js";
import "./kin-compose.js";
import "./kin-item.js";
import "./kin-today.js";

const START_ERROR =
  "Kin could not start its household engine or local storage. Your saved information was not intentionally deleted.";
const SAVE_ERROR =
  "Kin could not save that change locally. Your existing information was not intentionally deleted.";

class KinApp extends HTMLElement {
  constructor() {
    super();
    this.engine = null;
    this.store = null;
    this.state = { items: [] };
    this.busy = false;
    this.starting = null;
    this.initialized = false;
    this.channel = null;
    this.refreshing = false;
    this.pendingRefresh = false;
    this.retryAction = null;
    this.onAddItem = (event) => this.handleAddItem(event);
    this.onCompleteItem = (event) => this.handleCompleteItem(event);
    this.onPeerMessage = (event) => this.handlePeerMessage(event);
  }

  connectedCallback() {
    if (!this.initialized) {
      this.initializeElements();
      this.initialized = true;
    }
    this.addEventListener("kin:add-item", this.onAddItem);
    this.addEventListener("kin:complete-item", this.onCompleteItem);
    this.openPeerChannel();
    this.initialize();
  }

  initializeElements() {
    const header = document.createElement("header");
    header.className = "site-header";
    const brand = document.createElement("div");
    brand.className = "brand";
    const title = document.createElement("h1");
    title.textContent = "Kin";
    const tagline = document.createElement("p");
    tagline.textContent = "A little more in step.";
    brand.append(title, tagline);
    header.append(brand);

    const main = document.createElement("main");
    main.id = "main";
    main.tabIndex = -1;
    main.setAttribute("aria-busy", "true");
    this.main = main;
    this.today = document.createElement("kin-today");
    this.compose = document.createElement("kin-compose");
    main.append(this.today, this.compose);

    const feedback = document.createElement("div");
    feedback.className = "app-feedback";
    this.status = document.createElement("p");
    this.status.className = "status-message";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.alert = document.createElement("p");
    this.alert.className = "error-message";
    this.alert.setAttribute("role", "alert");
    this.alert.hidden = true;
    this.retryButton = document.createElement("button");
    this.retryButton.type = "button";
    this.retryButton.className = "retry-button";
    this.retryButton.textContent = "Try again";
    this.retryButton.hidden = true;
    feedback.append(this.status, this.alert, this.retryButton);

    this.replaceChildren(header, main, feedback);
    this.retryButton.addEventListener("click", () => this.retryAction?.());
  }

  disconnectedCallback() {
    this.removeEventListener("kin:add-item", this.onAddItem);
    this.removeEventListener("kin:complete-item", this.onCompleteItem);
    this.closePeerChannel();
  }

  async initialize() {
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.loadApplication();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async loadApplication() {
    const retrying = !this.retryButton.hidden;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Starting Kin…");
    try {
      this.store?.close();
      this.engine = await loadKinEngine();
      this.store = await EventStore.open();
      this.openPeerChannel();
      const events = await this.store.loadEvents();
      this.state = this.engine.applyEvents(
        events.map((event) => event.encoded_event),
      );
      this.renderState();
      this.setStatus("Ready.");
      this.retryButton.hidden = true;
    } catch (error) {
      this.store?.close();
      this.store = null;
      this.showAlert(error.userMessage ?? START_ERROR, () => this.initialize());
      this.setStatus("");
    } finally {
      this.setBusy(false);
      if (retrying && this.store) {
        this.compose.focusInput();
      }
      this.flushPeerRefresh();
    }
  }

  async handleAddItem(event) {
    if (this.busy || !this.store || !this.engine) {
      return;
    }
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    let restoreComposeFocus = false;
    try {
      this.state = await this.store.append(
        { type: "add", text: event.detail.text },
        this.engine,
      );
      this.renderState();
      this.compose.clear();
      this.setStatus("Added.");
      this.broadcastEventChange();
      restoreComposeFocus = true;
    } catch (error) {
      this.showAlert(error.userMessage ?? SAVE_ERROR, () =>
        this.handleAddItem({ detail: { text: event.detail.text } }),
      );
      this.setStatus("");
      restoreComposeFocus = true;
    } finally {
      this.setBusy(false);
      if (restoreComposeFocus) {
        this.compose.focusInput();
      }
      this.flushPeerRefresh();
    }
  }

  async handleCompleteItem(event) {
    if (this.busy || !this.store || !this.engine) {
      return;
    }
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    let restoreComposeFocus = false;
    try {
      this.state = await this.store.append(
        { type: "complete", itemId: event.detail.itemId },
        this.engine,
      );
      this.renderState();
      this.setStatus("Marked complete.");
      this.broadcastEventChange();
      restoreComposeFocus = true;
    } catch (error) {
      this.showAlert(error.userMessage ?? SAVE_ERROR, () =>
        this.handleCompleteItem({ detail: { itemId: event.detail.itemId } }),
      );
      this.setStatus("");
      restoreComposeFocus = true;
    } finally {
      this.setBusy(false);
      if (restoreComposeFocus) {
        this.compose.focusInput();
      }
      this.flushPeerRefresh();
    }
  }

  openPeerChannel() {
    if (this.channel || !("BroadcastChannel" in globalThis)) {
      return;
    }
    try {
      this.channel = new BroadcastChannel("kin-household-events-v1");
      this.channel.addEventListener("message", this.onPeerMessage);
    } catch {
      this.channel = null;
    }
  }

  closePeerChannel() {
    this.channel?.removeEventListener("message", this.onPeerMessage);
    this.channel?.close();
    this.channel = null;
  }

  broadcastEventChange() {
    try {
      this.channel?.postMessage({ type: "events-changed" });
    } catch {
      // Cross-tab refresh is best-effort; IndexedDB remains authoritative.
    }
  }

  handlePeerMessage(event) {
    if (event.data?.type !== "events-changed") {
      return;
    }
    if (this.busy || this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshFromEvents();
  }

  async refreshFromEvents() {
    if (!this.store || !this.engine || this.busy || this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshing = true;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Updating from another tab…");
    try {
      const events = await this.store.loadEvents();
      this.state = this.engine.applyEvents(
        events.map((storedEvent) => storedEvent.encoded_event),
      );
      this.renderState();
      this.setStatus("Updated from another tab.");
    } catch (error) {
      this.showAlert(
        error.userMessage ??
          "Kin could not refresh from local household storage. Your saved information was not deleted.",
        () => this.refreshFromEvents(),
      );
      this.setStatus("");
    } finally {
      this.refreshing = false;
      this.setBusy(false);
      this.flushPeerRefresh();
    }
  }

  flushPeerRefresh() {
    if (!this.pendingRefresh || this.busy || this.refreshing) {
      return;
    }
    this.pendingRefresh = false;
    queueMicrotask(() => this.refreshFromEvents());
  }

  renderState() {
    this.today.items = this.state.items;
  }

  setBusy(isBusy) {
    this.busy = isBusy;
    this.main.setAttribute("aria-busy", String(isBusy));
    this.compose.disabled = isBusy || !this.store;
    this.today.disabled = isBusy || !this.store;
  }

  setStatus(message) {
    this.status.textContent = message;
  }

  clearAlert() {
    this.alert.textContent = "";
    this.alert.hidden = true;
    this.retryButton.hidden = true;
    this.retryAction = null;
  }

  showAlert(message, retryAction = null) {
    this.alert.textContent = message;
    this.alert.hidden = false;
    this.retryAction = retryAction;
    this.retryButton.hidden = typeof retryAction !== "function";
  }
}

customElements.define("kin-app", KinApp);
