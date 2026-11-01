import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowedOnceRow,
  alwaysAllowedRow,
  approvalCard,
  autoAllowedRow,
  autoAllowFile,
  autoAllowStage,
  backedUpRow,
  backupAction,
  choiceHint,
  commandHasWrite,
  commandName,
  currentStage,
  describeFileAccess,
  describeStage,
  findStageChoice,
  isFreeRead,
  isReadOnlyStage,
  isRejectChoice,
  isSinkStage,
  lookedAtRow,
  pickerTitle,
  rejectedRow,
  rememberedDecision,
  safestChoiceId,
  stageGroup,
  stageLabel,
  stripThrowawayArgv,
  stripThrowawayCommand,
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

describe("commandHasWrite", () => {
  it("spots redirection and output words, conservatively", () => {
    assert.equal(commandHasWrite("Write-Output hello > x.txt"), true);
    assert.equal(commandHasWrite('Write-Output "a > b"'), true);
    assert.equal(commandHasWrite("Get-Date | Out-File f.txt"), true);
    assert.equal(commandHasWrite("dir | tee-object f.txt"), true);
    assert.equal(commandHasWrite("tool --output f.txt"), true);
    assert.equal(commandHasWrite("type f.txt | Set-Content g.txt"), true);
    assert.equal(commandHasWrite("Get-ChildItem | Add-Content f.txt"), true);
  });

  it("passes clean commands", () => {
    assert.equal(commandHasWrite("Get-ChildItem"), false);
    assert.equal(commandHasWrite("node --version"), false);
    assert.equal(commandHasWrite(undefined), false);
    assert.equal(commandHasWrite(""), false);
  });

  it("ignores redirects thrown away, but no other >", () => {
    assert.equal(commandHasWrite("Get-ChildItem brain 2>$null"), false);
    assert.equal(commandHasWrite("Get-ChildItem brain >$null"), false);
    assert.equal(commandHasWrite("Get-ChildItem brain *>$null"), false);
    assert.equal(commandHasWrite("node build.js 2>&1"), false);
    assert.equal(commandHasWrite("Get-ChildItem brain | Out-Null"), false);
    assert.equal(commandHasWrite("ls 2>/dev/null"), false);
    assert.equal(commandHasWrite("Get-Content x > out.txt"), true);
    assert.equal(commandHasWrite("Get-ChildItem 2>$null > out.txt"), true);
  });

  it("keeps writes to $null.txt-style files, not throwaways", () => {
    assert.equal(commandHasWrite("Write-Output hi >$null.txt"), true);
    assert.equal(commandHasWrite("Get-ChildItem 2>$null.log"), true);
    assert.equal(commandHasWrite("ls 2>/dev/null.txt"), true);
    assert.equal(stripThrowawayCommand("Write-Output hi >$null; Write-Output done").includes(">"), false);
    assert.equal(stripThrowawayCommand("x *>$null)").includes(">"), false);
    assert.equal(stripThrowawayCommand("node build.js 2>&1 | Out-Null").includes(">"), false);
    assert.equal(stripThrowawayCommand("Get-ChildItem brain | Out-Null").includes("|"), false);
  });
});

