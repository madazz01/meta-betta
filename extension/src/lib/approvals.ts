// Pure approval helpers: plain-English picker titles, read-only and backup
// auto-allow, per-command choice memory, and the answered rows. No VS Code
// imports.

import { win32 } from "node:path";

export interface ApprovalChoiceView {
  choiceId: string;
  decision: string;
  label: string;
  scope?: string;
  acceptsFeedback?: boolean;
}

export interface ApprovalStageView {
  argv: string[];
  position: number;
  totalStages: number;
}

export interface ApprovalSubjectView {
  kind: string;
  command?: string;
  access?: string;
  host?: string;
  port?: number;
  protocol?: string;
  path?: string;
  target?: string;
  toolName?: string;
  stages?: ApprovalStageView[];
}

export interface ApprovalCard {
  title: string;
  detail?: string;
  /** "(step 2 of 3) …" for a multi-stage shell command; the full command stays in detail. */
  stageLine?: string;
}

/**
 * The stage awaiting a decision: position equals sourceIndex + 1, else the
 * first stage, else undefined when the server sent no stages.
 */
export function currentStage(
  stages: ApprovalStageView[] | undefined,
  sourceIndex: number,
): ApprovalStageView | undefined {
  if (!stages || stages.length === 0) {
    return undefined;
  }
  return stages.find((stage) => stage.position === sourceIndex + 1) ?? stages[0];
}

/** Plain-English card for an approval request. Unknown kinds stay generic. */
export function approvalCard(
  subject: ApprovalSubjectView,
  toolName: string,
  rawArgs: string,
  sourceIndex = 0,
): ApprovalCard {
  switch (subject.kind) {
    case "shell": {
      const stage = currentStage(subject.stages, sourceIndex);
      const full = truncate(subject.command ?? "", 300) || undefined;
      if (stage && stage.totalStages > 1) {
        return {
          title: "Muse wants to run a command",
          detail: full,
          stageLine: `(step ${stage.position} of ${stage.totalStages}) ${truncate(stage.argv.join(" "), 200)}`,
        };
      }
      return { title: "Muse wants to run a command", detail: full };
    }
    case "fileAccess": {
      const verb = subject.access === "write" ? "change" : subject.access === "read" ? "read" : "open";
      return { title: `Muse wants to ${verb} a file`, detail: subject.path };
    }
    case "network": {
      const where = subject.host
        ? `${subject.protocol ?? "https"}://${subject.host}${subject.port ? `:${subject.port}` : ""}`
        : undefined;
      return { title: "Muse wants to reach the network", detail: where };
    }
    case "process":
      return { title: "Muse wants to control a process", detail: subject.target };
    default: {
      const who = subject.toolName ?? toolName;
      return {
        title: who ? `Muse wants to use ${who}` : "Muse wants your permission",
        detail: truncate(rawArgs, 200) || undefined,
      };
    }
  }
}

/**
 * A hover hint for the "always allow in this workspace" choice (a saved
 * rule, not a one-off). Matched by scope/decision, never by label or id.
 */
export function choiceHint(choice: { scope: string; decision: string }): string | undefined {
  if (choice.scope === "localPersistent" || choice.decision === "approvedPolicyAmendment") {
    return "Muse won't ask again for commands starting with this, in this project only.";
  }
  return undefined;
}

/**
 * The safest offered choice: a denial first, then abort, else the first
 * choice. Used when the panel is closed and the user can't click.
 */
export function safestChoiceId(choices: ApprovalChoiceView[]): string | undefined {
  return (
    choices.find((choice) => choice.decision === "denied")?.choiceId ??
    choices.find((choice) => choice.decision.startsWith("denied"))?.choiceId ??
    choices.find((choice) => choice.decision === "abort")?.choiceId ??
    choices[0]?.choiceId
  );
}

/** A command word without path or extension, lowercased: "C:\…\git.exe" → "git". */
export function commandName(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
}

const READONLY_SINGLE = new Set([
  "get-date",
  "get-childitem",
  "ls",
  "dir",
  "get-content",
  "cat",
  "type",
  "test-path",
  "get-item",
  "get-location",
  "pwd",
  "select-object",
  "where-object",
  "sort-object",
  "measure-object",
  "format-table",
  "format-list",
  "select-string",
  "write-output",
  "echo",
]);

/** Read-only only with these second words: git status, node --version, … */
const READONLY_PAIRS: Record<string, string[]> = {
  git: ["status", "log", "diff"],
  node: ["--version"],
  npm: ["--version"],
};

