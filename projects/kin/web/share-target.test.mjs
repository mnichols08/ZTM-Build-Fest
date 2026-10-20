// Sharing into Kin (#389): reading the share id and shortcut actions from the
// address, tidying what was shared, and fetching it from the worker once.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchShared, sharedText, takeLaunchAction, takeShareId } from "./share-target.js";

const history = () => { const calls = []; return { calls, replaceState: (...args) => calls.push(args[2]) }; };
const ID = "ab".repeat(16);

test("a share id is taken from the address, which is reset at once", () => {
  const past = history();
  assert.equal(takeShareId({ hash: `#kin-share=${ID}` }, past), ID);
  assert.deepEqual(past.calls, ["/"]);
  const other = history();
  assert.equal(takeShareId({ hash: "#today" }, other), "");
  assert.deepEqual(other.calls, [], "other addresses are left alone");
  assert.equal(takeShareId({ hash: "#kin-share=nothex" }, history()), "", "a malformed id is dropped (and still cleared)");
});

test("a shortcut's action is taken the same way; unknown actions do nothing", () => {
  const past = history();
  assert.equal(takeLaunchAction({ hash: "#kin-action=quick-add" }, past), "quick-add");
  assert.deepEqual(past.calls, ["/"]);
  assert.equal(takeLaunchAction({ hash: "#kin-action=delete-everything" }, history()), "");
  assert.equal(takeLaunchAction({ hash: "#lists" }, history()), "");
});

test("shared text becomes an item line and a note body", () => {
  assert.deepEqual(sharedText({ title: "Pancakes", text: "", url: "https://example.test/p" }),
    { text: "Pancakes https://example.test/p", body: "Pancakes\n\nhttps://example.test/p", link: "https://example.test/p" });
  // A link inside the text, as many apps send it.
  const fromText = sharedText({ text: "Look at this https://example.test/x." });
  assert.equal(fromText.link, "https://example.test/x");
  assert.equal(fromText.text, "Look at this https://example.test/x");
  // Multi-line text: the first line for an item, everything for a note.
  const lines = sharedText({ text: "Milk\nEggs\r\nBread" });
  assert.equal(lines.text, "Milk");
  assert.equal(lines.body, "Milk\nEggs\nBread");
  assert.equal(sharedText({ title: "Same", text: "Same" }).body, "Same", "a repeated title isn't doubled");
  assert.equal(sharedText({ text: "x".repeat(10_000) }).body.length, 4_000, "bounded");
});

test("the share is fetched from the worker once, with files kept as files", async () => {
  const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
  const controller = { postMessage(message, [port]) { assert.equal(message.id, ID); port.postMessage({ title: "T", text: "x", url: "", files: [file, "not a file"] }); } };
  const shared = await fetchShared(ID, { worker: { controller } });
  assert.equal(shared.title, "T");
  assert.equal(shared.files.length, 1);
  assert.equal(await fetchShared("bad", { worker: { controller } }), null);
  assert.equal(await fetchShared(ID, { worker: null }), null, "no worker: nothing");
  const silent = { postMessage() {} };
  assert.equal(await fetchShared(ID, { worker: { controller: silent }, timeout: 50 }), null, "a worker that doesn't answer times out");
});