describe("stripThrowaway", () => {
  it("drops throwaway redirects from argv, spaced or not, any case", () => {
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "brain", "2>$null"]), ["Get-ChildItem", "brain"]);
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "brain", "2>", "$null"]), ["Get-ChildItem", "brain"]);
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "brain", ">", "$NULL"]), ["Get-ChildItem", "brain"]);
    assert.deepEqual(stripThrowawayArgv(["node", "build.js", "2>&1"]), ["node", "build.js"]);
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "|", "Out-Null"]), ["Get-ChildItem"]);
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "|", "out-null"]), ["Get-ChildItem"]);
    assert.deepEqual(stripThrowawayArgv(["ls", "2>/dev/null"]), ["ls"]);
  });

  it("leaves real redirects and lone $null alone", () => {
    assert.deepEqual(stripThrowawayArgv(["Get-Content", "x", ">", "out.txt"]), ["Get-Content", "x", ">", "out.txt"]);
    assert.deepEqual(stripThrowawayArgv(["echo", "$null"]), ["echo", "$null"]);
    assert.deepEqual(stripThrowawayArgv(["echo", "2>$nullx"]), ["echo", "2>$nullx"]);
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "|", "Out-File", "f.txt"]), [
      "Get-ChildItem",
      "|",
      "Out-File",
      "f.txt",
    ]);
    assert.equal(stripThrowawayCommand("Get-Content $HOME\\x 2>$null").includes("$HOME"), true);
  });

  it("leaves $null.txt-style tails alone on both sides", () => {
    assert.deepEqual(stripThrowawayArgv(["echo", "2>$null.txt"]), ["echo", "2>$null.txt"]);
    assert.deepEqual(stripThrowawayArgv(["echo", "2>", "$null.log"]), ["echo", "2>", "$null.log"]);
    assert.deepEqual(stripThrowawayArgv(["echo", "2>/dev/null.txt"]), ["echo", "2>/dev/null.txt"]);
    assert.deepEqual(stripThrowawayArgv(["Get-ChildItem", "|", "Out-Null.ps1"]), [
      "Get-ChildItem",
      "|",
      "Out-Null.ps1",
    ]);
    assert.equal(isSinkStage(["Out-Null.ps1"]), false);
  });

  it("spots bare Out-Null sink stages", () => {
    assert.equal(isSinkStage(["Out-Null"]), true);
    assert.equal(isSinkStage(["out-null"]), true);
    assert.equal(isSinkStage(["Out-Null", "x"]), false);
    assert.equal(isSinkStage(["Get-ChildItem"]), false);
    assert.equal(isSinkStage([]), false);
  });
});

