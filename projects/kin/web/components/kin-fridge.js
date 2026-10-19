// The family fridge (#317, ADR 0011): a fixed 3:4 "door" everyone in the
// household draws on. Rust owns the board (board.rs); this element draws the
// KBRD state the board room returns and turns pointer strokes into board
// changes.
//
// - Strokes are drawn on a canvas sized to the door's CSS box × the device
//   pixel ratio (at most 3). The stroke in progress has its own layer, so the
//   rest is redrawn only when the board changes.
// - Pointer Events with `touch-action: none` on the door only: the page
//   around it still scrolls and zooms. While a pen is down, touches are
//   ignored (palm rejection); a second finger cancels a finger stroke.
// - Colours are palette indices (CSS custom properties), so dark mode and
//   forced colours remap them. Three widths. The eraser removes whole
//   strokes.
// - Undo and redo cover this device's own changes in this visit: undoing a
//   stroke erases it, undoing an erase brings the stroke back.
// - A text summary says what is on the fridge, for screen readers and for
//   anyone who can't see the drawing.
import { MAX_VISIBLE_STROKES, BOARD_WIDTH, BOARD_HEIGHT, boardPoints, simplifyStroke, splitStroke } from "../wasm/kin-board.js";
import { newBoardId } from "../board/board-room.js";
import { FRIDGE_COLOURS, FRIDGE_WIDTHS, fridgeSummary, strokeAt } from "../board/fridge-view.js";

const MAX_PIXEL_RATIO = 3;
const UNDO_LIMIT = 50;

/** What a refused change means, in plain words. */
function changeProblem(error, board) {
  if ((board?.strokes?.length ?? 0) >= MAX_VISIBLE_STROKES) return "The fridge is full. Erase something or clear it to draw more.";
  if (error?.code === "board_locked") return "Unlock Kin to draw on the fridge.";
  return error?.userMessage ?? "Kin couldn't save that to the fridge. Try again.";
}

class KinFridge extends HTMLElement {
  constructor() {
    super();
    this.roomValue = null;
    this.unsubscribe = null;
    this.state = null;
    this.colour = 0;
    this.width = 1;
    this.tool = "pen";
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;
    this.penDown = false;
    this.labelOf = (id) => (id === this.memberId ? "you" : "a household member");
    this.memberId = null;
    this.onResize = () => this.resize();
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
    this.resizeObserver ??= typeof ResizeObserver === "function" ? new ResizeObserver(this.onResize) : null;
    this.resizeObserver?.observe(this.door);
    this.resize();
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
  }

  get room() {
    return this.roomValue;
  }

  /** The board room (board-room.js), or null while locked or unavailable. */
  set room(value) {
    if (value === this.roomValue) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.roomValue = value;
    this.undoStack = [];
    this.redoStack = [];
    this.cancelStroke();
    if (value) this.unsubscribe = value.subscribe(() => this.render());
    if (!this.firstElementChild) this.build();
    this.render();
  }

  build() {
    this.className = "fridge";
    const heading = document.createElement("h2");
    heading.className = "fridge-heading";
    heading.textContent = "Fridge";
    const lead = document.createElement("p");
    lead.className = "section-hint";
    lead.textContent = "A shared board for the household: draw anything. Everyone sees it once they sync.";

    this.tools = document.createElement("div");
    this.tools.className = "fridge-tools";
    this.tools.setAttribute("role", "toolbar");
    this.tools.setAttribute("aria-label", "Drawing tools");
    const colours = document.createElement("div");
    colours.className = "fridge-colours";
    colours.setAttribute("role", "group");
    colours.setAttribute("aria-label", "Pen colour");
    this.colourButtons = FRIDGE_COLOURS.map((name, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fridge-colour";
      button.style.setProperty("--swatch", `var(--fridge-ink-${index})`);
      button.setAttribute("aria-label", name);
      button.title = name;
      button.addEventListener("click", () => { this.colour = index; this.tool = "pen"; this.updateTools(); });
      colours.append(button);
      return button;
    });
    const widths = document.createElement("div");
    widths.className = "fridge-widths";
    widths.setAttribute("role", "group");
    widths.setAttribute("aria-label", "Pen width");
    this.widthButtons = FRIDGE_WIDTHS.map(({ label }, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fridge-width";
      button.dataset.width = String(index);
      button.setAttribute("aria-label", label);
      button.title = label;
      button.addEventListener("click", () => { this.width = index; this.tool = "pen"; this.updateTools(); });
      widths.append(button);
      return button;
    });
    this.eraserButton = document.createElement("button");
    this.eraserButton.type = "button";
    this.eraserButton.className = "fridge-eraser";
    this.eraserButton.textContent = "Eraser";
    this.eraserButton.addEventListener("click", () => { this.tool = this.tool === "eraser" ? "pen" : "eraser"; this.updateTools(); });
    this.undoButton = document.createElement("button");
    this.undoButton.type = "button";
    this.undoButton.textContent = "Undo";
    this.undoButton.addEventListener("click", () => void this.undo());
    this.redoButton = document.createElement("button");
    this.redoButton.type = "button";
    this.redoButton.textContent = "Redo";
    this.redoButton.addEventListener("click", () => void this.redo());
    const history = document.createElement("div");
    history.className = "fridge-history";
    history.append(this.undoButton, this.redoButton);
    this.tools.append(colours, widths, this.eraserButton, history);

    this.door = document.createElement("div");
    this.door.className = "fridge-door";
    this.ink = document.createElement("canvas");
    this.ink.className = "fridge-ink";
    this.ink.setAttribute("aria-hidden", "true");
    this.live = document.createElement("canvas");
    this.live.className = "fridge-live";
    this.live.setAttribute("aria-hidden", "true");
    this.door.append(this.ink, this.live);
    this.door.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.door.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.door.addEventListener("pointerup", (event) => void this.pointerUp(event));
    this.door.addEventListener("pointercancel", (event) => this.pointerCancel(event));
    this.door.addEventListener("contextmenu", (event) => event.preventDefault());

    this.summary = document.createElement("p");
    this.summary.className = "fridge-summary";
    this.summary.setAttribute("aria-live", "polite");
    this.status = document.createElement("p");
    this.status.className = "fridge-status";
    this.status.setAttribute("role", "status");
    this.status.hidden = true;

    const board = document.createElement("div");
    board.className = "fridge-board";
    board.append(this.door);
    this.append(heading, lead, this.tools, board, this.summary, this.status);
    this.updateTools();
  }

