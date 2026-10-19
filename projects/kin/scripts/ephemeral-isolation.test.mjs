// Architecture guard (#259, ADR 0009): ephemeral live-channel messages stay
// apart from durable chat, and nothing real-time (calls, WebRTC) has slipped
// in. These read source files; they do not run the service.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "../server/live/ephemeral.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function* sources(dir, extensions) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path, extensions);
    else if (extensions.some((extension) => name.endsWith(extension)) && !/\.test\.|\.test-support\.|regression/.test(name)) yield path;
  }
}
const text = (path) => readFileSync(path, "utf8");
const rel = (path) => relative(root, path).split("\\").join("/");

test("production accepts no ephemeral category", () => {
  assert.equal(CATEGORIES.size, 0);
});

test("the ephemeral path has no database, file, log or queue access", () => {
  for (const file of ["server/live/ephemeral.mjs", "server/live/live-service.mjs"]) {
    const source = text(join(root, file));
    assert.doesNotMatch(source, /durable-store|node:sqlite|node:fs|\.prepare\(|\.exec\(|writeFile|appendFile/, file);
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, `${file} logs`);
  }
  assert.doesNotMatch(text(join(root, "server/live/ephemeral.mjs")), /import /, "the envelope module imports nothing");
});

test("nothing in the engine, events, archives or exports mentions ephemeral messages", () => {
  const places = [["rust/src", [".rs"]], ["web/security", [".js"]], ["web/chat", [".js"]], ["web/attachments", [".js"]]];
  for (const [dir, extensions] of places)
    for (const path of sources(join(root, dir), extensions))
      {
        const source = text(path);
        assert.doesNotMatch(source, /EPHEMERAL_|LIVE_TYPE\.EPHEMERAL/, rel(path));
        assert.doesNotMatch(source, /ephemeral[ -](message|signal|envelope|categor)/i, rel(path));
      }
});

test("no WebRTC, screen capture or call code, and getUserMedia only records voice messages", () => {
  const forbidden = /RTCPeerConnection|RTCSessionDescription|RTCIceCandidate|RTCDataChannel|createOffer|createAnswer|getDisplayMedia|setRemoteDescription/;
  const files = [...sources(join(root, "web"), [".js", ".html"]), ...sources(join(root, "server"), [".mjs", ".js"])];
  for (const path of files) {
    const source = text(path);
    assert.doesNotMatch(source, forbidden, rel(path));
    if (/getUserMedia/.test(source)) assert.ok(["web/chat/chat-voice.js", "web/components/kin-chat-voice.js"].includes(rel(path)) || /Permissions-Policy|microphone/.test(source) && rel(path).startsWith("server/"), `${rel(path)} uses getUserMedia`);
  }
});

test("zero third-party dependencies and the manual ABI remain", () => {
  const cargo = text(join(root, "Cargo.toml"));
  assert.doesNotMatch(cargo.split("[dependencies]")[1] ?? "", /^\s*\w/m, "no crates");
  assert.doesNotMatch(cargo, /wasm-bindgen/);
  for (const path of ["package.json"]) {
    try {
      const pkg = JSON.parse(text(join(root, path)));
      assert.deepEqual(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), []);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});

test("the decision record exists and does not promise calling", () => {
  const adr = text(join(root, "docs/decisions/0009-ephemeral-signaling-boundary.md")).replace(/\s+/g, " ");
  for (const phrase of ["Durable chat", "Ephemeral signaling", "trusted device", "DTLS-SRTP", "not Kin's household end-to-end claim", "Conformance checklist"])
    assert.ok(adr.includes(phrase), phrase);
  assert.doesNotMatch(adr, /will (support|ship|add) (voice|video|calls)/i);
});