describe("isReadOnlyStage", () => {
  const root = "C:\\mb-test";

  it("allows the read-only list, case-insensitively", () => {
    assert.equal(isReadOnlyStage(["Get-Date"], root), true);
    assert.equal(isReadOnlyStage(["get-childitem", "-Path", "."], root), true);
    assert.equal(isReadOnlyStage(["C:\\Windows\\System32\\more.com", "f.txt"], root), false);
    assert.equal(isReadOnlyStage(["ls", "-la"], root), true);
    assert.equal(isReadOnlyStage(["Select-Object", "Name"], root), true);
    assert.equal(isReadOnlyStage(["echo", "hello"], root), true);
  });

  it("matches git, node and npm only as pairs", () => {
    assert.equal(isReadOnlyStage(["git", "status"], root), true);
    assert.equal(isReadOnlyStage(["git", "log", "--oneline"], root), true);
    assert.equal(isReadOnlyStage(["git", "diff", "HEAD"], root), true);
    assert.equal(isReadOnlyStage(["node", "--version"], root), true);
    assert.equal(isReadOnlyStage(["npm", "--version"], root), true);
    assert.equal(isReadOnlyStage(["git", "push"], root), false);
    assert.equal(isReadOnlyStage(["git"], root), false);
    assert.equal(isReadOnlyStage(["npm", "test"], root), false);
    assert.equal(isReadOnlyStage(["node", "script.js"], root), false);
  });

  it("refuses anything with output redirection", () => {
    assert.equal(isReadOnlyStage(["echo", "hi", ">", "f.txt"], root), false);
    assert.equal(isReadOnlyStage(["Get-ChildItem", ">>", "f.txt"], root), false);
    assert.equal(isReadOnlyStage(["Get-Date", "|", "Out-File", "f.txt"], root), false);
    assert.equal(isReadOnlyStage(["dir", "|", "Tee-Object", "f.txt"], root), false);
    assert.equal(isReadOnlyStage(["type", "f.txt", "|", "Set-Content", "g.txt"], root), false);
  });

  it("refuses writers and empties", () => {
    assert.equal(isReadOnlyStage(["Remove-Item", "f.txt"], root), false);
    assert.equal(isReadOnlyStage([], root), false);
  });

  it("refuses variables, home shortcuts, escapes and wildcards", () => {
    assert.equal(isReadOnlyStage(["Get-Content", "$HOME", "\\.gitconfig"], root), false);
    assert.equal(isReadOnlyStage(["Get-Content", "$HOME\\.gitconfig"], root), false);
    assert.equal(isReadOnlyStage(["cat", "%USERPROFILE%\\.gitconfig"], root), false);
    assert.equal(isReadOnlyStage(["type", "~/notes.txt"], root), false);
    assert.equal(isReadOnlyStage(["cat", "`notes.txt"], root), false);
    assert.equal(isReadOnlyStage(["ls", "*.txt"], root), false);
    assert.equal(isReadOnlyStage(["dir", "file?.txt"], root), false);
    assert.equal(isReadOnlyStage(["cat", "[abc].txt"], root), false);
    assert.equal(isReadOnlyStage(["Get-Date", "$x"], root), false);
  });

  it("keeps file readers inside the workspace", () => {
    assert.equal(isReadOnlyStage(["Get-Content", "notes.txt"], root), true);
    assert.equal(isReadOnlyStage(["cat", "sub\\dir\\notes.txt"], root), true);
    assert.equal(isReadOnlyStage(["Get-Content"], root), true);
    assert.equal(isReadOnlyStage(["Get-Content", "C:\\Users\\x\\.ssh\\id_rsa"], root), false);
    assert.equal(isReadOnlyStage(["cat", "..\\..\\secret"], root), false);
    assert.equal(isReadOnlyStage(["cat", "/etc/passwd"], root), false);
    assert.equal(isReadOnlyStage(["Test-Path", "D:\\other\\x"], root), false);
  });

  it("ignores throwaway redirects, but no other write or $", () => {
    assert.equal(isReadOnlyStage(["Get-ChildItem", "brain", "2>$null"], root), true);
    assert.equal(isReadOnlyStage(["Get-Content", "x", ">", "out.txt"], root), false);
    assert.equal(isReadOnlyStage(["Get-Content", "$HOME\\x", "2>$null"], root), false);
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
    assert.deepEqual(backupAction(["mkdir", ".backups/today"], root), { kind: "mkdir" });
    assert.equal(backupAction(["mkdir", "notes"], root), undefined);
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

  it("refuses dynamic tokens", () => {
    assert.equal(backupAction(["New-Item", "-ItemType", "Directory", "$HOME/.backups"], root), undefined);
    assert.equal(backupAction(["Copy-Item", "*.txt", ".backups/today"], root), undefined);
    assert.equal(backupAction(["Copy-Item", "todo.txt", ".backups/$TODAY"], root), undefined);
    assert.equal(backupAction(["mkdir", "~/.backups"], root), undefined);
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

describe("autoAllowStage", () => {
  const root = "C:\\ws";

  it("allows builds, tests, scripts and git inside the workspace", () => {
    assert.equal(autoAllowStage(["npm", "test"], root), true);
    assert.equal(autoAllowStage(["npm", "run", "build"], root), true);
    assert.equal(autoAllowStage(["npm", "start"], root), true);
    assert.equal(autoAllowStage(["npm", "build"], root), true);
    assert.equal(autoAllowStage(["node", "script.js"], root), true);
    assert.equal(autoAllowStage(["git", "status"], root), true);
    assert.equal(autoAllowStage(["git", "commit", "-m", "done"], root), true);
    assert.equal(autoAllowStage(["Remove-Item", "todo.txt"], root), true);
    assert.equal(autoAllowStage(["Copy-Item", "a.txt", "b.txt"], root), true);
    assert.equal(autoAllowStage(["mkdir", "notes"], root), true);
  });

  it("asks for installs, downloads, push and strangers", () => {
    assert.equal(autoAllowStage(["npm", "install", "x"], root), false);
    assert.equal(autoAllowStage(["npm", "i"], root), false);
    assert.equal(autoAllowStage(["npm", "add", "x"], root), false);
    assert.equal(autoAllowStage(["pip", "install", "x"], root), false);
    assert.equal(autoAllowStage(["winget", "install", "x"], root), false);
    assert.equal(autoAllowStage(["curl", "https://example.com"], root), false);
    assert.equal(autoAllowStage(["irm", "https://example.com/x.ps1"], root), false);
    assert.equal(autoAllowStage(["git", "push"], root), false);
    assert.equal(autoAllowStage(["cargo", "build"], root), false);
    assert.equal(autoAllowStage(["myscript"], root), false);
    assert.equal(autoAllowStage([], root), false);
  });

  it("asks when paths leave the workspace or tokens move", () => {
    assert.equal(autoAllowStage(["Remove-Item", "C:\\Windows\\x.txt"], root), false);
    assert.equal(autoAllowStage(["Remove-Item", "..\\..\\x.txt"], root), false);
    assert.equal(autoAllowStage(["node", "$file"], root), false);
    assert.equal(autoAllowStage(["git", "add", "*.js"], root), false);
    assert.equal(autoAllowStage(["node", "a.js"], ""), false);
  });

  it("asks for redirects it cannot verify inside", () => {
    assert.equal(autoAllowStage(["npm", "test", ">", "out.log"], root, "npm test > out.log"), true);
    assert.equal(autoAllowStage(["npm", "test", ">", "C:\\x\\out.log"], root, "npm test > C:\\x\\out.log"), false);
    assert.equal(autoAllowStage(["npm", "test"], root, "npm test > out.log"), false);
  });

  it("asks for the proven Auto holes", () => {
    assert.equal(autoAllowStage(["Remove-Item", "-Recurse", "-Force", "/Users/madaz"], root), false);
    assert.equal(autoAllowStage(["Remove-Item", "/"], root), false);
    assert.equal(autoAllowStage(["Remove-Item"], root), false);
    assert.equal(autoAllowStage(["Remove-Item", "-Recurse", "-Force"], root), false);
    assert.equal(autoAllowStage(["node", "-e", "console.log(1)"], root), false);
    assert.equal(autoAllowStage(["node", "--eval", "console.log(1)"], root), false);
    assert.equal(autoAllowStage(["npx", "some-package"], root), false);
    assert.equal(autoAllowStage(["npx", "jest", "--watch"], root), false);
    assert.equal(autoAllowStage(["git", "-c", "x=y", "push"], root), false);
    assert.equal(autoAllowStage(["git", "config", "--global", "user.name", "x"], root), false);
  });

  it("auto-allows the proven safe commands", () => {
    assert.equal(autoAllowStage(["npm", "test"], root), true);
    assert.equal(autoAllowStage(["node", "build.js"], root), true);
    assert.equal(autoAllowStage(["Remove-Item", "-Recurse", "notes.txt"], root), true);
    assert.equal(autoAllowStage(["git", "commit", "-m", "x"], root), true);
  });

  it("asks for node without an inside script, and npm outside its list", () => {
    assert.equal(autoAllowStage(["node"], root), false);
    assert.equal(autoAllowStage(["node", "--version"], root), false);
    assert.equal(autoAllowStage(["node", "-r", "ts-node/register", "build.js"], root), false);
    assert.equal(autoAllowStage(["node", "C:\\x\\build.js"], root), false);
    assert.equal(autoAllowStage(["npm"], root), false);
    assert.equal(autoAllowStage(["npm", "run"], root), false);
    assert.equal(autoAllowStage(["npm", "ci"], root), false);
    assert.equal(autoAllowStage(["npm", "exec", "x"], root), false);
  });

  it("asks for git escapes, and allows local git", () => {
    assert.equal(autoAllowStage(["git", "clone", "https://example.com/r.git"], root), false);
    assert.equal(autoAllowStage(["git", "remote", "add", "origin", "https://example.com/r.git"], root), false);
    assert.equal(autoAllowStage(["git", "remote", "set-url", "origin", "https://example.com/r.git"], root), false);
    assert.equal(autoAllowStage(["git", "submodule", "update"], root), false);
    assert.equal(autoAllowStage(["git", "config", "--system", "user.name", "x"], root), false);
    assert.equal(autoAllowStage(["git", "-c", "core.pager=cat", "status"], root), false);
    assert.equal(autoAllowStage(["git", "-C", "C:\\other", "status"], root), false);
    assert.equal(autoAllowStage(["git", "-C", "sub", "status"], root), true);
    assert.equal(autoAllowStage(["git", "config", "user.name", "x"], root), true);
    assert.equal(autoAllowStage(["git", "remote", "-v"], root), true);
  });

  it("asks for slash-switch tools, and deletes past the first stage", () => {
    assert.equal(autoAllowStage(["robocopy", "a", "b", "/MIR"], root), false);
    assert.equal(autoAllowStage(["xcopy", "a", "b"], root), false);
    assert.equal(autoAllowStage(["cmd", "/c", "dir"], root), false);
    assert.equal(autoAllowStage(["Copy-Item", "a.txt", "b.txt"], root, undefined, false), false);
    assert.equal(autoAllowStage(["Remove-Item", "notes.txt"], root, undefined, false), false);
    assert.equal(autoAllowStage(["Remove-Item", "notes.txt"], root, undefined, true), true);
    assert.equal(autoAllowStage(["npm", "test"], root, undefined, false), true);
  });

  it("ignores throwaway redirects, but no other write or $", () => {
    assert.equal(autoAllowStage(["npm", "test", "2>$null"], root, "npm test 2>$null"), true);
    assert.equal(autoAllowStage(["node", "build.js", "2>&1"], root), true);
    assert.equal(autoAllowStage(["Out-Null"], root), true);
    assert.equal(autoAllowStage(["npm", "test", ">", "out.log"], root, "npm test > out.log"), true);
    assert.equal(autoAllowStage(["Get-Content", "x", ">", "out.txt"], root), false);
    assert.equal(autoAllowStage(["Get-Content", "$HOME\\x", "2>$null"], root), false);
    assert.equal(autoAllowStage(["node", "$file", "2>$null"], root), false);
    assert.equal(
      autoAllowStage(["Write-Output", "hi", ">$null.txt"], root, "Write-Output hi >$null.txt"),
      false,
    );
  });
});

describe("autoAllowFile", () => {
  it("allows inside paths, asks outside", () => {
    assert.equal(autoAllowFile("src/app.js", "C:\\ws"), true);
    assert.equal(autoAllowFile("C:\\ws\\src\\app.js", "C:\\ws"), true);
    assert.equal(autoAllowFile("C:\\Windows\\x.txt", "C:\\ws"), false);
    assert.equal(autoAllowFile("..\\x.txt", "C:\\ws"), false);
    assert.equal(autoAllowFile("$env:x", "C:\\ws"), false);
    assert.equal(autoAllowFile("a.txt", ""), false);
  });
});

describe("isFreeRead", () => {
  it("frees inside file reads, nothing else", () => {
    assert.equal(isFreeRead({ kind: "fileAccess", access: "read", path: "brain/me.md" }, "C:\\ws"), true);
    assert.equal(isFreeRead({ kind: "fileAccess", access: "read", path: "C:\\ws\\a.txt" }, "C:\\ws"), true);
    assert.equal(isFreeRead({ kind: "fileAccess", access: "read", path: "..\\x.txt" }, "C:\\ws"), false);
    assert.equal(
      isFreeRead({ kind: "fileAccess", access: "read", path: "C:\\Windows\\x.txt" }, "C:\\ws"),
      false,
    );
    assert.equal(isFreeRead({ kind: "fileAccess", access: "write", path: "a.txt" }, "C:\\ws"), false);
    assert.equal(isFreeRead({ kind: "fileAccess", access: "read", path: "$HOME\\x" }, "C:\\ws"), false);
    assert.equal(isFreeRead({ kind: "fileAccess", access: "read" }, "C:\\ws"), false);
    assert.equal(isFreeRead({ kind: "network" }, "C:\\ws"), false);
    assert.equal(isFreeRead({ kind: "process" }, "C:\\ws"), false);
    assert.equal(isFreeRead({ kind: "tool" }, "C:\\ws"), false);
    assert.equal(isFreeRead({ kind: "fileAccess", access: "read", path: "a.txt" }, ""), false);
  });
});

describe("autoAllowedRow", () => {
  it("words the answered row", () => {
    assert.equal(autoAllowedRow("run npm test"), "✓ auto-allowed: run npm test");
    assert.equal(describeFileAccess("read", "src/app.js"), "read app.js");
    assert.equal(describeFileAccess("write", "src/app.js"), "change app.js");
  });
});

describe("stageGroup", () => {
  it("buckets approved stages for the step group", () => {
    assert.equal(stageGroup(["npm", "test"]), "command");
    assert.equal(stageGroup(["git", "status"]), "command");
    assert.equal(stageGroup(["Remove-Item", "x.txt"]), "edit");
    assert.equal(stageGroup(["curl", "https://example.com"]), "command");
    assert.equal(stageGroup(["mystery"]), "other");
  });
});
