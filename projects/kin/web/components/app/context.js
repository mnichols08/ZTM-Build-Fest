// The explicit dependency container shared by <kin-app>'s controllers.
// `app` is the element: it owns the state and DOM references the controllers
// read and write. Controllers reach each other through this object only.
import { RenderController } from "./render.js";
import { ShellBuilder } from "./shell.js";
import { StatusController } from "./status.js";
import { ViewBuilder } from "./views.js";

export function createAppContext(app) {
  const ctx = { app };
  ctx.status = new StatusController(ctx);
  ctx.render = new RenderController(ctx);
  ctx.shell = new ShellBuilder(ctx);
  ctx.views = new ViewBuilder(ctx);
  return ctx;
}
