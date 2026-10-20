// Sharing into Kin and home-screen shortcuts (#389): once Kin is unlocked,
// offer what another app shared (share-target.js) and run a shortcut's
// action. State stays on the element (`this.app`); app/context.js explains
// the controllers.
import { consumeLaunchAction, consumeShare, sharedText } from "../../share-target.js";
import { routeHash } from "../../routes.js";

export class ShareController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  /** After unlock (session.js): a waiting shortcut action, then a waiting
   * share. Simple view does neither: it adds nothing (#345). */
  async afterUnlock() {
    const action = consumeLaunchAction();
    const shared = await consumeShare();
    if (this.app.simpleView) {
      if (shared) this.ctx.status.setStatus("Sharing into Kin isn't available in Simple view.");
      return;
    }
    if (!this.ctx.navigation.workspaceReady()) return;
    if (action === "quick-add") this.ctx.append.runWorkspaceCommand("quick-add");
    if (shared) await this.offer(shared);
  }

  /** Asks where a share should go, then hands it to that kind's dialog. */
  async offer(shared) {
    const { text, body, link } = sharedText(shared);
    const files = (shared.files ?? []).map((file) => ({ name: file.name || "Shared file", size: file.size, type: file.type, load: async () => file }));
    if (!text && !files.length) {
      this.ctx.status.setStatus("Nothing came through to add.");
      return;
    }
    const chat = this.app.chat;
    const chatOpen = this.app.chatAccess !== "none" && chat?.chatRoom && (chat.chatRoom.access ?? "write") === "write";
    const allowed = new Set(["todo", "shopping", "note", "handoff", ...(chatOpen ? ["chat"] : [])]);
    const sheet = this.app.shareSheet;
    if (!sheet) return;
    const kind = await sheet.choose({ text, link, files, allowed });
    if (!kind) {
      this.ctx.status.setStatus("Nothing was added.");
      return;
    }
    if (kind === "chat") {
      this.ctx.navigation.navigate(routeHash("updates", "chat"));
      chat.prefill?.({ text: body.length <= 2_000 ? body : text, files: shared.files ?? [] });
      return;
    }
    this.ctx.chatShare.open({
      kind,
      text: kind === "note" ? body : text,
      files,
      audience: "Everyone in your household will see this.",
      opener: null,
    });
  }
}
