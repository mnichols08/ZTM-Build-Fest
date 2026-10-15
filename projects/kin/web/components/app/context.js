// The explicit dependency container shared by <kin-app>'s controllers.
// `app` is the element: it owns the state and DOM references the controllers
// read and write. Controllers reach each other through this object only.
import { AppendCommands } from "./commands/append.js";
import { BulkCommands } from "./commands/bulk.js";
import { ConversationCommands } from "./commands/conversations.js";
import { ItemCommands } from "./commands/items.js";
import { PeerChannel } from "./peer-channel.js";
import { RecordCommands } from "./commands/records.js";
import { RefreshController } from "./refresh.js";
import { RenderController } from "./render.js";
import { RoutineCommands } from "./commands/routines.js";
import { SessionController } from "./session.js";
import { ShellBuilder } from "./shell.js";
import { StatusController } from "./status.js";
import { SyncController } from "./sync.js";
import { ViewBuilder } from "./views.js";

export function createAppContext(app) {
  const ctx = { app };
  ctx.status = new StatusController(ctx);
  ctx.render = new RenderController(ctx);
  ctx.shell = new ShellBuilder(ctx);
  ctx.views = new ViewBuilder(ctx);
  ctx.session = new SessionController(ctx);
  ctx.sync = new SyncController(ctx);
  ctx.peers = new PeerChannel(ctx);
  ctx.refresh = new RefreshController(ctx);
  ctx.append = new AppendCommands(ctx);
  ctx.items = new ItemCommands(ctx);
  ctx.bulk = new BulkCommands(ctx);
  ctx.conversations = new ConversationCommands(ctx);
  ctx.routines = new RoutineCommands(ctx);
  ctx.records = new RecordCommands(ctx);
  return ctx;
}
