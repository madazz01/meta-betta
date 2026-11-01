// Pure approval helpers: plain-English picker titles, read-only and backup
// auto-allow, per-command choice memory, and the answered rows. No VS Code
// imports.

import { win32 } from "node:path";
import type { StepGroup } from "./items.js";

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

/** Variables, home shortcuts, escapes and wildcards: never auto-allowed. */
const DYNAMIC_TOKEN = /[$%~`*?[]/;

/** Words that write, matched case-insensitively against the full command. */
const WRITE_WORDS = ["out-file", "set-content", "add-content", "tee-object", "--output"];

/** `2>`, `>`, `*>` waiting for a `$null` (the spaced form: `2> $null`). */
const THROWAWAY_PAIRS = new Set(["2>", ">", "*>"]);

/**
 * `2>$null` and friends, spaced or not, any case: output thrown away. Each
 * match must end the command or hit whitespace, `;`, `|`, `)` or `&` — so
 * `>$null.txt` (a real file) and `| Out-Null.ps1` survive.
 */
const THROWAWAY_NULL =
  /2>\s*\$null(?=$|[\s;|)&])|\*>\s*\$null(?=$|[\s;|)&])|>\s*\$null(?=$|[\s;|)&])|2>&1(?=$|[\s;|)&])|\|\s*out-null(?=$|[\s;|)&])/gi;
/** `2>/dev/null`, exactly: stderr thrown away on Mac and Linux. */
const THROWAWAY_DEV_NULL = /2>\/dev\/null(?=$|[\s;|)&])/g;

/**
 * The command without throwaway redirects (`2>$null`, `>$null`, `*>$null`,
 * `2>&1`, `| Out-Null`, `2>/dev/null`, spaced or not). `$null` matches in
 * any case; anything else with `>` or `$` is left for the checks to catch.
 */
export function stripThrowawayCommand(command: string): string {
  return command.replace(THROWAWAY_NULL, "").replace(THROWAWAY_DEV_NULL, "");
}

/** One argv token that throws output away (`$null` in any case). */
function isThrowawayToken(token: string): boolean {
  if (token === "2>/dev/null") {
    return true;
  }
  const lower = token.toLowerCase();
  return lower === "2>$null" || lower === ">$null" || lower === "*>$null" || lower === "2>&1";
}

/** argv without throwaway redirects; lone `$null` and real writes stay. */
export function stripThrowawayArgv(argv: string[]): string[] {
  const clean: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (isThrowawayToken(token)) {
      continue;
    }
    const next = argv[index + 1] ?? "";
    if (
      (token === "|" && next.toLowerCase() === "out-null") ||
      (THROWAWAY_PAIRS.has(token) && next.toLowerCase() === "$null")
    ) {
      index += 1;
      continue;
    }
    clean.push(token);
  }
  return clean;
}

/**
 * A bare `Out-Null` stage: a sink that discards its input, worth no row.
 * Compares the raw word, not commandName: a script file called
 * `Out-Null.ps1` can do anything, so it still asks.
 */
export function isSinkStage(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] ?? "").toLowerCase() === "out-null";
}

/**
 * True when the full command text may write: a `>` anywhere (even quoted —
 * conservative, since Muse strips redirection from stage argv) or an output
 * word. Throwaway redirects (`2>$null`, `| Out-Null`…) don't count. When
 * true, nothing in the command auto-allows.
 */
export function commandHasWrite(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const clean = stripThrowawayCommand(command);
  if (clean.includes(">")) {
    return true;
  }
  const lower = clean.toLowerCase();
  return WRITE_WORDS.some((word) => lower.includes(word));
}

/** Read-only commands that take file paths: every path must stay in the workspace. */
const FILE_READERS = new Set([
  "get-content",
  "cat",
  "type",
  "select-string",
  "get-item",
  "get-childitem",
  "ls",
  "dir",
  "test-path",
]);

/**
 * True when the stage only reads: a read-only command with no output
 * redirection and no dynamic tokens ($vars, ~, wildcards). Pipes and `;`
 * are safe by construction: every stage of a pipeline or list is approved
 * separately, so a sneaky `Get-Content f | Evil` still asks for its Evil
 * stage. File readers additionally keep every path inside the workspace.
 */
export function isReadOnlyStage(argv: string[], workspaceRoot: string): boolean {
  const clean = stripThrowawayArgv(argv);
  if (clean.length === 0) {
    return false;
  }
  for (const token of clean.slice(1)) {
    if (DYNAMIC_TOKEN.test(token)) {
      return false;
    }
  }
  for (const token of clean) {
    if (REDIRECT_TOKENS.has(token.toLowerCase())) {
      return false;
    }
  }
  const name = commandName(clean[0] ?? "");
  const pair = READONLY_PAIRS[name];
  const listed = pair ? pair.includes((clean[1] ?? "").toLowerCase()) : READONLY_SINGLE.has(name);
  if (!listed || !FILE_READERS.has(name)) {
    return listed;
  }
  return clean
    .slice(1)
    .every((token) => token.startsWith("-") || insideDir(workspaceRoot, workspaceRoot, token));
}

export type BackupAction = { kind: "mkdir" } | { kind: "copy"; files: string[] };

/**
 * A rule-9 backup step, or undefined (the picker asks). New-Item needs
 * -ItemType Directory (bare mkdir counts too) with every path inside
 * <workspace>\.backups; Copy-Item needs its destination inside .backups and
 * every path inside the workspace. Dynamic tokens ($vars, ~, wildcards)
 * always refuse. Conservative: anything unrecognized refuses.
 */
export function backupAction(argv: string[], workspaceRoot: string): BackupAction | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  for (const token of argv.slice(1)) {
    if (DYNAMIC_TOKEN.test(token)) {
      return undefined;
    }
  }
  const name = commandName(argv[0] ?? "");
  if (name === "new-item") {
    return backupMkdir(argv, workspaceRoot, true);
  }
  if (name === "mkdir") {
    return backupMkdir(argv, workspaceRoot, false);
  }
  if (name === "copy-item") {
    return backupCopy(argv, workspaceRoot);
  }
  return undefined;
}

/**
 * Non-flag tokens after the command word, minus excused parameter values.
 * A leading `/` is a path (on Windows `/x` means `C:\x`), never a switch:
 * none of this helper's callers take slash switches.
 */
function pathArgs(argv: string[], excused: (token: string) => boolean): string[] {
  return argv.slice(1).filter((token) => {
    if (token.startsWith("-")) {
      return false;
    }
    return !excused(token);
  });
}

function backupMkdir(
  argv: string[],
  workspaceRoot: string,
  requireItemType: boolean,
): BackupAction | undefined {
  if (requireItemType) {
    let directory = false;
    for (let index = 1; index < argv.length; index += 1) {
      const flag = (argv[index] ?? "").toLowerCase();
      if (
        (flag === "-itemtype" || flag === "-type") &&
        (argv[index + 1] ?? "").toLowerCase() === "directory"
      ) {
        directory = true;
      }
    }
    if (!directory) {
      return undefined;
    }
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
export function insideDir(workspaceRoot: string, root: string, candidate: string): boolean {
  const base = win32.resolve(root).toLowerCase();
  const target = win32.resolve(workspaceRoot, candidate).toLowerCase();
  return target === base || target.startsWith(`${base}${win32.sep}`);
}

/** The only tools whose `/x` tokens are switches; everywhere else `/x` is a path. */
const SLASH_SWITCH_COMMANDS = new Set(["robocopy", "xcopy", "cmd"]);

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

/**
 * First non-flag token after the command word. A leading `/` is a path
 * except for slash-switch tools (robocopy, xcopy, cmd), where it starts a
 * switch.
 */
function firstPath(argv: string[], slashSwitches = false): string | undefined {
  for (const token of argv.slice(1)) {
    if (token.startsWith("-") || (slashSwitches && token.startsWith("/"))) {
      continue;
    }
    return token;
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
    const target = firstPath(argv, SLASH_SWITCH_COMMANDS.has(name));
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

export function autoAllowedRow(description: string): string {
  return `✓ auto-allowed: ${description}`;
}

/**
 * Installers, downloaders, package fetchers and slash-switch tools: Auto
 * always asks for these. (`npx` can download; robocopy/xcopy/cmd take `/x`
 * switches, so their tokens can't be read as plain paths.)
 */
const AUTO_ASK_COMMANDS = new Set([
  "irm",
  "iwr",
  "curl",
  "invoke-webrequest",
  "pip",
  "pip3",
  "winget",
  "choco",
  "npx",
  "robocopy",
  "xcopy",
  "cmd",
]);

/** The only `npm` subcommands Auto allows; `run` needs a script name. */
const NPM_AUTO_SUBCOMMANDS = new Set(["test", "run", "run-script", "start", "build", "--version"]);

/** `node` flags that run code from the command line instead of a file. */
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import"]);

/** Verbs that must name at least one explicit path, as the first stage. */
const PATH_VERBS = new Set(["delete", "move", "rename", "copy"]);

/**
 * True when a git stage escapes the local workspace: pushing, cloning,
 * touching remotes or submodules, machine-wide config, or `-c`/`-C`
 * overrides (a `-C` inside the workspace is fine). Exact-token matches, so
 * a commit message only trips it when a whole token equals one of these.
 */
function gitAsksStage(argv: string[], workspaceRoot: string): boolean {
  const rest = argv.slice(1);
  const words = rest.map((token) => token.toLowerCase());
  if (words.includes("push") || words.includes("clone") || words.includes("submodule")) {
    return true;
  }
  if (rest.includes("-c")) {
    return true;
  }
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "-C") {
      const dir = rest[index + 1];
      if (dir === undefined || !insideDir(workspaceRoot, workspaceRoot, dir)) {
        return true;
      }
    }
  }
  if (words.includes("config") && (words.includes("--global") || words.includes("--system"))) {
    return true;
  }
  if (words.includes("remote") && (words.includes("add") || words.includes("set-url"))) {
    return true;
  }
  return false;
}

/**
 * Auto mode: allow this stage without asking? `npm` test/run/start/build,
 * `node` with a script file, local git, and file edits/creates/deletes/
 * moves — but only when every path stays inside the workspace. Still asks
 * for installs and downloads, git escapes, outside paths (a leading `/` is
 * a path, so `/` is the drive root), dynamic tokens, deletes/moves/renames/
 * copies without an explicit path or past the first stage, and anything it
 * can't parse. Throwaway redirects (`2>$null`, `| Out-Null`…) are stripped
 * before every check, and a bare `Out-Null` stage passes as a sink. Pure:
 * the host decides, the webview only shows the row.
 */
export function autoAllowStage(
  argv: string[],
  workspaceRoot: string,
  fullCommand?: string,
  isFirstStage = true,
): boolean {
  if (argv.length === 0 || workspaceRoot === "") {
    return false;
  }
  const clean = stripThrowawayArgv(argv);
  if (isSinkStage(clean)) {
    return true;
  }
  for (const token of clean.slice(1)) {
    if (DYNAMIC_TOKEN.test(token)) {
      return false;
    }
  }
  const name = commandName(clean[0] ?? "");
  if (name === "" || AUTO_ASK_COMMANDS.has(name)) {
    return false;
  }
  if (name === "npm") {
    const sub = (clean[1] ?? "").toLowerCase();
    if (!NPM_AUTO_SUBCOMMANDS.has(sub)) {
      return false;
    }
    if ((sub === "run" || sub === "run-script") && clean[2] === undefined) {
      return false;
    }
  }
  if (name === "node") {
    const script = firstPath(clean);
    if (script === undefined || !insideDir(workspaceRoot, workspaceRoot, script)) {
      return false;
    }
    for (const token of clean.slice(1)) {
      if (NODE_EVAL_FLAGS.has(token)) {
        return false;
      }
    }
  }
  if (name === "git" && gitAsksStage(clean, workspaceRoot)) {
    return false;
  }
  const runnable =
    name === "node" ||
    name === "npm" ||
    name === "git" ||
    Object.prototype.hasOwnProperty.call(STAGE_VERBS, name);
  if (!runnable) {
    return false;
  }
  if (fullCommand !== undefined && commandHasWrite(fullCommand)) {
    const target = redirectTarget(clean);
    if (!target || !insideDir(workspaceRoot, workspaceRoot, target)) {
      return false;
    }
  }
  const paths = pathArgs(clean, () => false);
  if (PATH_VERBS.has(STAGE_VERBS[name] ?? "") && (paths.length === 0 || !isFirstStage)) {
    return false;
  }
  return paths.every((token) => insideDir(workspaceRoot, workspaceRoot, token));
}

/**
 * Reads that never ask in any mode: fileAccess/read with a path inside the
 * workspace. (Read-only shell stages ride the quiet row by their own rule;
 * network, socket, process and unknown tool subjects are never free.)
 */
export function isFreeRead(
  subject: { kind: string; access?: string; path?: string },
  workspaceRoot: string,
): boolean {
  return (
    subject.kind === "fileAccess" &&
    (subject.access ?? "").toLowerCase() === "read" &&
    typeof subject.path === "string" &&
    autoAllowFile(subject.path, workspaceRoot)
  );
}

/** Auto mode: a file change goes through when its path stays inside the workspace. */
export function autoAllowFile(target: string, workspaceRoot: string): boolean {
  if (workspaceRoot === "" || DYNAMIC_TOKEN.test(target)) {
    return false;
  }
  return insideDir(workspaceRoot, workspaceRoot, target);
}

/** "change todo.txt" / "read todo.txt": plain words for an allowed file change. */
export function describeFileAccess(access: string, target: string): string {
  const base = win32.basename(target) || target;
  return access === "read" ? `read ${base}` : `change ${base}`;
}

/** Which step-group bucket an approved stage's row folds into. */
export function stageGroup(argv: string[]): StepGroup {
  const name = commandName(argv[0] ?? "");
  if (name === "node" || name === "npm" || name === "npx" || name === "git") {
    return "command";
  }
  if (Object.prototype.hasOwnProperty.call(STAGE_VERBS, name)) {
    return "edit";
  }
  if (AUTO_ASK_COMMANDS.has(name)) {
    return "command";
  }
  return "other";
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
