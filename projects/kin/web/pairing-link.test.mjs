// Invitation links (#97): the code lives in the fragment, is read once and
// is cleared from the address bar at once.
import assert from "node:assert/strict";
import test from "node:test";
import {
  captureInvitationCode, cleanCode, consumeInvitationCode, invitationCode, invitationLink, takeInvitationCode,
} from "./pairing-link.js";

const address = (href) => {
  const url = new URL(href);
  return { pathname: url.pathname, search: url.search, hash: url.hash };
};
const recorder = () => {
  const calls = [];
  return { calls, replaceState: (...args) => calls.push(args[2]) };
};

test("an invitation link carries the code only in the fragment", () => {
  const link = invitationLink("https://kin.test", "F7KM-Q2DX");
  assert.equal(link, "https://kin.test/pair#code=F7KM-Q2DX");
  const url = new URL(link);
  assert.equal(url.search, "", "nothing a browser would send to the server");
  assert.equal(`${url.origin}${url.pathname}`, "https://kin.test/pair", "what reaches the server, and a Referer");
});

test("the code is read from a scanned invitation link, and only from one", () => {
  assert.equal(invitationCode("https://kin.test/pair#code=F7KM-Q2DX"), "F7KM-Q2DX");
  assert.equal(invitationCode("https://kin.test/pair#code=%20f7km-q2dx%20"), "f7km-q2dx", "trimmed; case is the service's business");
  assert.equal(invitationCode("https://kin.test/link#r=1&s=2"), "", "a sign-in link is not an invitation");
  assert.equal(invitationCode("https://kin.test/pair"), "");
  assert.equal(invitationCode("not a url"), "");
  assert.equal(cleanCode("ABCD-EFGH-IJKL"), "ABCD-EFGH", "cut to the field's nine characters");
});

test("opening an invitation link takes the code and clears the address bar", () => {
  const past = recorder();
  assert.equal(takeInvitationCode(address("https://kin.test/pair#code=F7KM-Q2DX"), past), "F7KM-Q2DX");
  assert.deepEqual(past.calls, ["/pair"], "the fragment is replaced at once");
});

test("links shared before #97 (code in the query) are read and cleared too", () => {
  const past = recorder();
  assert.equal(takeInvitationCode(address("https://kin.test/pair?code=F7KM-Q2DX"), past), "F7KM-Q2DX");
  assert.deepEqual(past.calls, ["/pair"]);
});

test("addresses without a code are left alone", () => {
  for (const href of ["https://kin.test/pair", "https://kin.test/pair#household/people", "https://kin.test/#code=F7KM-Q2DX", "https://kin.test/link#code=X"]) {
    const past = recorder();
    assert.equal(takeInvitationCode(address(href), past), "", href);
    assert.deepEqual(past.calls, [], `${href} keeps its address`);
  }
});

test("a captured code is handed to the join screen once", () => {
  const past = recorder();
  assert.equal(captureInvitationCode(address("https://kin.test/pair#code=F7KM-Q2DX"), past), "F7KM-Q2DX");
  assert.equal(consumeInvitationCode(), "F7KM-Q2DX");
  assert.equal(consumeInvitationCode(), "", "not twice");
  captureInvitationCode(address("https://kin.test/today"), past);
  assert.equal(consumeInvitationCode(), "", "nothing captured elsewhere");
});
