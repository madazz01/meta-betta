import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvalCard, choiceHint, currentStage, safestChoiceId } from "../lib/approvals.js";

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

  it("shows the current step for a multi-stage command", () => {
    const full = "New-Item -ItemType Directory mb-probe-dir; Remove-Item mb-probe-dir; Write-Output sandbox-ok";
    const card = approvalCard(
      {
        kind: "shell",
        command: full,
        stages: [
          { argv: ["New-Item", "-ItemType", "Directory", "mb-probe-dir"], position: 1, totalStages: 3 },
          { argv: ["Remove-Item", "mb-probe-dir"], position: 2, totalStages: 3 },
          { argv: ["Write-Output", "sandbox-ok"], position: 3, totalStages: 3 },
        ],
      },
      "bash",
      "",
      1,
    );
    assert.equal(card.title, "Muse wants to run a command");
    assert.equal(card.stageLine, "(step 2 of 3) Remove-Item mb-probe-dir");
    assert.equal(card.detail, full);
  });

  it("skips the step line for a single stage", () => {
    const card = approvalCard(
      {
        kind: "shell",
        command: "node --version",
        stages: [{ argv: ["node", "--version"], position: 1, totalStages: 1 }],
      },
      "bash",
      "",
      0,
    );
    assert.deepEqual(card, { title: "Muse wants to run a command", detail: "node --version" });
  });
});

describe("currentStage", () => {
  const stages = [
    { argv: ["a"], position: 1, totalStages: 2 },
    { argv: ["b"], position: 2, totalStages: 2 },
  ];

  it("picks the stage by source index, else the first", () => {
    assert.equal(currentStage(stages, 1)?.argv, stages[1]?.argv);
    assert.equal(currentStage(stages, 9)?.argv, stages[0]?.argv);
  });

  it("is undefined without stages", () => {
    assert.equal(currentStage(undefined, 0), undefined);
    assert.equal(currentStage([], 0), undefined);
  });
});

describe("choiceHint", () => {
  it("hints the always-allow choice only", () => {
    assert.equal(
      choiceHint({ scope: "localPersistent", decision: "approvedPolicyAmendment" }),
      "Muse won't ask again for commands starting with this, in this project only.",
    );
    assert.equal(choiceHint({ scope: "once", decision: "approved" }), undefined);
    assert.equal(choiceHint({ scope: "once", decision: "abort" }), undefined);
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
