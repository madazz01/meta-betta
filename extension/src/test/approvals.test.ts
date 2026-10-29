import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowedOnceRow,
  alwaysAllowedRow,
  approvalCard,
  backedUpRow,
  backupAction,
  choiceHint,
  commandName,
  currentStage,
  describeStage,
  findStageChoice,
  isReadOnlyStage,
  isRejectChoice,
  lookedAtRow,
  pickerTitle,
  rejectedRow,
  rememberedDecision,
  safestChoiceId,
  stageLabel,
} from "../lib/approvals.js";

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

describe("commandName", () => {
  it("strips paths and extensions", () => {
    assert.equal(commandName("Get-ChildItem"), "get-childitem");
    assert.equal(commandName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
    assert.equal(commandName("/usr/bin/git"), "git");
    assert.equal(commandName("node.EXE"), "node");
  });
});

describe("isReadOnlyStage", () => {
  it("allows the read-only list, case-insensitively", () => {
    assert.equal(isReadOnlyStage(["Get-Date"]), true);
    assert.equal(isReadOnlyStage(["get-childitem", "-Path", "."]), true);
    assert.equal(isReadOnlyStage(["C:\\Windows\\System32\\more.com", "f.txt"]), false);
    assert.equal(isReadOnlyStage(["ls", "-la"]), true);
    assert.equal(isReadOnlyStage(["Select-Object", "Name"]), true);
    assert.equal(isReadOnlyStage(["echo", "hello"]), true);
  });

  it("matches git, node and npm only as pairs", () => {
    assert.equal(isReadOnlyStage(["git", "status"]), true);
    assert.equal(isReadOnlyStage(["git", "log", "--oneline"]), true);
    assert.equal(isReadOnlyStage(["git", "diff", "HEAD"]), true);
    assert.equal(isReadOnlyStage(["node", "--version"]), true);
    assert.equal(isReadOnlyStage(["npm", "--version"]), true);
    assert.equal(isReadOnlyStage(["git", "push"]), false);
    assert.equal(isReadOnlyStage(["git"]), false);
    assert.equal(isReadOnlyStage(["npm", "test"]), false);
    assert.equal(isReadOnlyStage(["node", "script.js"]), false);
  });

  it("refuses anything with output redirection", () => {
    assert.equal(isReadOnlyStage(["echo", "hi", ">", "f.txt"]), false);
    assert.equal(isReadOnlyStage(["Get-ChildItem", ">>", "f.txt"]), false);
    assert.equal(isReadOnlyStage(["Get-Date", "|", "Out-File", "f.txt"]), false);
    assert.equal(isReadOnlyStage(["dir", "|", "Tee-Object", "f.txt"]), false);
    assert.equal(isReadOnlyStage(["type", "f.txt", "|", "Set-Content", "g.txt"]), false);
  });

  it("refuses writers and empties", () => {
    assert.equal(isReadOnlyStage(["Remove-Item", "f.txt"]), false);
    assert.equal(isReadOnlyStage([]), false);
  });
});

describe("backupAction", () => {
  const root = "C:\\mb-test";

  it("allows the mkdir inside .backups", () => {
    assert.deepEqual(
      backupAction(["New-Item", "-ItemType", "Directory", ".backups/today"], root),
      { kind: "mkdir" },
    );
    assert.deepEqual(
      backupAction(["New-Item", ".backups\\today", "-ItemType", "Directory", "-Force"], root),
      { kind: "mkdir" },
    );
  });

  it("allows a copy into .backups with the file names", () => {
    assert.deepEqual(backupAction(["Copy-Item", "todo.txt", ".backups/today/todo.txt"], root), {
      kind: "copy",
      files: ["todo.txt"],
    });
    assert.deepEqual(
      backupAction(["Copy-Item", "-Path", "a.txt", "-Destination", ".backups/a.txt"], root),
      { kind: "copy", files: ["a.txt"] },
    );
  });

  it("refuses paths outside .backups", () => {
    assert.equal(backupAction(["New-Item", "-ItemType", "Directory", "notes"], root), undefined);
    assert.equal(
      backupAction(["Copy-Item", "todo.txt", "elsewhere/todo.txt"], root),
      undefined,
    );
  });

  it("refuses .. tricks and other drives", () => {
    assert.equal(
      backupAction(["New-Item", "-ItemType", "Directory", ".backups/../notes"], root),
      undefined,
    );
    assert.equal(
      backupAction(["Copy-Item", "todo.txt", ".backups/../../evil.txt"], root),
      undefined,
    );
    assert.equal(
      backupAction(["Copy-Item", "todo.txt", "D:\\other\\todo.txt"], root),
      undefined,
    );
    assert.equal(
      backupAction(["Copy-Item", "D:\\other\\todo.txt", ".backups/todo.txt"], root),
      undefined,
    );
  });

  it("refuses file writes posing as the mkdir", () => {
    assert.equal(backupAction(["New-Item", "notes.txt"], root), undefined);
    assert.equal(backupAction(["New-Item", "-ItemType", "File", ".backups/x.txt"], root), undefined);
  });

  it("ignores other commands", () => {
    assert.equal(backupAction(["Remove-Item", ".backups/x"], root), undefined);
    assert.equal(backupAction([], root), undefined);
  });
});

describe("describeStage", () => {
  it("words the common verbs plainly", () => {
    assert.equal(describeStage(["Remove-Item", "todo.txt"]), "delete todo.txt");
    assert.equal(describeStage(["rm", "-rf", "dist"]), "delete dist");
    assert.equal(describeStage(["Move-Item", "a.txt", "b.txt"]), "move a.txt");
    assert.equal(describeStage(["Rename-Item", "a.txt", "b.txt"]), "rename a.txt");
    assert.equal(describeStage(["Copy-Item", "a.txt", "b.txt"]), "copy a.txt");
    assert.equal(describeStage(["New-Item", "notes.txt"]), "create notes.txt");
    assert.equal(describeStage(["npm", "install", "lodash"]), "install lodash");
    assert.equal(describeStage(["npm", "install"]), "install packages");
  });

  it("names redirect targets as writes", () => {
    assert.equal(describeStage(["echo", "hello", ">", "f.txt"]), "write f.txt");
  });

  it("falls back to running the command", () => {
    assert.equal(describeStage(["python", "script.py"]), "run python script.py");
    assert.equal(describeStage(["node", "script.js"]), "run node script.js");
    assert.equal(describeStage([]), "run something");
  });

  it("titles the picker as a question", () => {
    assert.equal(pickerTitle(["Remove-Item", "todo.txt"]), "Delete todo.txt?");
  });

  it("labels stages shortly", () => {
    assert.equal(stageLabel(["Get-ChildItem"]), "Get-ChildItem");
    assert.equal(stageLabel(["node", "--version"]), "node --version");
    assert.equal(stageLabel(["git", "status", "--short"]), "git status");
  });
});

describe("rememberedDecision", () => {
  it("maps choices to once, always and reject", () => {
    assert.equal(rememberedDecision({ scope: "once", decision: "approved" }), "once");
    assert.equal(rememberedDecision({ scope: "session", decision: "approvedForSession" }), "once");
    assert.equal(rememberedDecision({ scope: "localPersistent", decision: "approvedPolicyAmendment" }), "always");
    assert.equal(rememberedDecision({ decision: "approvedPolicyAmendment" }), "always");
    assert.equal(rememberedDecision({ scope: "once", decision: "abort" }), "reject");
    assert.equal(rememberedDecision({ scope: "once", decision: "denied" }), "reject");
    assert.equal(rememberedDecision({ scope: "once", decision: "timedOut" }), undefined);
  });
});

describe("findStageChoice", () => {
  const choices = [
    { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
    {
      choiceId: "allow_local_prefix",
      decision: "approvedPolicyAmendment",
      label: "Always allow",
      scope: "localPersistent",
    },
    { choiceId: "abort", decision: "abort", label: "Reject", scope: "once", acceptsFeedback: true },
  ];

  it("finds each stage's equivalent, with an always fallback to once", () => {
    assert.equal(findStageChoice(choices, "once"), "allow_once");
    assert.equal(findStageChoice(choices, "always"), "allow_local_prefix");
    assert.equal(findStageChoice(choices, "reject"), "abort");
    assert.equal(
      findStageChoice(choices.filter((choice) => choice.scope !== "localPersistent"), "always"),
      "allow_once",
    );
    assert.equal(findStageChoice([], "once"), undefined);
  });
});

describe("isRejectChoice", () => {
  it("spots the tell-Muse row", () => {
    assert.equal(isRejectChoice({ acceptsFeedback: true, decision: "abort" }), true);
    assert.equal(isRejectChoice({ acceptsFeedback: true, decision: "denied" }), true);
    assert.equal(isRejectChoice({ decision: "abort" }), false);
    assert.equal(isRejectChoice({ acceptsFeedback: true, decision: "approved" }), false);
  });
});

describe("answered rows", () => {
  it("words each outcome in one line", () => {
    assert.equal(allowedOnceRow("delete todo.txt"), "✓ Allowed once: delete todo.txt");
    assert.equal(alwaysAllowedRow("Remove-Item"), "✓ Always allowed here: Remove-Item");
    assert.equal(rejectedRow("delete todo.txt"), "✗ Rejected: delete todo.txt");
    assert.equal(
      rejectedRow("delete todo.txt", "use the bin instead"),
      "✗ Rejected: delete todo.txt, told Muse: use the bin instead",
    );
    assert.equal(rejectedRow("delete todo.txt", "   "), "✗ Rejected: delete todo.txt");
    assert.equal(lookedAtRow(["Get-ChildItem", "Select-Object"]), "✓ Looked at: Get-ChildItem, Select-Object");
    assert.equal(backedUpRow(["todo.txt"]), "✓ Backed up todo.txt");
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
