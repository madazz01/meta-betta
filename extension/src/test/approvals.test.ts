import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvalCard, safestChoiceId } from "../lib/approvals.js";

describe("approvalCard", () => {
  it("names shell commands", () => {
    assert.deepEqual(
      approvalCard({ kind: "shell", command: "npm test" }, "bash", ""),
      { title: "Muse wants to run a command", detail: "npm test" },
    );
  });

  it("words file reads and writes plainly", () => {
    assert.deepEqual(
      approvalCard({ kind: "fileAccess", access: "write", path: "src/app.js" }, "edit", ""),
      { title: "Muse wants to change a file", detail: "src/app.js" },
    );
    assert.deepEqual(
      approvalCard({ kind: "fileAccess", access: "read", path: "src/app.js" }, "read", ""),
      { title: "Muse wants to read a file", detail: "src/app.js" },
    );
  });

  it("names network targets", () => {
    assert.deepEqual(
      approvalCard({ kind: "network", protocol: "https", host: "example.com", port: 443 }, "fetch", ""),
      { title: "Muse wants to reach the network", detail: "https://example.com:443" },
    );
  });

  it("stays generic for unknown kinds", () => {
    const card = approvalCard({ kind: "teleport" }, "teleport", '{"where":"mars"}');
    assert.equal(card.title, "Muse wants to use teleport");
    assert.equal(card.detail, '{"where":"mars"}');
  });

  it("bounds long details", () => {
    const card = approvalCard({ kind: "shell", command: "x".repeat(500) }, "bash", "");
    assert.equal(card.detail?.length, 300);
  });
});

describe("safestChoiceId", () => {
  it("prefers a denial", () => {
    assert.equal(
      safestChoiceId([
        { choiceId: "a", decision: "approved", label: "Allow once" },
        { choiceId: "d", decision: "denied", label: "Don't allow" },
      ]),
      "d",
    );
  });

  it("falls back to abort, then the first choice", () => {
    assert.equal(
      safestChoiceId([
        { choiceId: "a", decision: "approved", label: "Allow" },
        { choiceId: "x", decision: "abort", label: "Stop" },
      ]),
      "x",
    );
    assert.equal(safestChoiceId([{ choiceId: "a", decision: "approved", label: "Allow" }]), "a");
    assert.equal(safestChoiceId([]), undefined);
  });
});