const REDIRECT_TOKENS = new Set([">", ">>", "out-file", "set-content", "add-content", "tee-object"]);

/**
 * True when the stage only reads: a read-only command with no output
 * redirection. Pipes and `;` are safe by construction: every stage of a
 * pipeline or list is approved separately, so a sneaky `Get-Content f |
 * Evil` still asks for its Evil stage.
 */
export function isReadOnlyStage(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  for (const token of argv) {
    if (REDIRECT_TOKENS.has(token.toLowerCase())) {
      return false;
    }
  }
  const name = commandName(argv[0] ?? "");
  const pair = READONLY_PAIRS[name];
  if (pair) {
    return pair.includes((argv[1] ?? "").toLowerCase());
  }
  return READONLY_SINGLE.has(name);
}

export type BackupAction = { kind: "mkdir" } | { kind: "copy"; files: string[] };

/**
 * A rule-9 backup step, or undefined (the picker asks). New-Item needs
 * -ItemType Directory with every path inside <workspace>\.backups; Copy-Item
 * needs its destination inside .backups and every path inside the workspace.
 * Conservative: anything unrecognized refuses and the picker asks.
 */
export function backupAction(argv: string[], workspaceRoot: string): BackupAction | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  const name = commandName(argv[0] ?? "");
  if (name === "new-item") {
    return backupMkdir(argv, workspaceRoot);
  }
  if (name === "copy-item") {
    return backupCopy(argv, workspaceRoot);
  }
  return undefined;
}

/** Non-flag tokens after the command word, minus excused parameter values. */
function pathArgs(argv: string[], excused: (token: string) => boolean): string[] {
  return argv.slice(1).filter((token) => {
    if (token.startsWith("-") || token.startsWith("/")) {
      return false;
    }
    return !excused(token);
  });
}

function backupMkdir(argv: string[], workspaceRoot: string): BackupAction | undefined {
  let directory = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = (argv[index] ?? "").toLowerCase();
    if ((flag === "-itemtype" || flag === "-type") && (argv[index + 1] ?? "").toLowerCase() === "directory") {
      directory = true;
    }
  }
  if (!directory) {
    return undefined;
  }
  const backups = win32.join(workspaceRoot, ".backups");
  const paths = pathArgs(argv, (token) => token.toLowerCase() === "directory");
  if (paths.length === 0 || !paths.every((candidate) => insideDir(workspaceRoot, backups, candidate))) {
    return undefined;
  }
  return { kind: "mkdir" };
}

function backupCopy(argv: string[], workspaceRoot: string): BackupAction | undefined {
  const paths = pathArgs(argv, () => false);
  if (paths.length < 2) {
    return undefined;
  }
  const backups = win32.join(workspaceRoot, ".backups");
  const destination = paths[paths.length - 1] ?? "";
  if (!insideDir(workspaceRoot, backups, destination)) {
    return undefined;
  }
  if (!paths.every((candidate) => insideDir(workspaceRoot, workspaceRoot, candidate))) {
    return undefined;
  }
  return { kind: "copy", files: paths.slice(0, -1).map((source) => win32.basename(source)) };
}

/** True when the candidate (workspace-relative or absolute) lands in root. */
function insideDir(workspaceRoot: string, root: string, candidate: string): boolean {
  const base = win32.resolve(root).toLowerCase();
  const target = win32.resolve(workspaceRoot, candidate).toLowerCase();
  return target === base || target.startsWith(`${base}${win32.sep}`);
}

const STAGE_VERBS: Record<string, string> = {
  "remove-item": "delete",
  del: "delete",
  erase: "delete",
  rm: "delete",
  rmdir: "delete",
  rd: "delete",
  "move-item": "move",
  move: "move",
  mv: "move",
  "rename-item": "rename",
  rename: "rename",
  ren: "rename",
  "copy-item": "copy",
  copy: "copy",
  cp: "copy",
  xcopy: "copy",
  robocopy: "copy",
  "new-item": "create",
  mkdir: "create",
  "set-content": "write",
  "add-content": "write",
  "out-file": "write",
  "tee-object": "write",
};

const INSTALLERS = new Set(["npm", "pip", "pip3", "choco", "winget", "brew", "cargo", "apt", "apt-get"]);

/** First non-flag token after the command word. */
function firstPath(argv: string[]): string | undefined {
  for (const token of argv.slice(1)) {
    if (!token.startsWith("-") && !token.startsWith("/")) {
      return token;
    }
  }
  return undefined;
}

