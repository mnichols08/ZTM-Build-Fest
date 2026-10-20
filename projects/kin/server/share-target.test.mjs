// Sharing into Kin (#389): the manifest offers the share target, and a share
// that reaches the server (no service worker yet) is not read or kept: the app
// just opens.
import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

async function start(t) {
  const app = createKinServer({ service: new PairingService(), acquireProcessLock: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test("the manifest offers sharing into Kin and the shortcuts", async (t) => {
  const url = await start(t);
  const manifest = await (await fetch(`${url}/manifest.webmanifest`)).json();
  assert.deepEqual({ action: manifest.share_target.action, method: manifest.share_target.method, enctype: manifest.share_target.enctype },
    { action: "/share", method: "POST", enctype: "multipart/form-data" });
  assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url), ["/#kin-action=quick-add", "/#lists/shopping", "/#updates/chat", "/#today"]);
});

test("a share POSTed to the server opens the app without keeping anything", async (t) => {
  const url = await start(t);
  const form = new FormData();
  form.set("text", "private note");
  form.append("files", new File(["secret"], "letter.pdf", { type: "application/pdf" }));
  const response = await fetch(`${url}/share`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});