  updateTools() {
    if (!this.tools) return;
    this.colourButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(this.tool === "pen" && index === this.colour)));
    this.widthButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === this.width)));
    this.eraserButton.setAttribute("aria-pressed", String(this.tool === "eraser"));
    this.door.dataset.tool = this.tool;
    const usable = Boolean(this.room);
    this.undoButton.disabled = !usable || !this.undoStack.length;
    this.redoButton.disabled = !usable || !this.redoStack.length;
  }

  showStatus(message) {
    this.status.textContent = message ?? "";
    this.status.hidden = !message;
  }

  render() {
    if (!this.firstElementChild) return;
    const room = this.room;
    if (!room) {
      this.state = null;
      this.summary.textContent = "The fridge opens once this device syncs with your household.";
      this.door.setAttribute("aria-disabled", "true");
      this.drawInk();
      this.updateTools();
      return;
    }
    this.door.removeAttribute("aria-disabled");
    try {
      this.state = room.board();
    } catch (error) {
      if (error?.code === "board_locked") return;
      this.state = null;
      this.showStatus("Kin couldn't read the fridge on this device.");
    }
    let summary = fridgeSummary(this.state, this.labelOf);
    if (room.waiting) summary += " Waiting to send.";
    if (room.syncError) summary += " The fridge will sync again shortly.";
    this.summary.textContent = summary;
    this.drawInk();
    this.updateTools();
  }

  // ---- Canvas -------------------------------------------------------------

  resize() {
    if (!this.door) return;
    const rect = this.door.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(MAX_PIXEL_RATIO, globalThis.devicePixelRatio || 1);
    for (const canvas of [this.ink, this.live]) {
      const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    this.drawInk();
  }

  palette() {
    const style = getComputedStyle(this);
    return FRIDGE_COLOURS.map((_, index) => style.getPropertyValue(`--fridge-ink-${index}`).trim() || "CanvasText");
  }

  /** Board units to canvas pixels. */
  scale(canvas) {
    return { x: canvas.width / BOARD_WIDTH, y: canvas.height / BOARD_HEIGHT };
  }

  drawPath(context, points, scale, widthUnits) {
    context.lineWidth = Math.max(1, widthUnits * scale.x);
    context.beginPath();
    if (points.length === 2) {
      context.arc(points[0] * scale.x, points[1] * scale.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    context.moveTo(points[0] * scale.x, points[1] * scale.y);
    for (let p = 2; p < points.length; p += 2) context.lineTo(points[p] * scale.x, points[p + 1] * scale.y);
    context.stroke();
  }

  drawInk() {
    const context = this.ink?.getContext?.("2d");
    if (!context) return;
    context.clearRect(0, 0, this.ink.width, this.ink.height);
    const strokes = this.state?.strokes ?? [];
    if (!strokes.length) return;
    const palette = this.palette();
    const scale = this.scale(this.ink);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      context.strokeStyle = context.fillStyle = palette[stroke.colour] ?? palette[0];
      this.drawPath(context, stroke.points, scale, FRIDGE_WIDTHS[stroke.width]?.units ?? FRIDGE_WIDTHS[1].units);
    }
  }

  // ---- Pointer input ------------------------------------------------------

  boardPoint(event) {
    const rect = this.door.getBoundingClientRect();
    return [((event.clientX - rect.left) / rect.width) * BOARD_WIDTH, ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT];
  }

  pointerDown(event) {
    if (!this.room || event.button > 0) return;
    // Palm rejection: while a pen is drawing, touches don't count.
    if (event.pointerType === "touch" && this.penDown) return;
    // A second finger while drawing with a finger is a gesture, not ink.
    if (this.stroke && this.stroke.pointerId !== event.pointerId) {
      if (this.stroke.pointerType === "touch" && event.pointerType === "touch") this.cancelStroke();
      return;
    }
    event.preventDefault();
    // Capture keeps a stroke going past the door's edge; some pointers
    // (a synthetic one, or one already lifted) can't be captured.
    try { this.door.setPointerCapture?.(event.pointerId); } catch { /* still draws inside the door */ }
    if (event.pointerType === "pen") this.penDown = true;
    if (this.tool === "eraser") {
      this.stroke = { pointerId: event.pointerId, pointerType: event.pointerType, erasing: true, erased: new Set() };
      void this.eraseAt(this.boardPoint(event));
      return;
    }
    this.stroke = { pointerId: event.pointerId, pointerType: event.pointerType, points: [this.boardPoint(event)] };
    this.drawLive();
  }

  pointerMove(event) {
    const stroke = this.stroke;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const samples = events.length ? events : [event];
    if (stroke.erasing) {
      for (const sample of samples) void this.eraseAt(this.boardPoint(sample));
      return;
    }
    for (const sample of samples) stroke.points.push(this.boardPoint(sample));
    this.drawLive();
  }

  async pointerUp(event) {
    const stroke = this.stroke;
    if (event.pointerType === "pen") this.penDown = false;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    this.stroke = null;
    this.clearLive();
    if (stroke.erasing) return;
    const points = simplifyStroke(boardPoints(stroke.points), 2);
    if (!points.length) return;
    const ids = [];
    try {
      for (const piece of splitStroke(points)) {
        const strokeId = newBoardId();
        await this.room.change({ type: "add-stroke", strokeId, colour: this.colour, width: this.width, points: piece });
        ids.push(strokeId);
      }
      this.showStatus("");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    if (ids.length) this.remember({ kind: "draw", ids });
  }

  pointerCancel(event) {
    if (event.pointerType === "pen") this.penDown = false;
    if (this.stroke?.pointerId === event.pointerId) this.cancelStroke();
  }

  cancelStroke() {
    this.stroke = null;
    this.clearLive();
  }

  drawLive() {
    const context = this.live?.getContext?.("2d");
    const points = this.stroke?.points;
    if (!context || !points?.length) return;
    context.clearRect(0, 0, this.live.width, this.live.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = context.fillStyle = this.palette()[this.colour];
    this.drawPath(context, points.flat(), this.scale(this.live), FRIDGE_WIDTHS[this.width].units);
  }

  clearLive() {
    const context = this.live?.getContext?.("2d");
    if (context) context.clearRect(0, 0, this.live.width, this.live.height);
  }

  async eraseAt([x, y]) {
    const hit = strokeAt(this.state?.strokes ?? [], x, y);
    if (!hit || this.stroke?.erased?.has(hit.id)) return;
    this.stroke?.erased?.add(hit.id);
    try {
      await this.room.change({ type: "hide-stroke", strokeId: hit.id, hidden: true });
      this.remember({ kind: "erase", ids: [hit.id] });
      this.showStatus("");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
  }

  // ---- Undo and redo (this device's own changes in this visit) -------------

  remember(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateTools();
  }

  /** Applies an entry backwards (undo) or forwards (redo). A stroke someone
   * else has erased (or restored) meanwhile is left as it is. */
  async apply(entry, backwards) {
    const hidden = entry.kind === "draw" ? backwards : !backwards;
    const visible = new Set((this.room.board().strokes ?? []).map((stroke) => stroke.id));
    for (const strokeId of entry.ids) {
      if (visible.has(strokeId) !== hidden) continue;
      await this.room.change({ type: "hide-stroke", strokeId, hidden });
    }
  }

  async undo() {
    const entry = this.undoStack.pop();
    if (!entry || !this.room) return;
    try {
      await this.apply(entry, true);
      this.redoStack.push(entry);
      this.showStatus(entry.kind === "draw" ? "Drawing undone." : "Erase undone.");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    this.updateTools();
  }

  async redo() {
    const entry = this.redoStack.pop();
    if (!entry || !this.room) return;
    try {
      await this.apply(entry, false);
      this.undoStack.push(entry);
      this.showStatus(entry.kind === "draw" ? "Drawing restored." : "Erased again.");
    } catch (error) {
      this.showStatus(changeProblem(error, this.state));
    }
    this.updateTools();
  }
}

customElements.define("kin-fridge", KinFridge);
