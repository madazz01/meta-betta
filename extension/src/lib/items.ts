// Pure transcript helpers: one-line tool rows and collapsed thinking text.
// No VS Code imports.

export interface ToolItemView {
  kind: string;
  tool?: string;
  args?: string;
  displayLabel?: { active: string; done: string; neutral: string };
  status: string;
  failureReason?: string;
  fallbackText?: string;
  commandText?: string;
}

export interface ToolRow {
  text: string;
  done: boolean;
  failed: boolean;
}

/**
 * Plain words for the Muse 1.4.14 bug where shell commands fail under
 * `muse serve` on Windows ("sandbox enforcement unavailable"), while file
 * tools keep working.
 */
export const SANDBOX_BUG_TEXT =
  "Muse can't run commands from Meta Betta yet (a Muse bug on Windows we've reported). It can still read and change files.";

/** True when a tool failure is that sandbox bug, not a real error. */
export function isSandboxBugFailure(failureReason: string | undefined): boolean {
  return !!failureReason && /sandbox enforcement unavailable/i.test(failureReason);
}

/**
 * One short row for a toolCall, userShell, or any other work item.
 * A sandbox-bug failure shows the plain line instead of the raw error, first
 * time only (sandboxNoted); repeats stay a bare "(didn't work)".
 */
export function toolRowText(item: ToolItemView, sandboxNoted = false): ToolRow {
  const failed = item.status === "failed" || item.status === "rejected" || item.status === "timedOut";
  const done = item.status !== "inProgress";
  let text: string;
  if (item.kind === "userShell") {
    text = `▶ ${truncate(item.commandText?.trim() || "shell command", 80)}`;
  } else if (item.kind === "toolCall") {
    text = `${toolIcon(item.tool)} ${toolLabel(item, done && !failed)}`;
  } else {
    const extra = item.fallbackText ? ` — ${truncate(singleLine(item.fallbackText), 100)}` : "";
    text = `Working…${extra}`;
  }
  if (failed) {
    if (isSandboxBugFailure(item.failureReason)) {
      text += sandboxNoted ? " (didn't work)" : ` (didn't work: ${SANDBOX_BUG_TEXT})`;
    } else {
      const why = item.failureReason ? `: ${truncate(singleLine(item.failureReason), 80)}` : "";
      text += ` (didn't work${why})`;
    }
  } else if (done) {
    text += " ✓";
  }
  return { text, done, failed };
}

/** Collapsed thinking text: streamed summary parts, or raw text where exposed. */
export function reasoningText(
  summary: readonly string[] | undefined,
  text: string | undefined,
): string {
  const joined = (summary ?? []).join("");
  return joined || text || "";
}

export interface HistoryItemView {
  kind: string;
  itemId: string;
  text?: string;
  displayText?: string;
  summary?: readonly string[];
  /** RFC3339 stamp of the item's durable record, when the server kept one. */
  recordedAt?: string;
}

export type HistoryEvent =
  | { type: "user"; text: string; at?: number }
  | { type: "assistant"; id: string; text: string; at?: number }
  | { type: "thinking"; id: string; text: string };

/**
 * One transcript event for a resumed history item: user and agent messages
 * plus collapsed thinking. Anything else (tools, internals) is skipped.
 * Messages carry their recorded time, so a resumed chat shows real times.
 */
export function historyEvent(item: HistoryItemView): HistoryEvent | undefined {
  const at = recordedMs(item.recordedAt);
  switch (item.kind) {
    case "userMessage": {
      const text = item.text ?? item.displayText ?? "";
      return text ? { type: "user", text, ...(at === undefined ? {} : { at }) } : undefined;
    }
    case "agentMessage": {
      const text = item.text ?? "";
      return text ? { type: "assistant", id: item.itemId, text, ...(at === undefined ? {} : { at }) } : undefined;
    }
    case "reasoning": {
      const text = reasoningText(item.summary, item.text);
      return text ? { type: "thinking", id: item.itemId, text } : undefined;
    }
    default:
      return undefined;
  }
}

/** A recorded stamp in ms, or undefined when missing or unreadable. */
function recordedMs(recordedAt: string | undefined): number | undefined {
  if (!recordedAt) {
    return undefined;
  }
  const ms = Date.parse(recordedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

function toolLabel(item: ToolItemView, past: boolean): string {
  const label = item.displayLabel;
  if (!label) {
    return friendlyToolText(item.tool, item.args, past);
  }
  if (item.status === "completed") {
    return label.done;
  }
  if (item.status === "inProgress") {
    return label.active;
  }
  return label.neutral;
}

const TOOL_VERBS: { pattern: RegExp; active: string; past: string }[] = [
  { pattern: /(write|create|save)/, active: "Writing", past: "Wrote" },
  { pattern: /(edit|apply|patch)/, active: "Editing", past: "Edited" },
  { pattern: /(delete|remove)/, active: "Deleting", past: "Deleted" },
  { pattern: /(exec|bash|shell|command|run|test|build)/, active: "Running", past: "Ran" },
  { pattern: /(read|cat)/, active: "Reading", past: "Read" },
  { pattern: /(list|glob)/, active: "Listing", past: "Listed" },
  { pattern: /(search|grep|find)/, active: "Searching", past: "Searched" },
];

/**
 * Plain words for a tool call without a server label, e.g. "Wrote hello.txt".
 * Never the raw tool id.
 */
function friendlyToolText(tool: string | undefined, args: string | undefined, past: boolean): string {
  const name = (tool ?? "").toLowerCase();
  const target = argTarget(args);
  for (const verb of TOOL_VERBS) {
    if (verb.pattern.test(name)) {
      const word = past ? verb.past : verb.active;
      return target ? `${word} ${target}` : word;
    }
  }
  const pretty = prettifyTool(tool);
  return target ? `${pretty} ${target}` : pretty;
}

function prettifyTool(tool: string | undefined): string {
  const words = (tool ?? "tool").replace(/[_-]+/g, " ").trim() || "tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function argTarget(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of [
    "path",
    "filePath",
    "file",
    "filename",
    "target",
    "dir",
    "directory",
    "command",
    "cmd",
    "pattern",
    "query",
    "url",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value.trim(), 80);
    }
  }
  return undefined;
}

function toolIcon(tool: string | undefined): string {
  const name = (tool ?? "").toLowerCase();
  if (/(write|edit|create|apply|patch|save)/.test(name)) {
    return "📄";
  }
  if (/(exec|bash|shell|command|run|test|build|npm|cargo)/.test(name)) {
    return "▶";
  }
  if (/(read|list|glob|grep|search|find)/.test(name)) {
    return "🔍";
  }
  return "🔧";
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