/** The token after > or >>, when the stage redirects output. */
function redirectTarget(argv: string[]): string | undefined {
  for (let index = 1; index < argv.length - 1; index += 1) {
    if (argv[index] === ">" || argv[index] === ">>") {
      return argv[index + 1];
    }
  }
  return undefined;
}

/** "delete todo.txt": plain words for what a risky stage does. */
export function describeStage(argv: string[]): string {
  if (argv.length === 0) {
    return "run something";
  }
  const redirected = redirectTarget(argv);
  if (redirected) {
    return `write ${win32.basename(redirected)}`;
  }
  const name = commandName(argv[0] ?? "");
  const installerVerb = INSTALLERS.has(name) ? (argv[1] ?? "").toLowerCase() : "";
  if (installerVerb === "install" || installerVerb === "add" || installerVerb === "i") {
    const pkg = firstPath(argv.slice(1));
    return pkg ? `install ${pkg}` : "install packages";
  }
  const verb = STAGE_VERBS[name];
  if (verb) {
    const target = firstPath(argv);
    return target ? `${verb} ${win32.basename(target)}` : `${verb} something`;
  }
  const rest = argv[1] === undefined ? "" : ` ${argv[1]}`;
  return `run ${name}${rest}`;
}

/** "Delete todo.txt?": the picker title from the risky stage. */
export function pickerTitle(argv: string[]): string {
  const description = describeStage(argv);
  return `${description.charAt(0).toUpperCase()}${description.slice(1)}?`;
}

/** Short label for a stage: "node --version", "Get-ChildItem". */
export function stageLabel(argv: string[]): string {
  const first = argv[0] ?? "";
  const name = commandName(first);
  if ((name === "git" || name === "node" || name === "npm") && argv[1] !== undefined) {
    return `${win32.basename(first)} ${argv[1]}`;
  }
  return win32.basename(first);
}

export type RememberedDecision = "once" | "always" | "reject";

/** The per-command memory from a picked choice, by scope/decision. */
export function rememberedDecision(choice: {
  scope?: string;
  decision: string;
}): RememberedDecision | undefined {
  if (choice.scope === "localPersistent" || choice.decision === "approvedPolicyAmendment") {
    return "always";
  }
  if (choice.decision === "abort" || choice.decision.startsWith("denied")) {
    return "reject";
  }
  if (choice.decision.startsWith("approved")) {
    return "once";
  }
  return undefined;
}

/** This stage's equivalent of a remembered command decision. */
export function findStageChoice(
  choices: ApprovalChoiceView[],
  want: RememberedDecision,
): string | undefined {
  switch (want) {
    case "always":
      return (
        choices.find((choice) => choice.scope === "localPersistent")?.choiceId ??
        choices.find((choice) => choice.decision === "approvedPolicyAmendment")?.choiceId ??
        findOnceChoice(choices)
      );
    case "once":
      return findOnceChoice(choices);
    case "reject":
      return (
        choices.find((choice) => choice.decision === "abort")?.choiceId ??
        choices.find((choice) => choice.decision.startsWith("denied"))?.choiceId
      );
  }
}

function findOnceChoice(choices: ApprovalChoiceView[]): string | undefined {
  return (
    choices.find((choice) => choice.decision === "approved" && choice.scope === "once")?.choiceId ??
    choices.find((choice) => choice.decision.startsWith("approved"))?.choiceId
  );
}

/** The "No, tell Muse…" row: a denial that takes feedback. */
export function isRejectChoice(choice: { acceptsFeedback?: boolean; decision: string }): boolean {
  return (
    choice.acceptsFeedback === true &&
    (choice.decision === "abort" || choice.decision.startsWith("denied"))
  );
}

/** "✓ Allowed once: delete todo.txt" */
export function allowedOnceRow(description: string): string {
  return `✓ Allowed once: ${description}`;
}

/** "✓ Always allowed here: Remove-Item" */
export function alwaysAllowedRow(prefix: string): string {
  return `✓ Always allowed here: ${prefix}`;
}

/** "✗ Rejected: delete todo.txt[, told Muse: …]" */
export function rejectedRow(description: string, feedback?: string): string {
  const trimmed = feedback?.trim() ?? "";
  return trimmed === ""
    ? `✗ Rejected: ${description}`
    : `✗ Rejected: ${description}, told Muse: ${truncate(trimmed, 100)}`;
}

/** "✓ Looked at: Get-ChildItem, Select-Object" */
export function lookedAtRow(labels: string[]): string {
  return `✓ Looked at: ${labels.join(", ")}`;
}

/** "✓ Backed up todo.txt" */
export function backedUpRow(files: string[]): string {
  return `✓ Backed up ${files.join(", ")}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
